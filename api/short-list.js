// POST /api/short-list — add an item to the Short List by reference.
// The Short List queue itself (GET/PUT/DELETE) is served by /api/queue?folder=short-list.
// This endpoint exists only for the "add" action, which needs to cross-check the
// source folder and store the reference alongside the item text.



import { getUserId } from './_auth.js';

const shortListKey = (uid) => `launch:${uid}:queue:short-list`;
// Legacy key for one-time migration.
const SHORT_LIST_KEY = 'launch:queue:short-list';
const CLAIM_FLAG     = 'launch:legacy:claimed';

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

async function readNullable(key) {
  const { url, token } = creds();
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Read failed (${res.status})`);
  const data = await res.json();
  if (data?.result == null) return null;
  try {
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function readString(key) {
  const { url, token } = creds();
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.result ?? null;
}

async function writeString(key, value) {
  const { url, token } = creds();
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: String(value),
  });
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `sl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default async function handler(request) {
  const { url, token } = creds();
  if (!url || !token) return json({ error: 'Cloud queue not configured' }, 500);

  const uid = await getUserId(request);
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SL_KEY = shortListKey(uid);

  try {
    const body = await request.json().catch(() => ({}));
    const { itemId, sourceFolderId, text } = body;

    if (!itemId || typeof itemId !== 'string') return json({ error: 'Missing itemId' }, 400);
    if (!sourceFolderId || typeof sourceFolderId !== 'string') return json({ error: 'Missing sourceFolderId' }, 400);
    const t = (text || '').toString().trim();
    if (!t) return json({ error: 'Missing text' }, 400);

    let items = await readNullable(SL_KEY);
    if (items === null) {
      // Key absent — only migrate if this uid owns the legacy data.
      const claimedBy = await readString(CLAIM_FLAG);
      if (!claimedBy || claimedBy === uid) {
        const legacy = await readKey(SHORT_LIST_KEY);
        if (legacy.length) {
          await writeKey(SL_KEY, legacy);
          if (!claimedBy) await writeString(CLAIM_FLAG, uid);
        }
        items = legacy;
      } else {
        items = []; // New user — clean slate.
      }
    }

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
    await writeKey(SL_KEY, [...items, entry]);
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
