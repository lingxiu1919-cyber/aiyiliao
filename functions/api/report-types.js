import { getUserId } from '../../_shared/auth.js';
import { getReportsByUser } from '../../_shared/db.js';

/**
 * /api/report-types — GET
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const uid = await getUserId(request, env);
  if (!uid) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const reports = await getReportsByUser(env.DB, uid, 999);
    const types = [...new Set(reports.map(r => r.report_type).filter(Boolean))];
    return new Response(JSON.stringify(types), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
