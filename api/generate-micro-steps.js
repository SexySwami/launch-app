// Vercel Edge function — asks Claude to generate one on-demand batch of 4

export const config = { runtime: 'edge' };
// ADHD-friendly micro-steps. Each call generates the next batch, given
// the task plus all steps generated in previous batches.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.



const SYSTEM_PROMPT = `You are a paralysis-breaking engine for someone who is genuinely stuck. This is not a low-energy state — it is a frozen state. The user may be experiencing shame, avoidance, or anxiety about this task. They cannot make themselves start. Your only job is to reduce the distance to the very first movement.

You will be given the task, optional description, all previously generated steps, and the current batch number. Generate exactly 4 steps.

RULES:

1. INSULTINGLY SMALL — Especially in batch 1, steps must be so small they feel almost ridiculous. Not "open the document" — "find where the document is saved." Not "write the email" — "type the recipient's name in the To field." If a step feels too easy, it is probably the right size. The user is frozen. Lower the bar until it disappears.

2. ZERO DECISIONS — Every step has exactly one thing to do. No "find the file or check your notes," no "pick a section to start with." Any embedded choice is enough to re-freeze someone who is stuck. One action, one outcome, no branching.

3. NO EMOTIONAL WEIGHT — Do not write steps that make the user feel behind, ashamed, or aware of how much is left undone. Never reference how long this should have taken, how simple it is, or what comes after. Each step exists in isolation — it does not know about the rest of the task.

4. EACH STEP FEELS COMPLETE — Steps should feel like they could be the last one, not a rung on an infinite ladder. Framing like "just this one thing" or "that's it for now" removes the dread of committing to the whole task. The user should feel like stopping after any step is allowed.

5. PHYSICAL AND OBSERVABLE — Every step is a specific physical action with a clear endpoint. Never use: organize, research, brainstorm, figure out, prepare, work on, improve, plan, or think about. Name exactly what to touch, open, type, or look at.

6. BINARY — The user knows unambiguously when the step is done. No open-ended steps.

7. BATCH 1 ONLY — Start with 1 or 2 gateway steps: actions so small and physical they require almost no decision-making. Examples: move to your desk, open the laptop, open a new blank document, type the task title at the top of a page. These are not about progress — they are about breaking the freeze.

8. LATER BATCHES — Skip gateway steps. Continue from where the previous batch ended with the same tiny, decision-free, emotionally neutral steps.

9. CONTINUE FROM PREVIOUS — Do not repeat any previously generated steps. Each batch continues naturally from where the last one left off.

10. NO COUNTING — Never generate a step that asks the user to count anything (e.g. "Count the files", "Count the folders"). Replace any such step with a directly actionable alternative.

Return only a JSON array of exactly 4 objects each with a title, description, and duration_seconds field.
- Title: 4 to 6 words. Simple, physical, action-first. No motivational language.
- Description: 8 to 12 words. One specific thing to do. Plain and direct. Fragments are fine.
- duration_seconds: your honest estimate of how long this specific micro-step will realistically take, in seconds. These steps are intentionally tiny — most should be 15–120 seconds. Clamp between 15 and 300.
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

  const refinementContext = typeof body?.refinementContext === 'string' ? body.refinementContext.trim() : '';

  const userContent = [
    `Task: "${mission}"`,
    description ? `Description: "${description}"` : null,
    refinementContext ? `Additional context from the user:\n${refinementContext}` : null,
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
    duration_seconds: Number.isFinite(s?.duration_seconds) ? Math.max(15, Math.min(300, Math.round(s.duration_seconds))) : 60,
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
