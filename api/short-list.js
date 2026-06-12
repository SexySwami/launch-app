// POST /api/short-list — add an item to the Short List by reference.
// The Short List queue itself (GET/PUT/DELETE) is served by /api/queue?folder=short-list.
// This endpoint exists only for the "add" action, which needs to cross-check the
// source folder and store the reference alongside the item text.

export const config = { runtime: 'edge' };

const SHORT_LIST_KEY = 'launch:queue:short-list';

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function readKey(key) {
  const { url, token } = creds();
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Read failed (${res.status})`);
  const data = await res.json();
  if (!data?.result) return [];
  try {
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeKey(key, items) {
  const { url, token } = creds();
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(items),
  });
  if (!res.ok) throw new Error(`Write failed (${res.status})`);
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `sl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default async function handler(request) {
  const { url, token } = creds();
  if (!url || !token) return json({ error: 'Cloud queue not configured' }, 500);

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const { itemId, sourceFolderId, text } = body;

    if (!itemId || typeof itemId !== 'string') return json({ error: 'Missing itemId' }, 400);
    if (!sourceFolderId || typeof sourceFolderId !== 'string') return json({ error: 'Missing sourceFolderId' }, 400);
    const t = (text || '').toString().trim();
    if (!t) return json({ error: 'Missing text' }, 400);

    const items = await readKey(SHORT_LIST_KEY);
    if (items.some(i => i.sourceItemId === itemId)) {
      return json({ error: 'Already in Short List', alreadyIn: true }, 409);
    }

    const entry = {
      id: newId(),
      text: t.slice(0, 500),
      sourceItemId: itemId,
      sourceFolderId,
      createdAt: Date.now(),
    };
    await writeKey(SHORT_LIST_KEY, [...items, entry]);
    return json({ entry }, 200);
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
