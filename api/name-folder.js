// Vercel Edge function — generates a short folder name for a list of tasks
// using Claude. Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT =
  'You are a task organizer. The user will provide a list of related tasks. ' +
  'Return only a short concise folder name of 2 to 5 words that summarizes ' +
  'the group. No explanation, no punctuation, no markdown. Plain text only.';

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({
      error:
        'ANTHROPIC_API_KEY is not configured. Add it as an environment variable in the Vercel project settings, then redeploy.',
    }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const tasks = Array.isArray(body?.tasks) ? body.tasks.filter(t => typeof t === 'string' && t.trim()) : [];
  if (tasks.length === 0) return json({ error: 'Missing tasks array' }, 400);

  const userContent = tasks.map((t, i) => `${i + 1}. ${t}`).join('\n');

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
        max_tokens: 32,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (err) {
    return json({ error: 'Upstream request failed: ' + err.message }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({ error: data?.error?.message || 'Claude API error', status: upstream.status }, upstream.status);
  }

  const name = (data?.content?.[0]?.text || '').trim().slice(0, 100);
  if (!name) return json({ error: 'Model returned an empty name' }, 502);

  return json({ name }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
