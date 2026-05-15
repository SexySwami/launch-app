// Vercel Edge function — asks Claude to break a mission into 4 micro-steps.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are an expert task planner who specializes in ADHD-friendly communication. The user will provide a task title and an optional description with additional context. Use both to generate exactly four highly specific and actionable micro steps.

Each step must have:
- A title of no more than 5 to 7 words. Write naturally and specifically to the task. Only add urgency or motivational language when it genuinely fits that specific step. Do not force motivational language onto every card.
- A description that is as short as possible — aim for 8 to 10 words but go longer if the step genuinely needs more context to be useful. Never pad it unnecessarily. If it can be said in 6 words, use 6 words. If it needs 20 to be clear and helpful, use 20.

Return only a JSON array of four objects each with a title and description field. No explanation, no markdown, no bullet points.`;

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({
      error: 'ANTHROPIC_API_KEY is not configured. Add it as an environment variable in Vercel project settings, then redeploy.',
    }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const mission = (body?.mission || '').toString().trim();
  if (!mission) return json({ error: 'Missing mission' }, 400);
  const description = typeof body?.description === 'string' ? body.description.trim() : '';

  const userContent = description
    ? `Task: "${mission}"\n\nDescription: "${description}"`
    : `Task: "${mission}"`;

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
        max_tokens: 600,
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

  const text = data?.content?.[0]?.text || '';
  const match = text.match(/\[[\s\S]*\]/) || text.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: 'Could not parse model response', raw: text }, 502);

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return json({ error: 'Invalid JSON from model', raw: text }, 502); }

  const raw = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.steps) ? parsed.steps : [];
  if (raw.length !== 4) {
    return json({ error: `Expected 4 steps, got ${raw.length}`, raw: text }, 502);
  }

  const DEFAULT_TAGS = ['OPEN', 'SCAN', 'EXEC', 'PUSH'];
  const DEFAULT_REWARDS = [4, 4, 4, 3];
  const steps = raw.map((s, i) => ({
    tag: typeof s?.tag === 'string' ? s.tag.toUpperCase().trim().slice(0, 4) : DEFAULT_TAGS[i],
    title: typeof s?.title === 'string' ? s.title.trim() : '',
    hint: typeof s?.hint === 'string' ? s.hint.trim()
      : typeof s?.description === 'string' ? s.description.trim() : '',
    reward: Number.isFinite(s?.reward) ? Math.max(1, Math.min(6, Math.round(s.reward))) : DEFAULT_REWARDS[i],
  }));

  if (steps.some(s => !s.title)) {
    return json({ error: 'A step is missing a title', raw: text }, 502);
  }

  return json({ steps }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
