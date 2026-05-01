/**
 * AI API calls — ZhiPu GLM-4V vision (OCR) + DeepSeek text (structuring + analysis)
 *
 * Note: ZhiPu vision models reject "temperature" parameter (error 1210). Omit it.
 */

// ── helpers ────────────────────────────────────────────────────────────

function base64UrlSafe(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Call ZhiPu GLM-4V for OCR — pure text extraction (no JSON).
 * Returns OCR text string, or null on failure.
 */
export async function ocrWithVision(imageBase64, mimeType, env) {
  const apiKey = env.ZHIPU_API_KEY;
  const baseUrl = env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const model = env.ZHIPU_VISION_MODEL || 'glm-4.6v-flashx';

  const prompt = `你是一个专业的化验单文字识别助手。请仔细阅读这张化验单图片，逐字逐行完整地提取所有文字内容。

要求：
1. 每个项目必须包含：项目名称、测定值、单位、参考范围
2. 注意数字和单位的完整性，不要拆分数字（如+2 1.0g/L请不要拆成+2、1、0g/L）
3. 注意参考范围的完整性（如5.5-7.5和0-0.4都应完整提取）
4. 保留所有特殊符号（*、+、-、±等）
5. 保持原始排版，不要随意合并或拆分表格行

直接输出你看到的文字，不要加额外的说明，不要输出JSON。`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            ],
          }],
          max_tokens: 2000,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`ZhiPu OCR attempt ${attempt + 1} failed: ${resp.status} ${errText}`);
        if (attempt < 2) continue;
        return null;
      }

      const data = await resp.json();
      const text = (data.choices?.[0]?.message?.content || '').trim();
      if (text) return text;
    } catch (e) {
      console.error(`ZhiPu OCR attempt ${attempt + 1} error:`, e);
      if (attempt < 2) continue;
    }
  }
  return null;
}

/**
 * Call DeepSeek to parse OCR text into structured JSON (report info + items).
 * Returns parsed object, or null on failure.
 */
export async function structureWithDeepSeek(ocrText, env) {
  const apiKey = env.DEEPSEEK_API_KEY;
  const baseUrl = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';

  const prompt = `你是一个医疗化验单数据解析助手。请将以下OCR提取的化验单文字内容解析为严格的JSON格式。

要求JSON结构：
{
  "report_type": "化验单类型（如"血常规"、"肝功能"、"尿常规"、"生化全套"等）",
  "report_date": "化验日期（格式 YYYY-MM-DD，如果文字中有日期）",
  "hospital_name": "医院名称（如果有）",
  "patient_name": "患者姓名（如果有）",
  "items": [
    {
      "name": "项目名称",
      "value": "检测值（数字或文本）",
      "unit": "单位（如 10^9/L, g/L, mmol/L 等，没有则空字符串）",
      "reference_range": "参考范围（如 3.5-5.5，没有则空字符串）",
      "flag": "异常标记（H=偏高, L=偏低，没有则空字符串）",
      "category": "分类（如"血液学"，不能确定则空字符串）"
    }
  ],
  "summary": "对这份化验单的简要中文总结（包括整体情况、重要异常项目等，约80-100字）"
}

注意事项：
1. 根据OCR内容判断化验单类型：如果出现"血常规"或"WBC""RBC""HGB""PLT"等血项则type为"血常规"；如果出现"尿分析""尿常规""干化学""LEU""BLD""KET""PRO"等尿项则type为"尿常规"；如果出现"肝功能""ALT""AST""TBIL"则type为"肝功能"；以此类推
2. 所有项目按顺序列出，确保每个项目包含name、value、unit、reference_range、flag字段
3. 参考范围原样提取
4. flag：如果项目前有*或↑↓标记，或值明显偏离参考范围，设为"H"（偏高）或"L"（偏低）
5. 确保JSON严格合法，不要多出注释、尾部逗号
6. 只返回JSON，不要任何额外文字

----- OCR提取的文字内容开始 -----
${ocrText}
----- OCR提取的文字内容结束 -----`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4000,
          temperature: 0.1,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`DeepSeek structure attempt ${attempt + 1} failed: ${resp.status} ${errText}`);
        if (attempt < 2) continue;
        return null;
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || '';
      if (!text.trim()) {
        if (attempt < 2) continue;
        return null;
      }

      // Parse JSON from response (handle ```json fences)
      const parsed = parseJsonFromText(text);
      if (parsed && Array.isArray(parsed.items)) {
        // Normalize items
        return parsed;
      }
    } catch (e) {
      console.error(`DeepSeek structure attempt ${attempt + 1} error:`, e);
      if (attempt < 2) continue;
    }
  }
  return null;
}

