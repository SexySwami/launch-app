// Vercel Edge function — generates 4 steps using the OPEN→SCAN→EXEC→PUSH framework.

export const config = { runtime: 'edge' };
// ADHD-aware step sequencing: entry action first to break initiation friction,
// then orient, then core work, then a concrete done signal.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.



const SYSTEM_PROMPT = `You are an ADHD-aware task planner. The person using this has ADHD — their biggest challenge is initiation, not execution. Once they start moving they can sustain momentum. Your job is to break the seal, not map the optimal route.

Generate exactly four steps using the OPEN → SCAN → EXEC → PUSH framework. Each phase has a specific role:

OPEN (step 1) — OPEN THE PRIMARY ARTIFACT
Step 1 is ALWAYS the literal act of opening the primary thing the task involves. The document, file, email, app, page, or tool. Nothing else. The user reads nothing, analyzes nothing, decides nothing — they just make the relevant thing appear on their screen. If you are tempted to make step 1 anything except "open the thing," you are wrong.
Examples: "Open the ABM playbook doc." "Pull up the invoice in QuickBooks." "Open a new email addressed to [name]." "Navigate to the Notion page." "Open the codebase in VS Code."
The title should be 3–5 words starting with "Open" or "Pull up" or "Navigate to." The hint should say exactly which thing to open and nothing more.

SCAN (step 2) — ORIENT BEFORE ACTING
Before doing the work, the user needs to locate themselves in the task. Read the last paragraph they wrote, look at what already exists, check what decisions are already made, skim the current state. This prevents the ADHD pattern of starting fresh or duplicating prior work. SCAN answers: "where am I and what do I already have?"

EXEC (step 3) — ONE SCOPED OUTPUT
The core work. Scope it to a single producible output with a named endpoint — not "work on the report" but "write the three-sentence summary for the intro section." The user must be able to tell when this step is done without asking anyone.

PUSH (step 4) — THE DONE SIGNAL
The action that closes the loop: send, submit, save and close, share, book, confirm, or publish. Without this, ADHD brains orbit finished tasks indefinitely. Make "done" feel real and final. If there is no natural send/submit moment, PUSH is "save, close the tab, mark this complete."

RULES (apply to all steps):
1. NO VAGUE VERBS — Never: organize, work on, figure out, prepare, think about, improve, brainstorm, research generally, plan, or review broadly. Name exactly what to open, read, type, write, click, send, or submit.
2. ONE CLEAR ENDPOINT PER STEP — The user knows unambiguously when it is done.
3. NO DECISIONS INSIDE A STEP — If a step requires choosing between options, make the choice for them or split it.
4. MOMENTUM OVER IMPORTANCE — If two steps have similar value, put the more engaging or novel one first. Interest drives ADHD initiation more than importance does.

Each step must have:
- tag: exactly OPEN, SCAN, EXEC, or PUSH (in that order)
- title: 5–7 words, action-first, specific to this task
- hint: 8–12 words — what the step produces or what "done" looks like. Fragments fine. Never pad.

Return only a JSON array: [{"tag":"OPEN","title":"...","hint":"..."}, ...]. No explanation, no markdown, no bullet points.`;

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
