// Vercel Edge function — generates 4 Good-mode steps (energized, ready to work).

export const config = { runtime: 'edge' };
// Good = user has energy and is ready to move. Goal: give a clear entry point
// and scope the first real work so they don't spin out deciding where to start.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.



const SYSTEM_PROMPT = `You are a momentum-keeper for people with ADHD who are energized and ready to work. They do not need motivation — they are already moving. Your job is to give them a clear entry point and scope the first real work so they don't spin out trying to figure out where to start.

Generate exactly 4 steps.

STRUCTURE — always follow this pattern:
- Step 1: Open the artifact. The literal, physical act of pulling up the primary document, file, email, app, or tool the task involves. Title must begin with "Open." Nothing else — no reading, no analyzing, just making the thing appear on screen.
- Step 2: Find where to pick up. One quick look to locate where things currently stand — the last paragraph written, the current state of the file, what decisions are already made. Not a full review. One pass.
- Steps 3 and 4: Do the work. The first two real, specific, scoped pieces of work. Each one produces something nameable with a clear endpoint. Not tiny warm-up steps — sized for someone with energy. But not "complete the whole thing" either. Scope to a single section, item, or output.

RULES for all 4 steps:
1. NO VAGUE VERBS — Never: organize, work on, figure out, prepare, think about, improve, brainstorm, or review broadly. Use specific physical and observable actions only.
2. ONE PATH PER STEP — No embedded choices. Tell the user exactly what to open, read, write, click, or submit.
3. BINARY — Each step has a clear observable endpoint. The user knows exactly when they are done.
4. CONTINUE FROM PREVIOUS — Do not repeat any previously generated steps. Continue naturally from where the last batch left off.

Each step: title (5–7 words, action-first, specific to this task), hint (8–12 words, what the step produces or what done looks like, fragments fine, never pad), and duration_seconds (your honest estimate of how long this specific step will realistically take, in seconds — not a generic default, but calibrated to the actual action; clamp between 30 and 900).
Return only a JSON array: [{"title":"...","hint":"...","duration_seconds":N}, ...]. No explanation, no markdown, no bullet points.`;

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
  const previousSteps = Array.isArray(body?.previousSteps) ? body.previousSteps : [];

  let userContent = description
    ? `Task: "${mission}"\n\nDescription: "${description}"`
    : `Task: "${mission}"`;

  if (previousSteps.length > 0) {
    const prevList = previousSteps
      .map((s, i) => `${i + 1}. ${(s.title || '').trim()}${s.hint ? ` — ${s.hint.trim()}` : ''}`)
      .filter(Boolean)
      .join('\n');
    userContent += `\n\nSteps already completed by the user:\n${prevList}\n\nGenerate 4 new steps that continue from where the user left off. Do NOT repeat or rephrase any completed step. Pick up from the natural next action and drive toward a finished result.`;
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
    duration_seconds: Number.isFinite(s?.duration_seconds) ? Math.max(30, Math.min(900, Math.round(s.duration_seconds))) : 120,
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
