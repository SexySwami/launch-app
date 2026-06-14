// Vercel Edge function — cloud-backed mission queue.
// Stores the queue as a JSON-stringified array under a single Redis key.
// Backed by Upstash Redis. Works with either the Vercel Marketplace
// integration env vars (KV_REST_API_URL/TOKEN) or raw Upstash vars
// (UPSTASH_REDIS_REST_URL/TOKEN).



import { getUserId } from './_auth.js';

// Global (pre-auth) key prefix — used only for one-time migration of the
// original owner's data into the new per-user namespace on first sign-in.
const LEGACY_KEY = 'launch:queue';

// Redis key that records which user ID claimed the legacy (pre-auth) data.
// Only that user gets legacy migration; everyone else starts fresh.
const CLAIM_FLAG = 'launch:legacy:claimed';

// Resolve the per-user Redis key for a given folder.
function keyFor(folder, uid) {
  return `launch:${uid}:queue:${folder || 'work'}`;
}

// Legacy global key (pre-auth) for migration reads.
function legacyKeyFor(folder) {
  if (!folder || folder === 'work') return `${LEGACY_KEY}:work`;
  return `${LEGACY_KEY}:${folder}`;
}

function folderParam(request) {
  const u = new URL(request.url);
  // Sanitize to lowercase alphanumeric + hyphens, max 64 chars.
  const f = (u.searchParams.get('folder') || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
  if (!f) return 'work';
  return f;
}

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

function isLeaf(i) {
  return i && typeof i.id === 'string' && typeof i.text === 'string';
}

function isFolder(i) {
  return i && typeof i.id === 'string' && i.type === 'folder';
}

async function readKeyRaw(key) {
  const { url, token } = creds();
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Read failed (${res.status})`);
  const data = await res.json();
  if (!data?.result) return null;
  try {
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed.filter(i => isLeaf(i) || isFolder(i)) : [];
  } catch {
    return [];
  }
}

// Read / write a plain string Redis value (used for the claim flag, not JSON).
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

async function writeKeyRaw(key, items) {
  const { url, token } = creds();
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body: JSON.stringify(items),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Write failed (${res.status}): ${body}`);
  }
}

// Read a folder's queue for a specific user. On first access (null result),
// migrates legacy global data — but only if this uid already owns the legacy
// data (claim flag matches) or nobody has claimed it yet (first sign-in).
async function readQueue(folder, uid) {
  const key = keyFor(folder, uid);
  const items = await readKeyRaw(key);
  if (items !== null) return items;

  // Check whether this user is allowed to claim legacy data.
  const claimedBy = await readString(CLAIM_FLAG);
  if (claimedBy !== null && claimedBy !== uid) {
    // Another user already claimed the legacy data — this is a new user.
    return [];
  }

  // One-time migration: copy legacy global data into this user's namespace.
  const legacyKey = legacyKeyFor(folder);
  const legacy = await readKeyRaw(legacyKey);
  if (legacy && legacy.length > 0) {
    await writeKeyRaw(key, legacy);
    if (!claimedBy) await writeString(CLAIM_FLAG, uid);
    return legacy;
  }
  return [];
}

async function writeQueue(folder, uid, items) {
  await writeKeyRaw(keyFor(folder, uid), items);
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `m_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default async function handler(request) {
  const { url, token } = creds();
  if (!url || !token) {
    return json({ error: 'Cloud queue not configured.' }, 500);
  }

  const uid = await getUserId(request);
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  const folder = folderParam(request);

  try {
    if (request.method === 'GET') {
      const items = await readQueue(folder, uid);
      return json({ items }, 200);
    }

    if (request.method === 'POST') {
      const u = new URL(request.url);
      const append = u.searchParams.get('append') === '1';

      const body = await request.json().catch(() => ({}));

      let texts = [];
      if (Array.isArray(body?.texts)) {
        texts = body.texts.filter(t => typeof t === 'string').map(t => t.trim()).filter(t => t);
      } else if (body?.text) {
        const t = body.text.toString().trim();
        if (t) texts = [t];
      }

      if (texts.length === 0) return json({ error: 'Missing text or texts' }, 400);
      if (texts.some(t => t.length > 500)) return json({ error: 'A task is too long (500 char max each)' }, 400);

      const items = await readQueue(folder, uid);
      const added = texts.map(t => ({ id: newId(), text: t, createdAt: Date.now() }));
      const updated = append ? [...items, ...added] : [...added, ...items];
      await writeQueue(folder, uid, updated);
      return json({ items: updated, added }, 200);
    }

    if (request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const incoming = Array.isArray(body?.items) ? body.items : null;
      if (!incoming) return json({ error: 'Missing items array' }, 400);

      const cleanLeaf = (i) => {
        if (!i || typeof i.id !== 'string' || typeof i.text !== 'string') return null;
        const leaf = { id: i.id, text: i.text.toString().slice(0, 500), createdAt: Number.isFinite(i.createdAt) ? i.createdAt : Date.now() };
        if (typeof i.description === 'string' && i.description) leaf.description = i.description.slice(0, 2000);
        if (i.sourceItemId) leaf.sourceItemId = i.sourceItemId;
        if (i.sourceFolderId) leaf.sourceFolderId = i.sourceFolderId;
        return leaf;
      };
      const cleanEntry = (i) => {
        if (!i || typeof i.id !== 'string') return null;
        if (i.type === 'folder') {
          return {
            id: i.id, type: 'folder',
            name: typeof i.name === 'string' ? i.name.toString().slice(0, 200) : '',
            createdAt: Number.isFinite(i.createdAt) ? i.createdAt : Date.now(),
            expanded: Boolean(i.expanded),
            children: Array.isArray(i.children) ? i.children.map(cleanLeaf).filter(Boolean) : [],
          };
        }
        return cleanLeaf(i);
      };
      const cleaned = incoming.map(cleanEntry).filter(Boolean);

      await writeQueue(folder, uid, cleaned);
      return json({ items: cleaned }, 200);
    }

    if (request.method === 'DELETE') {
      const u = new URL(request.url);
      const id = u.searchParams.get('id');
      if (!id) return json({ error: 'Missing id query param' }, 400);

      const items = await readQueue(folder, uid);
      const updated = items.filter(item => item.id !== id);
      await writeQueue(folder, uid, updated);
      return json({ items: updated }, 200);
    }

    return json({ error: 'Method not allowed' }, 405);
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
