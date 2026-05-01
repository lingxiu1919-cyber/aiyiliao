import { getUserId, requireUser } from '../../_shared/auth.js';
import {
  getReportsByUser, getReportById, deleteReport,
  getTrendData,
} from '../../_shared/db.js';
import { compareWithDeepSeek } from '../../_shared/ai.js';

/**
 * /api/reports
 * GET  → list reports for current user
 * POST → compare reports (JSON body: { report_type })
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // ── Compare (POST /api/reports) ──
  if (request.method === 'POST') {
    const uid = await getUserId(request, env);
    if (!uid) {
      return new Response(JSON.stringify({ error: '请先登录' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const data = await request.json();
      const rtype = data.report_type;
      if (!rtype) {
        return new Response(JSON.stringify({ error: '需要 report_type' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }

      const rd = await getTrendData(env.DB, rtype, uid);
      if (rd.length < 2) {
        return new Response(JSON.stringify({ error: '至少需要2份同类型报告' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }

      const result = await compareWithDeepSeek(rtype, rd, env);
      return new Response(JSON.stringify(result || { error: '对比失败' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error('Compare error:', e);
      return new Response(JSON.stringify({ error: '对比失败' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // ── List (GET /api/reports) ──
  if (request.method === 'GET') {
    const uid = await getUserId(request, env);
    if (!uid) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const reports = await getReportsByUser(env.DB, uid, 50);
      return new Response(JSON.stringify(reports), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error('List reports error:', e);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response('Method not allowed', { status: 405 });
}
