import { getUserId } from '../../_shared/auth.js';
import { getReportById, deleteReport } from '../../_shared/db.js';

/**
 * /api/reports/:id
 * GET  → report detail
 * DELETE → delete report
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const rid = parseInt(parts[parts.length - 1], 10);
  if (isNaN(rid)) {
    return new Response(JSON.stringify({ error: '无效ID' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const uid = await getUserId(request, env);
  if (!uid) {
    return new Response(JSON.stringify({ error: '请先登录' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    if (request.method === 'GET') {
      const report = await getReportById(env.DB, rid, uid);
      if (!report) {
        return new Response(JSON.stringify({ error: '不存在' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(report), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'DELETE') {
      const deleted = await deleteReport(env.DB, rid, uid);
      if (!deleted) {
        return new Response(JSON.stringify({ error: '不存在' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Method not allowed', { status: 405 });
  } catch (e) {
    console.error('Report detail error:', e);
    return new Response(JSON.stringify({ error: '操作失败' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
