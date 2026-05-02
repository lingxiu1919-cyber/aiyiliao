import { getUserId } from '../_shared/auth.js';
import { getReportsByUser, getReportById, saveReport } from '../_shared/db.js';
import { ocrWithVision, structureWithDeepSeek, analyzeWithDeepSeek, compareWithDeepSeek } from '../_shared/ai.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { image_base64, filename, ext } = await request.json();
    if (!image_base64) {
      return new Response(JSON.stringify({ error: '请提供图片数据' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Determine MIME type
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' };
    const mimeType = mimeMap[ext?.toLowerCase()] || 'image/jpeg';

    // ── Step 1: OCR with ZhiPu vision ──
    const ocrText = await ocrWithVision(image_base64, mimeType, env);
    if (!ocrText) {
      return new Response(JSON.stringify({ error: '模型返回空内容，请确认图片清晰且为化验单' }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Step 2: Structure with DeepSeek ──
    const extraction = await structureWithDeepSeek(ocrText, env);
    if (!extraction || !Array.isArray(extraction.items) || extraction.items.length === 0) {
      return new Response(JSON.stringify({ error: '未识别出化验项目', raw: ocrText }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Normalize items
    extraction.items = extraction.items.map(it => ({
      name: it.name || '',
      value: it.value || '',
      unit: it.unit || '',
      reference_range: it.reference_range || '',
      flag: it.flag || '',
      category: it.category || '',
    }));

    // ── Analysis with DeepSeek ──
    const uid = await getUserId(request, env);
    let prevData = [];
    if (uid && extraction.report_type) {
      const prevReports = await getReportsByUser(env.DB, uid, 50);
      prevData = [];
      for (const p of prevReports) {
        if (p.report_type === extraction.report_type) {
          const full = await getReportById(env.DB, p.id, uid);
          if (full) prevData.push({ id: full.id, report_date: full.report_date, items: full.items });
        }
      }
    }

    const analysis = await analyzeWithDeepSeek(extraction, prevData.length > 0 ? prevData : null, env) || {};

    // ── Trend comparison ──
    let trend = null;
    if (extraction.report_type && prevData.length >= 1) {
      const allData = [...prevData, { report_date: extraction.report_date, items: extraction.items }];
      trend = await compareWithDeepSeek(extraction.report_type, allData, env);
    }

    // ── Save to DB (if logged in) ──
    let reportId = null;
    if (uid) {
      const aiAnalysis = {
        summary: analysis.summary || '',
        recommendations: analysis.recommendations || '',
        next_checkup: analysis.next_checkup || '',
      };
      reportId = await saveReport(
        env.DB, uid,
        extraction.report_type || '',
        extraction.report_date || '',
        extraction.hospital_name || '',
        image_base64,
        extraction,
        extraction.summary || '',
        extraction.items,
        aiAnalysis,
      );
    }

    return new Response(JSON.stringify({
      report_id: reportId,
      extraction,
      analysis,
      trend,
      has_history: prevData.length > 0,
      history_count: prevData.length,
      saved: reportId !== null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Analyze error:', e);
    return new Response(JSON.stringify({ error: 'AI 接口调用失败: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
