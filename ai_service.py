"""AI service — ZhiPu GLM-4V vision for extraction + DeepSeek text analysis."""
import os, base64, json, re
from pathlib import Path
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# Vision client (ZhiPu GLM-4V-Flash — free, supports images)
VISION_CLIENT = OpenAI(
    api_key=os.getenv("ZHIPU_API_KEY"),
    base_url=os.getenv("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
)
VISION_MODEL = os.getenv("ZHIPU_VISION_MODEL", "glm-4v-flash")

# Text client (DeepSeek — for analysis & comparison)
TEXT_CLIENT = OpenAI(
    api_key=os.getenv("DEEPSEEK_API_KEY"),
    base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
)
TEXT_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# ── helpers ──────────────────────────────────────────────────────────────

def _img_b64(path: str) -> str:
    """Read image and return base64 data URI."""
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    ext = Path(path).suffix.lower().lstrip(".")
    if ext in ("jpg", "jpeg"):
        ext = "jpeg"
    return f"data:image/{ext};base64,{b64}"


def _parse_json(text: str) -> dict:
    """Extract JSON from LLM response (handles ```json fences, stray text, and prefix/suffix)."""
    if not text:
        return {"error": "empty response", "raw": ""}
    # Try ```json ... ``` first
    m = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
    if m:
        raw = m.group(1).strip()
    else:
        raw = text.strip()
    # Find first { and last }
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1:
        return {"error": "no JSON found", "raw": text[:2000]}
    raw = raw[start:end+1]
    # Clean control chars
    raw = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw)
    # Fix trailing commas
    raw = re.sub(r',\s*([}\]])', r'\1', raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"error": "JSON parse error", "raw": text[:2000]}


# ── extract_from_image ───────────────────────────────────────────────────

# Step 1: Pure OCR prompt (GLM-4V — just read text, don't format JSON)
OCR_PROMPT = """你是一个专业的化验单文字识别助手。请仔细阅读这张化验单图片，**逐字逐行完整地**提取所有文字内容。

要求：
1. 每个项目必须包含：项目名称、测定值、单位、参考范围
2. 注意数字和单位的完整性，不要拆分数字（如+2 1.0g/L请不要拆成+2、1、0g/L）
3. 注意参考范围的完整性（如5.5-7.5和0-0.4都应完整提取）
4. 保留所有特殊符号（*、+、-、±等）
5. 保持原始排版，不要随意合并或拆分表格行

直接输出你看到的文字，不要加额外的说明，不要输出JSON。"""

# Step 2: Structuring prompt (DeepSeek — parse OCR text into JSON)
# Note: {{ and }} are escaped for .format() compatibility
STRUCTURE_PROMPT = """你是一个医疗化验单数据解析助手。请将以下OCR提取的化验单文字内容解析为严格的JSON格式。

要求JSON结构：
{{
  "report_type": "化验单类型（如"血常规"、"肝功能"、"尿常规"、"生化全套"等）",
  "report_date": "化验日期（格式 YYYY-MM-DD，如果文字中有日期）",
  "hospital_name": "医院名称（如果有）",
  "patient_name": "患者姓名（如果有）",
  "items": [
    {{
      "name": "项目名称",
      "value": "检测值（数字或文本）",
      "unit": "单位（如 10^9/L, g/L, mmol/L 等，没有则空字符串）",
      "reference_range": "参考范围（如 3.5-5.5，没有则空字符串）",
      "flag": "异常标记（H=偏高, L=偏低，没有则空字符串）",
      "category": "分类（如"血液学"，不能确定则空字符串）"
    }}
  ],
  "summary": "对这份化验单的简要中文总结（包括整体情况、重要异常项目等，约80-100字）"
}}

注意事项：
1. 根据OCR内容判断化验单类型：如果出现"血常规"或"WBC""RBC""HGB""PLT"等血项则type为"血常规"；如果出现"尿分析""尿常规""干化学""LEU""BLD""KET""PRO"等尿项则type为"尿常规"；如果出现"肝功能""ALT""AST""TBIL"则type为"肝功能"；以此类推
2. 所有项目按顺序列出，确保每个项目包含name、value、unit、reference_range、flag字段
3. 参考范围原样提取
4. flag：如果项目前有*或↑↓标记，或值明显偏离参考范围，设为"H"（偏高）或"L"（偏低）
5. 确保JSON严格合法，不要多出注释、尾部逗号
6. 只返回JSON，不要任何额外文字

----- OCR提取的文字内容开始 -----
{ocr_text}
----- OCR提取的文字内容结束 -----"""


