// Regenerates the N steps that follow a set of already-accepted (locked) steps.
// Used when a step is edited so that subsequent steps stay sequentially coherent.
// Supports three modes: fourStep (guided execution), micro (small chunker), deep (deep focus).
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_FOUR_STEP = `You are an expert task planner. A mission has been partially broken into steps and the user has accepted some of them. You need to generate the remaining steps that follow naturally from the accepted ones.

Phase definitions — use exactly these tags:
- OPEN: setup/prep — getting files, tools, or environment ready. No real work yet.
- SCAN: orient — read, review, or look at something without changing it.
- EXEC: the actual doing — the smallest meaningful forward motion.
- PUSH: finalize — save, send, snooze, archive, lock progress in.

Rules for each new step:
- Title: 5-7 words, starts with an action verb, highly specific to the mission
- Hint: one short sentence that adds concrete context
- Must follow naturally from the accepted steps
- Never repeat what a locked step already covers

Output JSON only, no explanation:
{"steps":[{"tag":"TAG","title":"...","hint":"...","reward":4},...]}`;

const SYSTEM_MICRO = `You are an ADHD task re-chunking engine. Some micro-steps for a task have already been accepted. Generate the requested number of additional steps that continue naturally from the accepted ones.

Each new step must:
- Feel emotionally safe and immediately doable — no ramp-up required
- Be binary: clear start, clear end
- Avoid vague verbs (organize, research, brainstorm, figure out, prepare, optimize, work on, improve, plan)
- Use specific, physical, observable actions only
- Follow naturally from the accepted steps without repeating any of them

Aim for: title 5-6 words, description 10-12 words (go longer only if genuinely needed for clarity).

Output JSON only, no explanation:
[{"title":"...","description":"..."}]`;

const SYSTEM_DEEP = `You are an expert task planner specializing in ADHD-friendly communication. Some steps for a task have already been accepted. Generate the requested number of additional steps that continue naturally from the accepted ones.

Each step must have:
- A title of 5-7 words (specific to the task, action-based)
- A description as short as possible — aim 8-10 words, go longer only if the step genuinely needs more context

Follow naturally from the accepted steps without repeating any of them.

Output JSON only, no explanation:
[{"title":"...","description":"..."}]`;

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not configured' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const mission = (body?.mission || '').toString().trim();
  if (!mission) return json({ error: 'Missing mission' }, 400);

  const mode = ['fourStep', 'micro', 'deep'].includes(body?.mode) ? body.mode : 'micro';
  const count = Number.isInteger(body?.count) && body.count > 0 && body.count <= 4
    ? body.count : 1;
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const lockedSteps = Array.isArray(body?.lockedSteps) ? body.lockedSteps : [];
  const remainingTags = Array.isArray(body?.remainingTags) ? body.remainingTags : [];

  let systemPrompt;
  let userContent;

  if (mode === 'fourStep') {
    systemPrompt = SYSTEM_FOUR_STEP;
    const lockedBlock = lockedSteps.length
      ? lockedSteps
          .map((s, i) => `${i + 1}. [${s.tag || '?'}] ${s.title}${s.hint ? ` — ${s.hint}` : ''}`)
          .join('\n')
      : '(none)';
    userContent = [
      `Mission: "${mission}"`,
      description ? `Description: "${description}"` : null,
      `Accepted steps (do not repeat or contradict these):\n${lockedBlock}`,
      remainingTags.length
        ? `Remaining phase tags to use (in order): ${remainingTags.join(', ')}`
        : null,
      `Generate exactly ${count} step${count > 1 ? 's' : ''} continuing from step ${lockedSteps.length + 1}.`,
    ].filter(Boolean).join('\n\n');
  } else {
    systemPrompt = mode === 'deep' ? SYSTEM_DEEP : SYSTEM_MICRO;
    const lockedBlock = lockedSteps.length
      ? lockedSteps
          .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
          .join('\n')
      : '(none)';
    userContent = [
      `Task: "${mission}"`,
      description ? `Description: "${description}"` : null,
      `Accepted steps (do not repeat or contradict these):\n${lockedBlock}`,
      `Generate exactly ${count} more step${count > 1 ? 's' : ''} continuing from step ${lockedSteps.length + 1}.`,
    ].filter(Boolean).join('\n\n');
  }

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
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (err) {
    return json({ error: 'Upstream request failed: ' + err.message }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({ error: data?.error?.message || 'Claude API error' }, upstream.status);
  }

  const text = data?.content?.[0]?.text || '';
  const match = text.match(/\[[\s\S]*\]/) || text.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: 'Could not parse model response', raw: text }, 502);

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return json({ error: 'Invalid JSON from model', raw: text }, 502); }

  const raw = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.steps) ? parsed.steps : [];
  if (raw.length === 0) return json({ error: 'Model returned no steps', raw: text }, 502);

  let steps;
  if (mode === 'fourStep') {
    const DEFAULT_TAGS = ['OPEN', 'SCAN', 'EXEC', 'PUSH'];
    const DEFAULT_REWARDS = [4, 4, 4, 3];
    const startIdx = lockedSteps.length;
    steps = raw.slice(0, count).map((s, i) => ({
      tag: typeof s?.tag === 'string'
        ? s.tag.toUpperCase().trim()
        : (remainingTags[i] || DEFAULT_TAGS[startIdx + i] || 'EXEC'),
      title: typeof s?.title === 'string' ? s.title.trim() : '',
      hint: typeof s?.hint === 'string' ? s.hint.trim()
        : typeof s?.description === 'string' ? s.description.trim() : '',
      reward: Number.isFinite(s?.reward)
        ? Math.max(1, Math.min(6, Math.round(s.reward)))
        : DEFAULT_REWARDS[startIdx + i] ?? 4,
    }));
  } else {
    steps = raw.slice(0, count).map(s => ({
      title: typeof s?.title === 'string' ? s.title.trim() : '',
      description: typeof s?.description === 'string' ? s.description.trim() : '',
    }));
  }

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
