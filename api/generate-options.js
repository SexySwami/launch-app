// Vercel Edge function — asks Claude for 3 alternative micro-steps.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You're a coach helping someone with ADHD start tasks. They have a mission broken into 4 phases (OPEN/SCAN/EXEC/PUSH) and they want to swap the current step for a different, better alternative.

Phase definitions:
- OPEN: setup/prep — getting files, tools, or environment ready. No real work yet.
- SCAN: orient — read, review, or look at something without changing it.
- EXEC: the actual doing — the smallest meaningful forward motion.
- PUSH: finalize — save, send, snooze, archive, lock progress in.
- GEAR/HYDR/WARM: physical-prep variants used for workout/fitness missions.

For each request, generate exactly 3 alternative micro-steps for the same phase as the current step. Every option must:
- Be 2-7 words, start with an action verb
- Be tiny, concrete, and immediately doable (zero ramp-up)
- Match the phase exactly — never suggest execution for an OPEN step, never suggest setup for a PUSH step
- Be specific to the mission (avoid generic phrases like "just start", "begin work", "get focused")
- Be three GENUINELY different angles — not rewordings of each other

Output JSON ONLY, with no preamble, explanation, or trailing prose:
{"options":["First option","Second option","Third option"]}`;

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({
      error: 'ANTHROPIC_API_KEY is not configured. Add it as an environment variable in the Vercel project settings, then redeploy.',
    }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { mission, stepTag, currentStep, seenOptions = [] } = body || {};
  if (!mission || !currentStep) {
    return json({ error: 'Missing required fields: mission, currentStep' }, 400);
  }

  const seenBlock = seenOptions.length
    ? `\n\nDo NOT repeat any of these (already shown to the user):\n${seenOptions.map(s => `- ${s}`).join('\n')}`
    : '';

  const userMessage =
    `Mission: "${mission}"\n` +
    `Current step (the one they want to swap): "${currentStep}"\n` +
    `Phase tag: ${stepTag || 'unknown'}` +
    seenBlock;

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
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
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
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return json({ error: 'Could not parse model response', raw: text }, 502);
  }

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return json({ error: 'Invalid JSON from model', raw: text }, 502); }

  const options = Array.isArray(parsed.options)
    ? parsed.options.filter(o => typeof o === 'string' && o.trim()).slice(0, 3)
    : [];

  if (options.length === 0) {
    return json({ error: 'Model returned no usable options', raw: text }, 502);
  }

  return json({ options }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
