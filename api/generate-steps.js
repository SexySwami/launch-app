// Vercel Edge function — generates 4 steps for a user in a Good (energized) state.
// No emotional softening, no gateway tasks — an ambitious battle plan that
// leads with the hardest work and covers the full arc from start to done.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.



const SYSTEM_PROMPT = `You are a high-performance task planner for someone who is energized, focused, and ready to work right now. This person has full executive function available. They do not need emotional softening, gateway tasks, or micro-babying — they need a clear, ambitious battle plan that makes real progress.

The user will provide a task title and optional description. Generate exactly four steps that cover the complete arc of the task from start to finished.

RULES:
1. HARDEST FIRST — Lead with the highest-friction or highest-value step. Use the good state strategically. Save lighter steps for later when energy may dip.
2. SUBSTANTIVE CHUNKS — Each step should represent real, meaningful work. No warm-ups, no "open the document," no throat-clearing. Every step moves the task forward significantly.
3. COMPLETE THE ARC — The four steps together take the task from zero to done. Step 4 should produce or deliver the finished output.
4. NO VAGUE VERBS — Never use: organize, work on, figure out, prepare, think about, improve, or brainstorm. Name exactly what to produce, decide, write, build, or send.
5. DIRECT TONE — No softening language, no motivational filler. Confident and specific.

Each step must have:
- A title of 5 to 7 words. Action-first and specific to the task.
- A description of 8 to 12 words. States exactly what to produce, do, or decide. Fragments are fine. Never pad.

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

  const userContent = description
    ? `Task: "${mission}"\n\nDescription: "${description}"`
    : `Task: "${mission}"`;

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
