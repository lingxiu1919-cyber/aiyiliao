import { getUserId } from '../../_shared/auth.js';

/**
 * GET /api/trend/:rtype/:item
 * Returns trend data for a specific item across reports of the same type.
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const uid = await getUserId(request, env);
  if (!uid) {
    return new Response(JSON.stringify({ error: '请先登录' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const rtype = decodeURIComponent(parts[parts.length - 2] || '');
  const item = decodeURIComponent(parts[parts.length - 1] || '');

  if (!rtype || !item) {
    return new Response(JSON.stringify([]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Query reports of this type for this user
    const db = env.DB;
    const { results: reports } = await db.prepare(
      `SELECT r.id, r.report_date, li.item_name, li.value, li.flag
       FROM reports r
       JOIN lab_items li ON li.report_id = r.id
       WHERE r.user_id = ? AND r.report_type = ? AND li.item_name = ?
       ORDER BY r.report_date ASC`
    ).bind(uid, rtype, item).all();

    return new Response(JSON.stringify(reports || []), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Trend error:', e);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
