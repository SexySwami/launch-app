// Vercel Edge function — completed-missions store.
//
// Storage: one Redis key (launch:completed) holding a JSON array of entries:
//   {
//     id: string,                  // unique completion id (client-generated)
//     sourceItemId: string|null,   // original queue item id, for restore
//     sourceItemIndex: number|null,// original queue position, for restore
//     text: string,                // mission name shown to the user
//     microSteps: [{ tag, title, hint, completedAt }],
//     createdAt: number,
//     completedAt: number|null,    // null = in-progress, number = finalized
//   }
//
// Endpoints:
//   GET  /api/completed                   → finalized entries, newest first
//   POST /api/completed?action=log-step   → append a micro-step (creates entry on first call)
//   POST /api/completed?action=finalize   → set completedAt
//   POST /api/completed?action=restore    → atomic remove-from-completed + insert-to-queue
//   DELETE /api/completed?id=…            → remove from completed only

export const config = { runtime: 'edge' };

const COMPLETED_KEY = 'launch:completed';
const QUEUE_LEGACY_KEY = 'launch:queue';
const VALID_FOLDERS = new Set(['work', 'personal', 'health', 'dailies']);

function normalizeFolder(f) {
  const v = (f || '').toString().toLowerCase();
  if (!v || !VALID_FOLDERS.has(v)) return 'work';
  return v;
}

function queueKeyFor(folder) {
  const f = normalizeFolder(folder);
  // Mirror queue.js: Work uses both `launch:queue:work` and the legacy
  // `launch:queue` key (the legacy mirror is updated below on write).
  return `${QUEUE_LEGACY_KEY}:${f}`;
}

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
  } catch {
    return [];
  }
}

async function writeKey(key, value) {
  const { url, token } = creds();
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Write failed (${res.status}): ${body}`);
  }
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function publicShape(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    sourceItemId: entry.sourceItemId || null,
    sourceItemIndex: typeof entry.sourceItemIndex === 'number' ? entry.sourceItemIndex : null,
    folderId: normalizeFolder(entry.folderId),
    text: entry.text || '',
    description: typeof entry.description === 'string' ? entry.description : null,
    microSteps: Array.isArray(entry.microSteps) ? entry.microSteps : [],
    createdAt: entry.createdAt || 0,
    completedAt: entry.completedAt || null,
  };
}

function finalizedSorted(all) {
  return all
    .filter(e => e && e.completedAt)
    .map(publicShape)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
}

export default async function handler(request) {
  const { url, token } = creds();
  if (!url || !token) {
    return json({
      error: 'Cloud store not configured. Install Upstash Redis on this Vercel project and redeploy.',
    }, 500);
  }

  const u = new URL(request.url);

  try {
    if (request.method === 'GET') {
      const all = await readKey(COMPLETED_KEY);
      return json({ items: finalizedSorted(all) }, 200);
    }

    if (request.method === 'POST') {
      const action = u.searchParams.get('action') || '';
      const body = await request.json().catch(() => ({}));

      if (action === 'log-step' || action === 'finalize') {
        const id = (body?.id || '').toString();
        if (!id) return json({ error: 'Missing id' }, 400);

        const all = await readKey(COMPLETED_KEY);
        let entry = all.find(e => e.id === id);
        if (!entry) {
          entry = {
            id,
            sourceItemId: body?.sourceItemId || null,
            sourceItemIndex: typeof body?.sourceItemIndex === 'number' ? body.sourceItemIndex : null,
            folderId: normalizeFolder(body?.folderId),
            text: (body?.text || '').toString().slice(0, 500),
            description: typeof body?.description === 'string' ? body.description.slice(0, 2000) : null,
            microSteps: [],
            createdAt: Date.now(),
            completedAt: null,
          };
          all.push(entry);
        } else {
          // Refresh metadata when we receive a richer payload
          if (body?.text) entry.text = body.text.toString().slice(0, 500);
          if (body?.sourceItemId) entry.sourceItemId = body.sourceItemId;
          if (typeof body?.sourceItemIndex === 'number') entry.sourceItemIndex = body.sourceItemIndex;
          if (body?.folderId) entry.folderId = normalizeFolder(body.folderId);
          if (body?.description !== undefined) entry.description = typeof body.description === 'string' ? body.description.slice(0, 2000) : null;
        }

        if (action === 'log-step') {
          const ms = body?.microStep || {};
          entry.microSteps = Array.isArray(entry.microSteps) ? entry.microSteps : [];
          entry.microSteps.push({
            tag: (ms.tag || '').toString().slice(0, 8),
            title: (ms.title || '').toString().slice(0, 500),
            hint: (ms.hint || '').toString().slice(0, 500),
            completedAt: Date.now(),
          });
        } else {
          entry.completedAt = Date.now();
        }

        await writeKey(COMPLETED_KEY, all);
        return json({ entry: publicShape(entry) }, 200);
      }

      if (action === 'restore') {
        const id = (body?.id || '').toString();
        if (!id) return json({ error: 'Missing id' }, 400);

        const completed = await readKey(COMPLETED_KEY);
        const entry = completed.find(e => e.id === id);
        const updatedCompleted = completed.filter(e => e.id !== id);

        const targetFolder = normalizeFolder(entry?.folderId);
        const queueKey = queueKeyFor(targetFolder);
        let updatedQueue = await readKey(queueKey);
        if (entry) {
          const newItem = {
            id: newId(),
            text: entry.text || '',
            createdAt: Date.now(),
            ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}),
          };
          const insertAt = Math.max(0, Math.min(
            typeof entry.sourceItemIndex === 'number' ? entry.sourceItemIndex : updatedQueue.length,
            updatedQueue.length
          ));
          updatedQueue = [
            ...updatedQueue.slice(0, insertAt),
            newItem,
            ...updatedQueue.slice(insertAt),
          ];
          await writeKey(queueKey, updatedQueue);
          // Mirror Work writes to the legacy key so any legacy reader stays in sync.
          if (targetFolder === 'work') {
            try { await writeKey(QUEUE_LEGACY_KEY, updatedQueue); } catch {}
          }
        }

        await writeKey(COMPLETED_KEY, updatedCompleted);
        return json({
          restored: entry ? publicShape(entry) : null,
          items: finalizedSorted(updatedCompleted),
          queueItems: updatedQueue,
          folderId: targetFolder,
        }, 200);
      }

      return json({ error: 'Unknown action' }, 400);
    }

    if (request.method === 'DELETE') {
      const id = u.searchParams.get('id');
      if (!id) return json({ error: 'Missing id' }, 400);
      const all = await readKey(COMPLETED_KEY);
      const updated = all.filter(e => e.id !== id);
      await writeKey(COMPLETED_KEY, updated);
      return json({ items: finalizedSorted(updated) }, 200);
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
