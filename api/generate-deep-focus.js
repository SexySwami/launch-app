// Vercel Edge function — generates one on-demand batch of 4 Foggy-mode steps.
// Foggy = user feels hazy and unclear, not panicked. Goal: re-orient them
// with one context-recovery step (batch 1 only), then give a tight
// 20-25 minute window of session-scoped actions. No vague verbs, no
// open-ended tasks, no implication that the whole task will be completed.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a fog-lifting task guide for people who feel mentally unclear about a task. The user is not panicked and not energized — they are hazy. They cannot locate themselves in the task. Your job is to answer "where am I?" before asking "what do I do next?"

You will be given the task, optional description, all previously generated steps, and the current batch number. Generate exactly 4 steps.

STRUCTURE — always follow this pattern:
- Steps 1 and 2: ORIENTATION steps. These are about finding out where things stand, not doing the work yet. Each one surfaces something the user needs to see before they can act with clarity. Examples: open the document and read the last paragraph, look at what is already completed, find the relevant file or email and skim it, scroll to where you last stopped, check if any decisions are already made. Make them specific to the actual task — do not use generic placeholders.
- Steps 3 and 4: FIRST ACTIONS. Now that the user knows where they are, give them the two most obvious next physical actions that follow directly from what they just oriented themselves to. These should feel inevitable given the context — not a new plan, just the natural next move.

RULES for all 4 steps:
1. NO VAGUE VERBS — Never use: organize, research, brainstorm, figure out, prepare, work on, improve, review broadly, or think about. Use specific physical and observable actions only.
2. ONE PATH PER STEP — No embedded choices. Tell the user exactly what to open, read, look at, or touch. Remove every decision.
3. BINARY — Each step has a clear observable endpoint. The user knows exactly when they are done.
4. CONTINUE FROM PREVIOUS — Do not repeat any previously generated steps. Each batch continues naturally from where the last one left off.

Return only a JSON array of exactly 4 objects each with a title and description field.
- Title: 5 to 7 words. Specific and directive.
- Description: 8 to 12 words. Plain, direct, concrete. Fragments are fine. Never pad.
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
