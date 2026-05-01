"""
Lab Report Analyzer — Multi-user version with account system.
"""
import os, sys, uuid, json
if sys.platform == "win32" and os.environ.get("PYTHONIOENCODING") is None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

from functools import wraps
from flask import Flask, request, jsonify, render_template, send_from_directory, session, redirect, url_for
from flask_cors import CORS
from database import (save_report, get_reports, get_report, get_reports_by_type,
                      get_all_report_types, delete_report, get_trend_data,
                      create_user, authenticate_user)
from ai_service import extract_from_image, analyze_report, compare_reports

app = Flask(__name__)
app.secret_key = os.urandom(24)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024
CORS(app)
BASE = os.path.dirname(__file__)
UPLOAD_FOLDER = os.path.join(BASE, "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

ALLOWED = {"png", "jpg", "jpeg", "gif", "bmp", "webp", "pdf"}

def allowed_file(fn):
    return "." in fn and fn.rsplit(".", 1)[1].lower() in ALLOWED

# ── Auth decorator ────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            if request.is_json or request.path.startswith("/api/"):
                return jsonify({"error": "请先登录"}), 401
            return redirect(url_for("index"))
        return f(*args, **kwargs)
    return wrapper

def current_user_id():
    return session.get("user_id")

# ── Auth routes ───────────────────────────────────────────────────────

@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    if not username or len(username) < 2:
        return jsonify({"error": "用户名至少2个字符"}), 400
    if not password or len(password) < 4:
        return jsonify({"error": "密码至少4个字符"}), 400
    user = create_user(username, password)
    if not user:
        return jsonify({"error": "用户名已存在"}), 400
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    return jsonify({"ok": True, "username": user["username"]})

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    user = authenticate_user(username, password)
    if not user:
        return jsonify({"error": "用户名或密码错误"}), 401
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    return jsonify({"ok": True, "username": user["username"]})

@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})

@app.route("/api/me")
def api_me():
    if "user_id" in session:
        return jsonify({"logged_in": True, "username": session.get("username", "")})
    return jsonify({"logged_in": False})

# ── Pages ─────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

# ── API (all require login) ──────────────────────────────────────────

@app.route("/api/reports")
@login_required
def list_reports():
    return jsonify(get_reports(current_user_id(), 50))

@app.route("/api/reports/<int:rid>")
@login_required
def get_report_detail(rid):
    r = get_report(rid, current_user_id())
    return (jsonify(r) if r else (jsonify({"error": "不存在"}), 404))

@app.route("/api/reports/<int:rid>", methods=["DELETE"])
@login_required
def remove_report(rid):
    r = get_report(rid, current_user_id())
    if not r:
        return jsonify({"error": "不存在"}), 404
    delete_report(rid, current_user_id())
    return jsonify({"ok": True})

@app.route("/api/report-types")
@login_required
def report_types():
    return jsonify(get_all_report_types(current_user_id()))

@app.route("/api/trend/<rtype>/<item>")
@login_required
def trend_data(rtype, item):
    return jsonify(get_trend_data(rtype, item, current_user_id()))

@app.route("/api/compare", methods=["POST"])
@login_required
def compare():
    data = request.get_json() or {}
    rtype = data.get("report_type", "")
    if not rtype:
        return jsonify({"error": "需要 report_type"}), 400
    reports = get_reports_by_type(rtype, current_user_id())
    rd = []
    for r in reports:
        full = get_report(r["id"], current_user_id())
        if full:
            rd.append({"report_date": full.get("report_date", ""), "items": full.get("items", []), "id": full["id"]})
    if len(rd) < 2:
        return jsonify({"error": "至少需要2份同类型报告"}), 400
    res = compare_reports(rtype, rd)
    return jsonify(res or {"error": "对比失败"})

@app.route("/api/analyze", methods=["POST"])
def analyze():
    if "file" not in request.files:
        return jsonify({"error": "请选择图片"}), 400
    file = request.files["file"]
    if not file.filename or not allowed_file(file.filename):
        return jsonify({"error": "不支持的文件格式"}), 400
    ext = file.filename.rsplit(".", 1)[1].lower()
    fn = f"{uuid.uuid4().hex}.{ext}"
    fp = os.path.join(UPLOAD_FOLDER, fn)
    file.save(fp)

    uid = current_user_id()  # None for guests
    extraction = extract_from_image(fp)
    # 分析完毕后立即删除原图，只保留表单数据
    if os.path.exists(fp):
        os.remove(fp)
    if "error" in extraction:
        return jsonify({"error": extraction["error"], "raw": extraction.get("raw")}), 422

    rtype = extraction.get("report_type", "")
    prev = []
    if rtype and uid:
        prev = get_reports_by_type(rtype, uid)
    prev_data = []
    for p in prev:
        full = get_report(p["id"], uid)
        if full:
            prev_data.append({"id": p["id"], "report_date": p.get("report_date", ""), "items": full.get("items", [])})

    analysis = analyze_report(extraction, prev_data if prev_data else None)

    trend = None
    if rtype and len(prev) >= 1:
        all_r = prev_data + [{"report_date": extraction.get("report_date", ""), "items": extraction.get("items", [])}]
        trend = compare_reports(rtype, all_r)

    summary = analysis.get("summary", "") if isinstance(analysis, dict) else str(analysis)
    ai_analysis = {
        "summary": analysis.get("summary", "") if isinstance(analysis, dict) else "",
        "recommendations": analysis.get("recommendations", "") if isinstance(analysis, dict) else "",
        "next_checkup": analysis.get("next_checkup", "") if isinstance(analysis, dict) else "",
        "trends_analysis": json.dumps(trend, ensure_ascii=False) if trend else "",
    }

    # 保存到数据库（仅登录用户）
    rid = None
    if uid:
        rid = save_report(uid, rtype, extraction.get("report_date", ""), extraction.get("hospital_name", ""),
                          fn, extraction.get("items", []), extraction, summary, ai_analysis)

    return jsonify({"report_id": rid, "extraction": extraction, "analysis": analysis,
                    "trend": trend, "has_history": len(prev) > 0, "history_count": len(prev),
                    "saved": rid is not None})

@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

if __name__ == "__main__":
    print("=" * 50)
    print("  慧检 — 医疗化验单智能分析系统")
    print(f"  URL: http://localhost:5001")
    print("=" * 50)
    app.run(host="127.0.0.1", port=5001, debug=False)
