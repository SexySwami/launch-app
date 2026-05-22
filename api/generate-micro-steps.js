// Vercel Edge function — asks Claude to generate one on-demand batch of 4
// ADHD-friendly micro-steps. Each call generates the next batch, given
// the task plus all steps generated in previous batches.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are an ADHD task re-chunking engine. Your only goal is to reduce the
distance between the user and taking action. You are generating one batch
of 4 steps at a time for a larger task breakdown.

You will be given:
- The task title and optional description
- All steps already generated in previous batches
- The current batch number

Generate exactly 4 new steps that continue logically from where the
previous steps left off. Do not repeat any previously generated steps.
Each new step should build on the momentum of the previous ones and
progress the task forward meaningfully.

Follow ALL of these rules:
1. EMOTIONALLY SAFE — Steps must feel obvious, low-stakes, and easy to
   begin immediately.
2. NO VAGUE VERBS — Never use: organize, research, brainstorm, figure out,
   prepare, optimize, work on, improve, or plan. Use specific physical
   observable actions only.
3. BINARY TASKS ONLY — Every step has a clear beginning and clear end.
4. CHUNK FOR LOW DOPAMINE STATES — Assume the user is tired, anxious, or
   overwhelmed. Every step must work in a low-functioning mental state.
5. OPTIMIZE FOR MOMENTUM — Small completions create dopamine. Prioritize
   movement over perfection.
6. ACTION-BASED NOT TIME-BASED — Define completion by observable output,
   never by duration.
7. SURFACE HIDDEN DEPENDENCIES — Identify invisible sub-requirements and
   surface them as explicit steps. If the task secretly requires finding
   files, making decisions, or gathering information first, those steps
   must appear before the main action steps they unblock.
8. For batch 1 only: begin with 1 to 2 gateway tasks — ultra-low-resistance
   actions like opening the app, sitting down, or opening the document.
9. For later batches: skip gateway tasks and move directly into progressive
   action steps that advance the task.

Return only a JSON array of exactly 4 objects each with a title and
description field. Length targets are soft, not hard. Aim for these
ranges but go longer when the step genuinely needs more words to be
clear and useful. Never pad unnecessarily, but never cut meaning just
to hit a word count.
- Title: aim for 5 to 6 words. Short, punchy, and action-based.
- Description: aim for 10 to 12 words. Plain, direct, and conversational.
  Fragments are fine. Avoid long explanations or full formal sentences.
No explanation, no markdown, no bullet points.`;

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

  const batchNumber = Number.isFinite(body?.batchNumber) && body.batchNumber > 0
    ? Math.floor(body.batchNumber)
    : 1;

  const previousStepsRaw = Array.isArray(body?.previousSteps) ? body.previousSteps : [];
  const previousSteps = previousStepsRaw
    .map(s => ({
      title: typeof s?.title === 'string' ? s.title.trim() : '',
      description: typeof s?.description === 'string' ? s.description.trim() : '',
    }))
    .filter(s => s.title);

  const previousBlock = previousSteps.length
    ? previousSteps
        .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
        .join('\n')
    : '(none — this is batch 1)';

  const userContent = [
    `Task: "${mission}"`,
    description ? `Description: "${description}"` : null,
    `Current batch number: ${batchNumber}`,
    `Previously generated steps:\n${previousBlock}`,
    `Now generate exactly 4 NEW micro-steps that continue from step ${previousSteps.length + 1}.`,
  ].filter(Boolean).join('\n\n');

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
        max_tokens: 800,
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

  const steps = raw.map((s) => ({
    title: typeof s?.title === 'string' ? s.title.trim() : '',
    description: typeof s?.description === 'string' ? s.description.trim() : '',
  }));

  if (steps.some(s => !s.title)) {
    return json({ error: 'A step is missing a title', raw: text }, 502);
  }

  return json({ steps, batchNumber }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