def extract_from_image(image_path: str) -> dict:
    """Two-step extraction: 1) GLM-4V OCR to text, 2) DeepSeek parse to JSON."""
    try:
        # Read image
        with open(image_path, "rb") as f:
            image_data = f.read()
        b64_data = base64.b64encode(image_data).decode()
        ext = Path(image_path).suffix.lower().lstrip(".")
        mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"

        # ── Step 1: OCR with vision model ──
        for attempt in range(3):
            resp = VISION_CLIENT.chat.completions.create(
                model=VISION_MODEL,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": OCR_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64_data}"}}
                    ]
                }],
                max_tokens=2000,
            )
            ocr_text = (resp.choices[0].message.content or "").strip()
            if ocr_text:
                break
            if attempt < 2:
                continue
            return {"error": "模型返回空内容，请确认图片清晰且为化验单", "raw": ""}

        # ── Step 2: Parse to JSON with DeepSeek ──
        for attempt in range(3):
            resp2 = TEXT_CLIENT.chat.completions.create(
                model=TEXT_MODEL,
                messages=[{"role": "user", "content": STRUCTURE_PROMPT.format(ocr_text=ocr_text)}],
                max_tokens=4000,
                temperature=0.1,
            )
            text = resp2.choices[0].message.content or ""
            parsed = _parse_json(text)
            if "error" not in parsed:
                break
            if attempt < 2:
                continue
            return {"error": "AI解析失败: JSON格式错误", "raw": ocr_text}

        # Validate items
        if not isinstance(parsed.get("items"), list) or len(parsed["items"]) == 0:
            return {"error": "未识别出化验项目", "raw": ocr_text}
        for it in parsed["items"]:
            it.setdefault("name", "")
            it.setdefault("value", "")
            it.setdefault("unit", "")
            it.setdefault("reference_range", "")
            it.setdefault("flag", "")
            it.setdefault("category", "")
        return parsed
    except Exception as e:
        return {"error": f"AI 接口调用失败: {str(e)}"}


# ── analyze_report ───────────────────────────────────────────────────────

ANALYZE_PROMPT = """你是一位资深医疗顾问。请分析以下化验单数据，给出易懂的建议。

化验单类型：{report_type}
化验日期：{report_date}
医院：{hospital_name}

项目列表：
{items_text}

{history_section}

请以严格合法的 JSON 格式返回：
{{
  "summary": "对本次化验结果的中文总结（约100字）",
  "recommendations": "具体的中文建议（包括饮食、生活方式、就医建议等，约150字）",
  "next_checkup": "建议下次复检的时间或条件（如\"建议3个月后复查\"、\"请尽快就医复查\"等）"
}}

只返回JSON，不要有多余文字。
"""


def analyze_report(extraction: dict, prev_data: list | None = None) -> dict:
    """Analyze lab report data with AI."""
    try:
        items = extraction.get("items", [])
        lines = []
        for i, it in enumerate(items, 1):
            flag = {"H": " ↑", "L": " ↓", "": ""}.get(it.get("flag", ""), "")
            ref = f"（参考范围: {it['reference_range']}）" if it.get("reference_range") else ""
            lines.append(f"{i}. {it.get('name','?')}: {it.get('value','?')} {it.get('unit','')}{flag} {ref}")

        items_text = "\n".join(lines)

        history_section = ""
        if prev_data:
            history_section = "\n\n历史数据（同类型化验单）：\n"
            for p in prev_data:
                history_section += f"\n--- {p.get('report_date','?')} ---\n"
                for it in p.get("items", []):
                    flag = {"H": " ↑", "L": " ↓", "": ""}.get(it.get("flag", ""), "")
                    history_section += f"  {it.get('name','?')}: {it.get('value','?')} {it.get('unit','')}{flag}\n"

        prompt = ANALYZE_PROMPT.format(
            report_type=extraction.get("report_type", "未知"),
            report_date=extraction.get("report_date", "未知"),
            hospital_name=extraction.get("hospital_name", "未知"),
            items_text=items_text,
            history_section=history_section,
        )

        resp = TEXT_CLIENT.chat.completions.create(
            model=TEXT_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=4096,
            temperature=0.3,
        )
        text = resp.choices[0].message.content or ""
        parsed = _parse_json(text)
        parsed.setdefault("summary", "")
        parsed.setdefault("recommendations", "")
        parsed.setdefault("next_checkup", "")
        return parsed
    except Exception as e:
        return {"summary": f"AI 分析失败: {str(e)}", "recommendations": "", "next_checkup": ""}


# ── compare_reports ──────────────────────────────────────────────────────

COMPARE_PROMPT = """你是一位医疗数据分析专家。请对比以下 {report_type} 的多次化验结果，分析变化趋势。

报告数据（按时间先后）：
{reports_text}

请以严格合法的 JSON 格式返回：
{{
  "trend_items": [
    {{
      "name": "项目名称",
      "unit": "单位",
      "changes": [
        {{"date": "日期", "value": "值", "flag": "异常标记"}}
      ],
      "trend": "趋势描述（如\"持续升高\"、\"波动但正常\"、\"逐渐恢复\"等）",
      "attention": "需要关注的提示（如有异常趋势）"
    }}
  ],
  "overall_assessment": "整体趋势评估中文描述（约100字）",
  "suggestion": "基于趋势的中文建议（约100字）"
}}

只返回JSON，不要有多余文字。
"""


def compare_reports(report_type: str, reports_data: list) -> dict:
    """Compare multiple reports of same type for trend analysis."""
    try:
        lines = []
        for r in reports_data:
            date = r.get("report_date", "?")
            lines.append(f"\n[{date}]")
            for it in r.get("items", []):
                flag = {"H": " ↑", "L": " ↓", "": ""}.get(it.get("flag", ""), "")
                ref = f"（参考: {it['reference_range']}）" if it.get("reference_range") else ""
                lines.append(f"  {it.get('name','?')}: {it.get('value','?')} {it.get('unit','')}{flag} {ref}")

        prompt = COMPARE_PROMPT.format(
            report_type=report_type or "化验单",
            reports_text="\n".join(lines),
        )

        resp = TEXT_CLIENT.chat.completions.create(
            model=TEXT_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=4096,
            temperature=0.3,
        )
        text = resp.choices[0].message.content or ""
        parsed = _parse_json(text)
        return parsed
    except Exception as e:
        return {"error": f"趋势对比失败: {str(e)}"}
