import { getUserId } from '../../../_shared/auth.js';
import { getTrendData } from '../../../_shared/db.js';
import { compareWithDeepSeek } from '../../../_shared/ai.js';

/**
 * /api/reports/compare — POST { report_type }
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

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
