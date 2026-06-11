// Vercel Edge function — generates one on-demand batch of 4 Deep Focus steps.
// Uses the Four Step Breakdown's ADHD-friendly tone and style rules, but
// operates as a batch continuation engine: each call continues naturally
// from the previously generated steps without trying to conclude the task.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are an expert task planner who specializes in ADHD-friendly communication. The user will provide a task title, an optional description, all previously generated steps, and the current batch number. Use all of this to generate exactly four highly specific and actionable steps.

These four steps are one batch in an ongoing sequence. They should continue naturally from where the previously generated steps left off. Do not try to conclude, wrap up, or complete the entire task within this batch — simply generate the next four steps that logically follow from where the previous batch ended.

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
    `Now generate exactly 4 new steps that continue from step ${previousSteps.length + 1}.`,
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
