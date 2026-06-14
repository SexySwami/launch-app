// Lightweight Clerk JWT verification — no external dependencies.
// Uses Web Crypto API (available in Node.js 18+ and Edge runtimes).
// Fetches Clerk's public JWKS once per cold-start and caches for 1 hour.

// Derived from the publishable key: smashing-snake-29.clerk.accounts.dev
const JWKS_URL = 'https://smashing-snake-29.clerk.accounts.dev/.well-known/jwks.json';

let _cachedKeys = null;
let _cacheTime  = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getPublicKeys() {
  const now = Date.now();
  if (_cachedKeys && now - _cacheTime < CACHE_TTL) return _cachedKeys;
  const res = await fetch(JWKS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const { keys } = await res.json();
  const cryptoKeys = await Promise.all(
    keys.map(k =>
      crypto.subtle.importKey(
        'jwk', k,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['verify']
      )
    )
  );
  _cachedKeys = cryptoKeys;
  _cacheTime  = now;
  return cryptoKeys;
}

function b64urlToBuffer(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export async function getUserId(request) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

    // Reject expired tokens.
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    // Verify RS256 signature against Clerk's public keys.
    const keys    = await getPublicKeys();
    const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig     = b64urlToBuffer(sigB64);

    for (const key of keys) {
      const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, message);
      if (valid) return payload.sub || null;
    }
    return null;
  } catch {
    return null;
  }
}
