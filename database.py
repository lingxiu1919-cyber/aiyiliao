"""SQLite database for lab report records — multi-user support."""
import sqlite3, json, os, hashlib, secrets
from datetime import datetime

DB = os.path.join(os.path.dirname(__file__), "reports.db")

def conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c

def init_db():
    c = conn()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 1,
            report_type TEXT, report_date TEXT, hospital_name TEXT, notes TEXT,
            image_path TEXT, raw_extracted TEXT, summary TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS lab_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_id INTEGER NOT NULL,
            item_name TEXT NOT NULL, value TEXT, unit TEXT,
            reference_range TEXT, flag TEXT, category TEXT,
            FOREIGN KEY (report_id) REFERENCES reports(id)
        );
        CREATE TABLE IF NOT EXISTS ai_analyses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_id INTEGER NOT NULL UNIQUE,
            summary TEXT, recommendations TEXT, next_checkup TEXT, trends_analysis TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (report_id) REFERENCES reports(id)
        );
    """)
    c.commit(); c.close()

# ── Auth helpers ──────────────────────────────────────────────────────

def _hash_pw(pw: str, salt: str = "") -> str:
    if not salt:
        salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + pw).encode()).hexdigest()
    return f"{salt}:{h}"

def _check_pw(pw: str, stored: str) -> bool:
    salt, h = stored.split(":", 1)
    return hashlib.sha256((salt + pw).encode()).hexdigest() == h

def create_user(username: str, password: str) -> dict:
    c = conn()
    try:
        pw_hash = _hash_pw(password)
        c.execute("INSERT INTO users (username, password_hash) VALUES (?,?)", (username, pw_hash))
        c.commit()
        uid = c.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()["id"]
        c.close()
        return {"id": uid, "username": username}
    except sqlite3.IntegrityError:
        c.close()
        return None

def authenticate_user(username: str, password: str) -> dict | None:
    c = conn()
    row = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    c.close()
    if row and _check_pw(password, row["password_hash"]):
        return {"id": row["id"], "username": row["username"], "display_name": row["display_name"]}
    return None

# ── Reports (user-scoped) ────────────────────────────────────────────

def save_report(user_id, report_type, report_date, hospital_name, image_path,
                lab_items, raw_extracted, summary, ai_analysis):
    c = conn(); cur = c.cursor()
    cur.execute("INSERT INTO reports (user_id,report_type,report_date,hospital_name,image_path,raw_extracted,summary) VALUES (?,?,?,?,?,?,?)",
                (user_id, report_type, report_date, hospital_name, image_path,
                 json.dumps(raw_extracted, ensure_ascii=False), summary))
    rid = cur.lastrowid
    for it in lab_items:
        cur.execute("INSERT INTO lab_items (report_id,item_name,value,unit,reference_range,flag,category) VALUES (?,?,?,?,?,?,?)",
                    (rid, it.get("name",""), it.get("value",""), it.get("unit",""),
                     it.get("reference_range",""), it.get("flag",""), it.get("category","")))
    if ai_analysis:
        cur.execute("INSERT INTO ai_analyses (report_id,summary,recommendations,next_checkup,trends_analysis) VALUES (?,?,?,?,?)",
                    (rid, ai_analysis.get("summary",""), ai_analysis.get("recommendations",""),
                     ai_analysis.get("next_checkup",""), ai_analysis.get("trends_analysis","")))
    c.commit(); c.close(); return rid

def get_reports(user_id, limit=50):
    c = conn()
    r = [dict(x) for x in c.execute(
        "SELECT * FROM reports WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
        (user_id, limit)).fetchall()]
    c.close(); return r

def get_report(rid, user_id=None):
    c = conn()
    if user_id:
        r = c.execute("SELECT * FROM reports WHERE id=? AND user_id=?", (rid, user_id)).fetchone()
    else:
        r = c.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
    if not r: c.close(); return None
    r = dict(r)
    r["items"] = [dict(i) for i in c.execute("SELECT * FROM lab_items WHERE report_id=?", (rid,)).fetchall()]
    row = c.execute("SELECT * FROM ai_analyses WHERE report_id=?", (rid,)).fetchone()
    r["analysis"] = dict(row) if row else {}
    if r.get("raw_extracted"):
        try: r["raw_extracted"] = json.loads(r["raw_extracted"])
        except: pass
    c.close(); return r

def get_reports_by_type(report_type, user_id=None):
    c = conn()
    if user_id:
        r = [dict(x) for x in c.execute("SELECT * FROM reports WHERE report_type=? AND user_id=? ORDER BY report_date ASC",
                                         (report_type, user_id)).fetchall()]
    else:
        r = [dict(x) for x in c.execute("SELECT * FROM reports WHERE report_type=? ORDER BY report_date ASC",
                                         (report_type,)).fetchall()]
    c.close(); return r

def get_all_report_types(user_id):
    c = conn()
    r = [x["report_type"] for x in c.execute(
        "SELECT DISTINCT report_type FROM reports WHERE user_id=? AND report_type IS NOT NULL AND report_type!='' ORDER BY report_type",
        (user_id,)).fetchall()]
    c.close(); return r

def delete_report(rid, user_id=None):
    c = conn()
    if user_id:
        c.execute("DELETE FROM ai_analyses WHERE report_id=? AND report_id IN (SELECT id FROM reports WHERE user_id=?)", (rid, user_id))
        c.execute("DELETE FROM lab_items WHERE report_id=? AND report_id IN (SELECT id FROM reports WHERE user_id=?)", (rid, user_id))
        c.execute("DELETE FROM reports WHERE id=? AND user_id=?", (rid, user_id))
    else:
        c.execute("DELETE FROM ai_analyses WHERE report_id=?", (rid,))
        c.execute("DELETE FROM lab_items WHERE report_id=?", (rid,))
        c.execute("DELETE FROM reports WHERE id=?", (rid,))
    c.commit(); c.close()

def get_trend_data(report_type, item_name, user_id=None):
    c = conn()
    if user_id:
        r = [dict(x) for x in c.execute(
            "SELECT r.report_date,li.value,li.unit,li.reference_range,li.flag,li.id "
            "FROM lab_items li JOIN reports r ON li.report_id=r.id "
            "WHERE r.report_type=? AND li.item_name=? AND r.user_id=? ORDER BY r.report_date ASC",
            (report_type, item_name, user_id)).fetchall()]
    else:
        r = [dict(x) for x in c.execute(
            "SELECT r.report_date,li.value,li.unit,li.reference_range,li.flag,li.id "
            "FROM lab_items li JOIN reports r ON li.report_id=r.id "
            "WHERE r.report_type=? AND li.item_name=? ORDER BY r.report_date ASC",
            (report_type, item_name)).fetchall()]
    c.close(); return r

init_db()