/**
 * Call DeepSeek for analysis (summary + recommendations).
 */
export async function analyzeWithDeepSeek(extraction, prevData, env) {
  const apiKey = env.DEEPSEEK_API_KEY;
  const baseUrl = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';

  const items = extraction.items || [];
  const lines = items.map((it, i) => {
    const flag = { H: ' ↑', L: ' ↓', '': '' }[it.flag || ''] || '';
    const ref = it.reference_range ? `（参考范围: ${it.reference_range}）` : '';
    return `${i + 1}. ${it.name}: ${it.value} ${it.unit || ''}${flag} ${ref}`;
  });

  let historySection = '';
  if (prevData && prevData.length > 0) {
    historySection = '\n\n历史数据（同类型化验单）：\n' +
      prevData.map(p => {
        const date = p.report_date || '?';
        const pitems = (p.items || []).map(it => {
          const flag = { H: ' ↑', L: ' ↓', '': '' }[it.flag || ''] || '';
          return `  ${it.name}: ${it.value} ${it.unit || ''}${flag}`;
        }).join('\n');
        return `\n--- ${date} ---\n${pitems}`;
      }).join('\n');
  }

  const prompt = `你是一位资深医疗顾问。请分析以下化验单数据，给出易懂的建议。

化验单类型：${extraction.report_type || '未知'}
化验日期：${extraction.report_date || '未知'}
医院：${extraction.hospital_name || '未知'}

项目列表：
${lines.join('\n')}
${historySection}

请以严格合法的 JSON 格式返回：
{
  "summary": "对本次化验结果的中文总结（约100字）",
  "recommendations": "具体的中文建议（包括饮食、生活方式、就医建议等，约150字）",
  "next_checkup": "建议下次复检的时间或条件（如"建议3个月后复查"、"请尽快就医复查"等）"
}

只返回JSON，不要有多余文字。`;

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const parsed = parseJsonFromText(text);
    return parsed || { summary: '', recommendations: '', next_checkup: '' };
  } catch (e) {
    console.error('DeepSeek analysis error:', e);
    return { summary: '', recommendations: '', next_checkup: '' };
  }
}

/**
 * Call DeepSeek for trend comparison.
 */
export async function compareWithDeepSeek(reportType, reportsData, env) {
  const apiKey = env.DEEPSEEK_API_KEY;
  const baseUrl = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';

  const lines = reportsData.map(r => {
    const date = r.report_date || '?';
    const itemLines = (r.items || []).map(it => {
      const flag = { H: ' ↑', L: ' ↓', '': '' }[it.flag || ''] || '';
      const ref = it.reference_range ? `（参考: ${it.reference_range}）` : '';
      return `  ${it.name}: ${it.value} ${it.unit || ''}${flag} ${ref}`;
    });
    return `\n[${date}]\n${itemLines.join('\n')}`;
  });

  const prompt = `你是一位医疗数据分析专家。请对比以下 ${reportType || '化验单'} 的多次化验结果，分析变化趋势。

报告数据（按时间先后）：
${lines.join('\n')}

请以严格合法的 JSON 格式返回：
{
  "trend_items": [
    {
      "name": "项目名称",
      "unit": "单位",
      "changes": [
        {"date": "日期", "value": "值", "flag": "异常标记"}
      ],
      "trend": "趋势描述（如"持续升高"、"波动但正常"、"逐渐恢复"等）",
      "attention": "需要关注的提示（如有异常趋势）"
    }
  ],
  "overall_assessment": "整体趋势评估中文描述（约100字）",
  "suggestion": "基于趋势的中文建议（约100字）"
}

只返回JSON，不要有多余文字。`;

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    return parseJsonFromText(data.choices?.[0]?.message?.content || '') || null;
  } catch (e) {
    console.error('DeepSeek compare error:', e);
    return null;
  }
}

// ── JSON parser (handles ```json fences) ──

function parseJsonFromText(text) {
  if (!text) return null;
  let raw = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenceMatch) raw = fenceMatch[1].trim();

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  raw = raw.slice(start, end + 1);

  // Fix trailing commas
  raw = raw.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
