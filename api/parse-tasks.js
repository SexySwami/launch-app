// Vercel Edge function — splits a pasted block of text into individual tasks
// using Claude. Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT =
  'You are a task parser. The user will paste a block of text containing ' +
  'multiple tasks or to-do items. Split them into individual items, rephrase ' +
  'each one to be clear and concise without losing key details, and return ' +
  'ONLY a JSON array of strings. No explanation, no markdown.';

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

  const text = (body?.text || '').toString().trim();
  if (!text) return json({ error: 'Missing text' }, 400);
  if (text.length > 12000) return json({ error: 'Text too long (12k char max)' }, 400);

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
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
    });
  } catch (err) {
    return json({ error: 'Upstream request failed: ' + err.message }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({ error: data?.error?.message || 'Claude API error', status: upstream.status }, upstream.status);
  }

  const responseText = data?.content?.[0]?.text || '';
  const match = responseText.match(/\[[\s\S]*\]/);
  if (!match) return json({ error: 'Could not parse model response', raw: responseText }, 502);

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return json({ error: 'Invalid JSON from model', raw: responseText }, 502); }

  if (!Array.isArray(parsed)) return json({ error: 'Model did not return an array' }, 502);

  const tasks = parsed
    .filter(t => typeof t === 'string')
    .map(t => t.trim().slice(0, 500))
    .filter(t => t)
    .slice(0, 50); // sanity cap

  if (tasks.length === 0) return json({ error: 'Model returned no usable tasks' }, 502);

  return json({ tasks }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
