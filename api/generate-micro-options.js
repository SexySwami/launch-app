// Vercel Edge function — asks Claude for 3 alternative micro-step titles.
// Independent from /api/generate-options (which is the 4-step regen
// endpoint). Tailored to the Small Chunker context: receives the task,
// optional description, all previously generated micro-steps, the current
// step being swapped, and any already-suggested options to avoid.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are an ADHD task re-chunking engine helping someone swap one
micro-step for a different, better alternative. You will be given:
- The task title and optional description
- All micro-steps already generated for this task (for context)
- The current step title the user wants to swap
- Titles that have already been suggested in this swap session (do not
  repeat them)

Generate exactly 3 alternative titles for the current step. Each new
title must:
- Offer a GENUINELY different way to accomplish what this step is for —
  three distinct approaches or tactics, not rewordings, synonyms, or light
  edits of the current step or of each other. The user wants a fresh take,
  so each option should feel like a new idea they had not already considered
- Feel emotionally safe and immediately doable — no ramp-up or motivation
  required
- Be binary: clear start, clear end
- Avoid vague verbs (organize, research, brainstorm, figure out, prepare,
  optimize, work on, improve, plan)
- Use specific, physical, observable actions only
- Fit naturally into the flow of the surrounding steps without repeating
  what comes before or after
- Aim for 5 to 6 words. Soft target — go a little longer when needed,
  never pad just to hit a word count

Output JSON ONLY, no preamble, explanation, or trailing prose:
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

  const mission = (body?.mission || '').toString().trim();
  const currentStep = (body?.currentStep || '').toString().trim();
  if (!mission || !currentStep) {
    return json({ error: 'Missing required fields: mission, currentStep' }, 400);
  }

  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const seenOptions = Array.isArray(body?.seenOptions)
    ? body.seenOptions.filter(s => typeof s === 'string' && s.trim())
    : [];

  const previousSteps = Array.isArray(body?.previousSteps)
    ? body.previousSteps
        .map(s => ({
          title: typeof s?.title === 'string' ? s.title.trim() : '',
          description: typeof s?.description === 'string' ? s.description.trim() : '',
        }))
        .filter(s => s.title)
    : [];

  const previousBlock = previousSteps.length
    ? previousSteps
        .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
        .join('\n')
    : '(none)';

  const seenBlock = seenOptions.length
    ? `\n\nDo NOT repeat any of these (already shown to the user):\n${seenOptions.map(s => `- ${s}`).join('\n')}`
    : '';

  const userMessage = [
    `Task: "${mission}"`,
    description ? `Description: "${description}"` : null,
    `Previously generated steps for this task:\n${previousBlock}`,
    `Current step (the one they want to swap): "${currentStep}"`,
  ].filter(Boolean).join('\n\n') + seenBlock;

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
