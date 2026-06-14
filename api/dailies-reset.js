// Vercel Edge function — Dailies daily reset.
//
// At 12:00 AM local time, all completed Dailies items from the previous day
// are restored to the active Dailies queue. Their completed entries are kept
// as historical records (never deleted).
//
// Redis keys:
//   launch:queue:dailies       — active Dailies checklist
//   launch:completed           — all completed entries (shared)
//   launch:dailies:last_reset  — { timestamp: number, localDate: string }
//
// Endpoint:
//   GET /api/dailies-reset?localDate=YYYY-MM-DD
//     → { reset: false }                   already reset today
//     → { reset: true, restoredCount: N }  reset performed

export const config = { runtime: 'edge' };

import { getUserId } from './_auth.js';

const queueKey  = (uid) => `launch:${uid}:queue:dailies`;
const completedKey = (uid) => `launch:${uid}:completed`;
const resetKey  = (uid) => `launch:${uid}:dailies:last_reset`;

// Legacy global keys for one-time migration.
const LEGACY_QUEUE_KEY     = 'launch:queue:dailies';
const LEGACY_COMPLETED_KEY = 'launch:completed';
const CLAIM_FLAG           = 'launch:legacy:claimed';

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
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
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
  return `dr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default async function handler(request) {
  const { url, token } = creds();
  if (!url || !token) {
    return json({ error: 'Cloud store not configured.' }, 500);
  }

  const uid = await getUserId(request);
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const QUEUE_KEY     = queueKey(uid);
  const COMPLETED_KEY = completedKey(uid);
  const RESET_KEY     = resetKey(uid);

  const u = new URL(request.url);
  const localDate = u.searchParams.get('localDate') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return json({ error: 'Missing or invalid localDate (expected YYYY-MM-DD)' }, 400);
  }

  try {
    const lastReset = await readKey(RESET_KEY);
    if (lastReset?.localDate === localDate) {
      return json({ reset: false }, 200);
    }

    // Restore completed Dailies items that were completed since the last reset.
    const lastResetTimestamp = typeof lastReset?.timestamp === 'number' ? lastReset.timestamp : 0;

    // Read completed entries — migrate from legacy key on first access.
    let allCompleted = (await readKey(COMPLETED_KEY)) || [];
    if (!allCompleted.length) {
      const claimedBy = await readString(CLAIM_FLAG);
      if (!claimedBy || claimedBy === uid) {
        const legacy = (await readKey(LEGACY_COMPLETED_KEY)) || [];
        if (legacy.length) {
          await writeKey(COMPLETED_KEY, legacy);
          if (!claimedBy) await writeString(CLAIM_FLAG, uid);
          allCompleted = legacy;
        }
      }
    }

    const toRestore = allCompleted.filter(e =>
      e && e.completedAt && e.folderId === 'dailies' && e.completedAt >= lastResetTimestamp
    );

    if (toRestore.length > 0) {
      // Read dailies queue — migrate from legacy key on first access.
      let currentQueue = (await readKey(QUEUE_KEY)) || [];
      if (!currentQueue.length) {
        const claimedBy = await readString(CLAIM_FLAG);
        if (!claimedBy || claimedBy === uid) {
          const legacy = (await readKey(LEGACY_QUEUE_KEY)) || [];
          if (legacy.length) {
            await writeKey(QUEUE_KEY, legacy);
            if (!claimedBy) await writeString(CLAIM_FLAG, uid);
            currentQueue = legacy;
          }
        }
      }

      const sorted = [...toRestore].sort((a, b) => {
        const ai = typeof a.sourceItemIndex === 'number' ? a.sourceItemIndex : Infinity;
        const bi = typeof b.sourceItemIndex === 'number' ? b.sourceItemIndex : Infinity;
        return ai - bi;
      });

      let queue = [...currentQueue];
      for (const entry of sorted) {
        const idx = Math.max(0, Math.min(
          typeof entry.sourceItemIndex === 'number' ? entry.sourceItemIndex : queue.length,
          queue.length
        ));
        const item = { id: newId(), text: entry.text || '', createdAt: Date.now() };
        if (entry.description) item.description = entry.description;
        queue = [...queue.slice(0, idx), item, ...queue.slice(idx)];
      }

      await writeKey(QUEUE_KEY, queue);
    }

    await writeKey(RESET_KEY, { timestamp: Date.now(), localDate });
    return json({ reset: true, restoredCount: toRestore.length }, 200);
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
