// Vercel Edge function — AI time estimation for checklist items.
// Accepts POST { itemId, folderId, text, description? }, calls Claude Haiku
// to estimate task duration, writes the estimate back to Redis, and returns
// { minutes, label } to the caller.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a time estimation assistant. Given a task title and optional description, estimate how long this task will take in minutes. Round to the nearest clean number from this set only: 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120. Return only a JSON object with two fields: "minutes" (integer, from the allowed set above) and "label" (string, the display label using prime notation e.g. "5'" or "30'" or "2h" for 120 minutes). No explanation, no markdown.`;

const ALLOWED = new Set([1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120]);

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

function keyFor(folder) {
  return `launch:queue:${folder || 'work'}`;
}

async function readItems(key) {
  const { url, token } = creds();
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data?.result) return [];
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeItems(key, items) {
  const { url, token } = creds();
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(items),
  });
}

function applyEstimate(items, itemId, minutes, label) {
  return items.map(item => {
    if (item && item.id === itemId) return { ...item, estimatedMinutes: minutes, estimatedLabel: label };
    if (item && item.type === 'folder' && Array.isArray(item.children)) {
      if (item.children.some(c => c && c.id === itemId)) {
        return {
          ...item,
          children: item.children.map(c =>
            c && c.id === itemId ? { ...c, estimatedMinutes: minutes, estimatedLabel: label } : c
          ),
        };
      }
    }
    return item;
  });
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const { url, token } = creds();
  if (!url || !token) return json({ error: 'Cloud queue not configured.' }, 500);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not configured.' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
  const folderId = typeof body?.folderId === 'string' ? body.folderId.trim() : '';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';

  if (!itemId || !folderId || !text) return json({ error: 'Missing required fields' }, 400);

  const userContent = description
    ? `Task: "${text}"\nDescription: "${description}"`
    : `Task: "${text}"`;

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (err) {
    return json({ error: 'Upstream request failed: ' + err.message }, 502);
  }

  const aiData = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({ error: aiData?.error?.message || 'Claude API error' }, upstream.status);
  }

  const rawText = aiData?.content?.[0]?.text || '';
  const match = rawText.match(/\{[\s\S]*?\}/);
  if (!match) return json({ error: 'Could not parse model response', raw: rawText }, 502);

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return json({ error: 'Invalid JSON from model', raw: rawText }, 502); }

  const minutes = parsed?.minutes;
  const label = typeof parsed?.label === 'string' ? parsed.label.trim() : '';
  if (!ALLOWED.has(minutes) || !label) return json({ error: 'Invalid estimate values' }, 502);

  // Persist the estimate to the item's folder and propagate to Short List if needed.
  try {
    const key = keyFor(folderId);
    const items = await readItems(key);
    await writeItems(key, applyEstimate(items, itemId, minutes, label));

    if (folderId !== 'short-list') {
      const slKey = keyFor('short-list');
      const slItems = await readItems(slKey);
      if (slItems.some(i => i?.sourceItemId === itemId)) {
        await writeItems(slKey, slItems.map(i =>
          i?.sourceItemId === itemId ? { ...i, estimatedMinutes: minutes, estimatedLabel: label } : i
        ));
      }
    }
  } catch {
    // Best-effort — still return the estimate to the caller.
  }

  return json({ minutes, label }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
