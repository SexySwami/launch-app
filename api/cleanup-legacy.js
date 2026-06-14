// ONE-TIME cleanup endpoint — deletes all legacy global Redis keys so new

export const config = { runtime: 'edge' };
// users get a clean slate. Delete this file after running once.
// Protected by a hardcoded secret to prevent accidental calls.



const SECRET = 'nuke-legacy-7x9q';

const LEGACY_KEYS = [
  'launch:queue:work',
  'launch:queue:personal',
  'launch:queue:health',
  'launch:queue:dailies',
  'launch:queue:short-list',
  'launch:completed',
  'launch:dailies:last_reset',
];

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

export default async function handler(request) {
  const { url, token } = creds();
  if (!url || !token) return json({ error: 'No store configured' }, 500);

  const u = new URL(request.url);
  if (u.searchParams.get('secret') !== SECRET) return json({ error: 'Forbidden' }, 403);

  try {
    // Delete all legacy keys + set claim flag so migration never runs again.
    const keysToDelete = [...LEGACY_KEYS, 'launch:legacy:claimed'];
    const commands = keysToDelete.map(k => ['DEL', k]);
    // Then SET the claim flag to a sentinel that blocks all future migrations.
    commands.push(['SET', 'launch:legacy:claimed', 'migrated']);

    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Pipeline failed (${res.status})`);

    return json({ ok: true, deleted: LEGACY_KEYS, claimFlagSet: 'migrated' }, 200);
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
