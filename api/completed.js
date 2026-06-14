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

import { getUserId } from './_auth.js';

// Per-user key helpers.
const completedKey  = (uid) => `launch:${uid}:completed`;
const queueBase     = (uid) => `launch:${uid}:queue`;

// Legacy global keys for one-time migration on first sign-in.
const COMPLETED_KEY      = 'launch:completed';
const QUEUE_LEGACY_KEY   = 'launch:queue';
// Claim flag: whichever uid migrated first owns the legacy data.
const CLAIM_FLAG         = 'launch:legacy:claimed';
const VALID_FOLDERS = new Set(['work', 'personal', 'health', 'dailies', 'short-list']);

function normalizeFolder(f) {
  const v = (f || '').toString().toLowerCase();
  if (!v || !VALID_FOLDERS.has(v)) return 'work';
  return v;
}

function queueKeyFor(folder, uid) {
  return `${queueBase(uid)}:${normalizeFolder(folder)}`;
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

// Like readKey but returns null when the key is absent (vs [] when it's empty).
// Used to distinguish "user has no data yet" from "user has an empty list".
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
    return json({ error: 'Cloud store not configured.' }, 500);
  }

  const uid = await getUserId(request);
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  const CKEY = completedKey(uid);

  const u = new URL(request.url);

  try {
    if (request.method === 'GET') {
      let all = await readNullable(CKEY);
      if (all === null) {
        // Key absent — attempt migration only if this uid owns the legacy data.
        const claimedBy = await readString(CLAIM_FLAG);
        if (!claimedBy || claimedBy === uid) {
          const legacy = await readKey(COMPLETED_KEY);
          if (legacy.length) {
            await writeKey(CKEY, legacy);
            if (!claimedBy) await writeString(CLAIM_FLAG, uid);
            all = legacy;
          } else {
            all = [];
          }
        } else {
          all = []; // New user — clean slate.
        }
      }
      return json({ items: finalizedSorted(all) }, 200);
    }

    if (request.method === 'POST') {
      const action = u.searchParams.get('action') || '';
      const body = await request.json().catch(() => ({}));

      if (action === 'log-step' || action === 'finalize') {
        const id = (body?.id || '').toString();
        if (!id) return json({ error: 'Missing id' }, 400);

        const all = await readKey(CKEY);
        let entry = all.find(e => e.id === id);
        if (!entry) {
          entry = {
            id,
            sourceItemId: body?.sourceItemId || null,
            sourceItemIndex: typeof body?.sourceItemIndex === 'number' ? body.sourceItemIndex : null,
            folderId: normalizeFolder(body?.folderId),
            wasOnShortList: Boolean(body?.wasOnShortList),
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
          if (body?.wasOnShortList) entry.wasOnShortList = true;
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

          // Server-authoritative Short List detection.
          //
          // If a copy of this item is still on the Short List when it's
          // completed, remove it here and mark the entry so `restore` can put it
          // back on the Short List later. This does NOT depend on the client
          // detecting the Short List membership or threading a `shortListEntryId`
          // through launch — it's a self-contained check that runs every finalize.
          //
          // It's also a safe superset of any client behavior: if the client
          // already removed the Short List copy (and passed wasOnShortList in the
          // body, honored above), this simply finds nothing and is a no-op.
          if (normalizeFolder(entry.folderId) !== 'short-list') {
            try {
              const shortListKey = queueKeyFor('short-list', uid);
              const shortList = await readKey(shortListKey);
              const needle = (entry.text || '').trim().toLowerCase();
              const idx = shortList.findIndex(i =>
                (entry.sourceItemId && i && i.sourceItemId === entry.sourceItemId) ||
                (needle && i && (i.text || '').trim().toLowerCase() === needle)
              );
              if (idx >= 0) {
                entry.wasOnShortList = true;
                // If the completed entry lacks a sourceItemId, adopt the matched
                // Short List entry's so restore can rebuild the reference.
                if (!entry.sourceItemId && shortList[idx]?.sourceItemId) {
                  entry.sourceItemId = shortList[idx].sourceItemId;
                }
                const updatedShortList = shortList.filter((_, i) => i !== idx);
                await writeKey(shortListKey, updatedShortList);
              }
            } catch {}
          }
        }

        await writeKey(CKEY, all);
        return json({ entry: publicShape(entry) }, 200);
      }

      if (action === 'restore') {
        const id = (body?.id || '').toString();
        if (!id) return json({ error: 'Missing id' }, 400);

        const completed = await readKey(CKEY);
        const entry = completed.find(e => e.id === id);
        const updatedCompleted = completed.filter(e => e.id !== id);

        const targetFolder = normalizeFolder(entry?.folderId);
        const queueKey = queueKeyFor(targetFolder, uid);
        let updatedQueue = await readKey(queueKey);
        if (entry) {
          const newItem = {
            id: entry.sourceItemId || newId(),
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
        }

        // If the item was also on the Short List when it was completed,
        // restore a proper reference entry (with sourceItemId) — deduped.
        if (entry?.wasOnShortList && entry?.sourceItemId) {
          const shortListKey = queueKeyFor('short-list', uid);
          const shortList = await readKey(shortListKey);
          const alreadyThere = shortList.some(i => i.sourceItemId === entry.sourceItemId);
          if (!alreadyThere) {
            await writeKey(shortListKey, [
              {
                id: newId(),
                text: entry.text || '',
                sourceItemId: entry.sourceItemId,
                sourceFolderId: normalizeFolder(entry.folderId),
                createdAt: Date.now(),
              },
              ...shortList,
            ]);
          }
        }

        await writeKey(CKEY, updatedCompleted);
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
      const all = await readKey(CKEY);
      const updated = all.filter(e => e.id !== id);
      await writeKey(CKEY, updated);
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
