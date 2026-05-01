export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
    },
  });
}
