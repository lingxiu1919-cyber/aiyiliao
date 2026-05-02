import { hashPassword, generateToken } from '../../_shared/auth.js';
import { getUserByUsername, createUser } from '../../_shared/db.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { username, password } = await request.json();
    if (!username || username.trim().length < 2) {
      return new Response(JSON.stringify({ error: '用户名至少2个字符' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!password || password.length < 4) {
      return new Response(JSON.stringify({ error: '密码至少4个字符' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const existing = await getUserByUsername(env.DB, username.trim());
    if (existing) {
      return new Response(JSON.stringify({ error: '用户名已存在' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser(env.DB, username.trim(), passwordHash);
    if (!user) {
      return new Response(JSON.stringify({ error: '注册失败' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    const secret = env.JWT_SECRET || 'aiyiliao-default-jwt-secret-2026';
    const token = await generateToken(secret, { id: user.id, username: user.username });

    return new Response(JSON.stringify({ ok: true, username: user.username }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `token=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`,
      },
    });
  } catch (e) {
    console.error('Register error:', e);
    return new Response(JSON.stringify({ error: '注册失败' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
