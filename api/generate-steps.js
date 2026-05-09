// Vercel Edge function — asks Claude to break a mission into 4 micro-steps.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You're a coach helping someone with ADHD start a task. Take their mission and break it into EXACTLY 4 micro-steps that move them from "stuck" to "in flow."

The 4 phases run in this order:
1. OPEN — setup. Get tools/files/inbox/doc ready. No real work yet.
2. SCAN — orient. Read or review without changing anything.
3. EXEC — the actual doing. The smallest meaningful forward motion.
4. PUSH — finalize. Save, send, archive, lock progress in.

For physical/workout missions you may swap one or more phase tags:
- GEAR (in place of OPEN) — get clothes/equipment ready
- HYDR (in place of SCAN) — water, fuel, light intake
- WARM (in place of part of EXEC) — short warm-up

Each step must have:
- tag: 3–4 letter UPPERCASE code from the list above (OPEN/SCAN/EXEC/PUSH/GEAR/HYDR/WARM).
- title: 2–7 words, action-verb-led headline. Tiny, concrete, immediately doable. The smallest possible thing for that phase. Specific to the mission.
- hint: 4–10 words. A reassuring, ADHD-friendly micro-instruction in the same voice as: "Just open it. That's it.", "Skim — don't fix anything yet.", "One sentence is enough.", "Trust the draft.", "Cmd+S. Lock it in.", "You're already there."
- reward: integer 1–5. The four rewards must SUM TO EXACTLY 15. Use 4-4-4-3 unless a different split fits better.

Hard rules:
- Avoid generic phrases like "just start", "begin work", "get focused", "make progress".
- Each title must be different from the others — three angles on doing, not three rewordings.
- Tailor every step to the user's specific mission text — names, files, deadlines, and entities they mentioned should appear when relevant.

Output JSON ONLY, no preamble or explanation:
{"steps":[
  {"tag":"OPEN","title":"...","hint":"...","reward":4},
  {"tag":"SCAN","title":"...","hint":"...","reward":4},
  {"tag":"EXEC","title":"...","hint":"...","reward":4},
  {"tag":"PUSH","title":"...","hint":"...","reward":3}
]}`;

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
        messages: [{ role: 'user', content: `Mission: "${mission}"` }],
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
  if (!match) return json({ error: 'Could not parse model response', raw: text }, 502);

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return json({ error: 'Invalid JSON from model', raw: text }, 502); }

  const raw = Array.isArray(parsed.steps) ? parsed.steps : [];
  if (raw.length !== 4) {
    return json({ error: `Expected 4 steps, got ${raw.length}`, raw: text }, 502);
  }

  const steps = raw.map(s => ({
    tag: typeof s?.tag === 'string' ? s.tag.toUpperCase().trim().slice(0, 4) : 'STEP',
    title: typeof s?.title === 'string' ? s.title.trim() : '',
    hint: typeof s?.hint === 'string' ? s.hint.trim() : '',
    reward: Number.isFinite(s?.reward) ? Math.max(1, Math.min(6, Math.round(s.reward))) : 4,
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
