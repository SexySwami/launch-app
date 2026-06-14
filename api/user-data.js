// DELETE /api/user-data
// Deletes ALL Redis keys belonging to the authenticated user
// (everything under launch:{uid}:*).
// The claim flag (launch:legacy:claimed) is global and intentionally
// left untouched so the original owner's migration status is preserved.



import { getUserId } from './_auth.js';

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

// Scan for all keys matching a pattern, following the cursor until done.
async function scanAll(pattern) {
  const { url, token } = creds();
  const keys = [];
  let cursor = '0';
  do {
    const res = await fetch(
      `${url}/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=100`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
    );
    if (!res.ok) throw new Error(`SCAN failed (${res.status})`);
    const data = await res.json();
    // result is [nextCursor, [key, key, ...]]
    const [nextCursor, batch] = data.result || ['0', []];
    cursor = nextCursor;
    if (Array.isArray(batch)) keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

// Delete a list of keys using the Upstash pipeline endpoint.
async function deleteKeys(keys) {
  if (!keys.length) return;
  const { url, token } = creds();
  const commands = keys.map(k => ['DEL', k]);
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Pipeline DEL failed (${res.status})`);
}

export default async function handler(request) {
  const { url, token } = creds();
  if (!url || !token) return json({ error: 'Cloud store not configured.' }, 500);

  const uid = await getUserId(request);
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405);

  try {
    const pattern = `launch:${uid}:*`;
    const keys = await scanAll(pattern);
    await deleteKeys(keys);
    return json({ deleted: keys.length }, 200);
  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
