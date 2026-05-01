/**
 * auth.js — JWT authentication for Cloudflare Workers
 *
 * Uses Web Crypto API (crypto.subtle) with no third-party dependencies.
 * Tokens use HS256 (HMAC with SHA-256) signing.
 */

// ─── Base64URL helpers ───────────────────────────────────────────────────────

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  // Restore padding
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

function base64UrlDecodeToString(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

// ─── HMAC key import ─────────────────────────────────────────────────────────

/**
 * Import a secret string as an HMAC-SHA256 key for crypto.subtle.
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
async function importHmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// ─── Token generation ────────────────────────────────────────────────────────

/**
 * Generate a JWT token with HS256 signing.
 *
 * The payload must include at least `id` and `username`.
 * Expiration is automatically set to 7 days from now.
 *
 * @param {string} secret — the HMAC signing secret
 * @param {object} payload — claims object (should include id, username)
 * @returns {Promise<string>} signed JWT string (header.payload.signature)
 */
export async function generateToken(secret, payload) {
  const header = { alg: 'HS256', typ: 'JWT' };

  const now = Math.floor(Date.now() / 1000);
  const tokenPayload = {
    ...payload,
    iat: now,
    exp: now + 7 * 24 * 3600 // 7 days
  };

  const enc = new TextEncoder();
  const headerEncoded = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadEncoded = base64UrlEncode(enc.encode(JSON.stringify(tokenPayload)));

  // Sign the header.payload part
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(`${headerEncoded}.${payloadEncoded}`)
  );

  const signatureEncoded = base64UrlEncode(signature);

  return `${headerEncoded}.${payloadEncoded}.${signatureEncoded}`;
}

// ─── Token verification ──────────────────────────────────────────────────────

/**
 * Verify a JWT token and return its payload.
 *
 * Checks:
 * - Three-part structure
 * - Valid HMAC signature
 * - Not expired (exp claim)
 *
 * @param {string} secret — the HMAC signing secret
 * @param {string} token — JWT string (header.payload.signature)
 * @returns {Promise<object|null>} decoded payload or null if invalid/expired
 */
export async function verifyToken(secret, token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerEncoded, payloadEncoded, signatureEncoded] = parts;

  // Verify signature
  try {
    const key = await importHmacKey(secret);
    const enc = new TextEncoder();
    const signature = base64UrlDecode(signatureEncoded);

    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      enc.encode(`${headerEncoded}.${payloadEncoded}`)
    );

    if (!isValid) return null;
  } catch {
    return null;
  }

  // Decode and parse payload
  try {
    const payloadJson = base64UrlDecodeToString(payloadEncoded);
    const payload = JSON.parse(payloadJson);

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

// ─── Password hashing ────────────────────────────────────────────────────────

/**
 * Hash a password using SHA-256.
 *
 * Note: For production use, consider a key derivation function like PBKDF2
 * with a salt. This is a simple hash suitable for demo/prototype purposes.
 *
 * @param {string} password
 * @returns {Promise<string>} hex-encoded SHA-256 digest
 */
export async function hashPassword(password) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(password));

  // Convert ArrayBuffer to hex string
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ─── Request helpers ─────────────────────────────────────────────────────────

/**
 * Extract user ID from the JWT token in the request Cookie.
 *
 * Looks for a cookie named 'token' containing the JWT.
 *
 * @param {Request} request
 * @param {object} env — environment bindings, expects env.JWT_SECRET
 * @returns {Promise<number|null>} userId or null if not authenticated
 */
export async function getUserId(request, env) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  // Parse cookies: split by ';' and find 'token=...'
  const cookies = cookieHeader.split(';').map(c => c.trim());
  let token = null;
  for (const cookie of cookies) {
    if (cookie.startsWith('token=')) {
      token = cookie.slice(6);
      break;
    }
  }

  if (!token) return null;

  const payload = await verifyToken(env.JWT_SECRET, token);
  if (!payload || !payload.id) return null;

  return payload.id;
}

/**
 * Require an authenticated user. Returns the userId if valid,
 * or a 401 Response if not authenticated.
 *
 * @param {Request} request
 * @param {object} env — environment bindings, expects env.JWT_SECRET
 * @returns {Promise<number|Response>} userId or 401 Response
 */
export async function requireUser(request, env) {
  const userId = await getUserId(request, env);
  if (!userId) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized', message: '请先登录' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
  return userId;
}
