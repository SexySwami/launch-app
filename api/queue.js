// Vercel Edge function — cloud-backed mission queue.
// Stores the queue as a JSON-stringified array under a single Redis key.
// Backed by Upstash Redis. Works with either the Vercel Marketplace
// integration env vars (KV_REST_API_URL/TOKEN) or raw Upstash vars
// (UPSTASH_REDIS_REST_URL/TOKEN).

export const config = { runtime: 'edge' };

const KEY = 'launch:queue';

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function readQueue() {
  const { url, token } = creds();
  const res = await fetch(`${url}/get/${encodeURIComponent(KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Read failed (${res.status})`);
  const data = await res.json();
  if (!data?.result) return [];
  try {
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed)
      ? parsed.filter(i => i && typeof i.id === 'string' && typeof i.text === 'string')
      : [];
  } catch {
    return [];
  }
}

async function writeQueue(items) {
  const { url, token } = creds();
  const res = await fetch(`${url}/set/${encodeURIComponent(KEY)}`, {
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

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `m_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default async function handler(request) {
  const { url, token } = creds();
  if (!url || !token) {
    return json({
      error:
        'Cloud queue not configured. Install the Upstash Redis integration on Vercel (Storage → Marketplace) and connect it to this project, then redeploy.',
    }, 500);
  }

  try {
    if (request.method === 'GET') {
      const items = await readQueue();
      return json({ items }, 200);
    }

    if (request.method === 'POST') {
      const u = new URL(request.url);
      const append = u.searchParams.get('append') === '1';

      const body = await request.json().catch(() => ({}));

      // Accept either { text: "..." } (single) or { texts: ["...", "..."] } (batch)
      let texts = [];
      if (Array.isArray(body?.texts)) {
        texts = body.texts
          .filter(t => typeof t === 'string')
          .map(t => t.trim())
          .filter(t => t);
      } else if (body?.text) {
        const t = body.text.toString().trim();
        if (t) texts = [t];
      }

      if (texts.length === 0) return json({ error: 'Missing text or texts' }, 400);
      if (texts.some(t => t.length > 500)) {
        return json({ error: 'A task is too long (500 char max each)' }, 400);
      }

      const items = await readQueue();
      const added = texts.map(t => ({
        id: newId(),
        text: t,
        createdAt: Date.now(),
      }));
      const updated = append ? [...items, ...added] : [...added, ...items];
      await writeQueue(updated);
      return json({ items: updated, added }, 200);
    }

    if (request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const incoming = Array.isArray(body?.items) ? body.items : null;
      if (!incoming) return json({ error: 'Missing items array' }, 400);

      // Entries are either flat items {id, text, createdAt} OR folders
      // {id, type:'folder', name, children:[items], createdAt}. Folders can
      // contain only flat items (no nested folders, at least for now).
      const cleanLeaf = (i) => {
        if (!i || typeof i.id !== 'string' || typeof i.text !== 'string') return null;
        return {
          id: i.id,
          text: i.text.toString().slice(0, 500),
          createdAt: Number.isFinite(i.createdAt) ? i.createdAt : Date.now(),
        };
      };
      const cleanEntry = (i) => {
        if (!i || typeof i.id !== 'string') return null;
        if (i.type === 'folder') {
          return {
            id: i.id,
            type: 'folder',
            name: typeof i.name === 'string' ? i.name.toString().slice(0, 200) : '',
            createdAt: Number.isFinite(i.createdAt) ? i.createdAt : Date.now(),
            children: Array.isArray(i.children)
              ? i.children.map(cleanLeaf).filter(Boolean)
              : [],
          };
        }
        return cleanLeaf(i);
      };
      const cleaned = incoming.map(cleanEntry).filter(Boolean);

      await writeQueue(cleaned);
      return json({ items: cleaned }, 200);
    }

    if (request.method === 'DELETE') {
      const u = new URL(request.url);
      const id = u.searchParams.get('id');
      if (!id) return json({ error: 'Missing id query param' }, 400);

      const items = await readQueue();
      const updated = items.filter(item => item.id !== id);
      await writeQueue(updated);
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
