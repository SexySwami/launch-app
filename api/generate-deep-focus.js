// Vercel Edge function — generates one on-demand batch of 4 Foggy-mode steps.
// Foggy = user feels hazy and unclear, not panicked. Goal: re-orient them
// with one context-recovery step (batch 1 only), then give a tight
// 20-25 minute window of session-scoped actions. No vague verbs, no
// open-ended tasks, no implication that the whole task will be completed.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a focus recovery engine for people in a foggy, low-clarity mental state. The user knows roughly what they need to do but feels mentally unclear — not panicked, not energized, just hazy and unable to locate themselves in the task. Your job is to gently re-orient them and then give them a contained window of work.

You will be given the task, optional description, all previously generated steps, and the current batch number. Generate exactly 4 steps.

STRUCTURE:
- Batch 1 only: Make step 1 a CONTEXT RECOVERY step — a single orienting action that helps the user re-locate themselves in the task before doing any real work. This is not about executing, it is about finding where things stand. Examples: open the document and read the last paragraph, look at what is already done, find the file and scroll to where you stopped, check the last note or email about this task. Make it specific to the actual task given.
- All remaining steps (steps 2 to 4 in batch 1, all 4 steps in later batches): SESSION ACTIONS scoped only to the next 20 to 25 minutes. Not the whole task. Not a plan to completion. Just what to do in this one focused window. Never imply the task will be finished.

RULES for every step:
1. ELIMINATE DECISIONS — Each step has exactly one path. No "decide which section," no "choose what to focus on." Tell the user exactly what to open, touch, or look at. Remove every embedded choice.
2. NO VAGUE VERBS — Never use: organize, research, brainstorm, figure out, prepare, work on, improve, review broadly, or think about. Use specific physical and observable actions only.
3. SESSION-SCOPED — Steps are framed as what to do right now in this window, not as progress toward finishing the whole task. Never suggest finishing.
4. BINARY — Every step has a clear and observable endpoint. The user knows exactly when they are done with it.
5. CONTINUE FROM PREVIOUS — Do not repeat any previously generated steps. Each batch continues naturally from where the last one left off.

Return only a JSON array of exactly 4 objects each with a title and description field.
- Title: 5 to 7 words. Specific, directive, action-first.
- Description: 8 to 12 words. Plain and direct. States exactly what to open, look at, or do. Fragments are fine. Never pad.
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
