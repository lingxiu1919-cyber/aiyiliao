import { verifyToken } from '../../_shared/auth.js';

export async function onRequest(context) {
  const { request, env } = context;

  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/token=([^;]+)/);
  if (!match) {
    return new Response(JSON.stringify({ logged_in: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const secret = env.JWT_SECRET || 'aiyiliao-default-jwt-secret-2026';
  const payload = await verifyToken(secret, match[1]);
  if (!payload) {
    return new Response(JSON.stringify({ logged_in: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ logged_in: true, username: payload.username }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
