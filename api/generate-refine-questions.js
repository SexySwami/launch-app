// Vercel Edge function — generates 2 targeted clarifying questions to help
// regenerate better, more accurate steps for a specific task. Questions are
// task-specific (not generic), focused on the context Claude most needs:
// access/tools already in place, experience level, scope, or where in the
// task the user actually is. Requires ANTHROPIC_API_KEY in Vercel settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are helping someone get better AI-generated steps for a task. Generate exactly 2 clarifying questions about WHY they are doing this task — their motivation, urgency, and what success looks like to them. This context helps generate steps that match their real goal, not just the surface task.

Question 1: Focus on the immediate reason or trigger. Why now? What's driving them to do this?
Question 2: Focus on the outcome. What does completion mean for them? What's the real goal underneath the task?

Rules:
- Questions must be WHY-oriented, not HOW-oriented. Do NOT ask about tools, access, experience level, or technical process.
- Make questions SPECIFIC to the actual task — not generic. "Why are you doing this?" is bad. "What's pushing you to write this email today?" is good.
- Each question needs 3-4 short chips (2-5 words each) reflecting real, distinct human reasons — not corporate-speak
- Chips should feel honest and relatable — how someone would actually think about this
- Do NOT ask about things clearly stated in the task or description

Output JSON only, no preamble:
{"questions":[{"text":"Question 1?","chips":["Reason A","Reason B","Reason C"]},{"text":"Question 2?","chips":["Goal A","Goal B","Goal C"]}]}`;

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not configured', questions: [] }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const mission = (body?.mission || '').toString().trim();
  if (!mission) return json({ error: 'Missing mission' }, 400);

  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const currentSteps = Array.isArray(body?.currentSteps)
    ? body.currentSteps
        .map(s => typeof s?.title === 'string' ? s.title.trim() : '')
        .filter(Boolean)
    : [];

  const userContent = [
    `Task: "${mission}"`,
    description ? `Description: "${description}"` : null,
    currentSteps.length
      ? `Steps currently shown to the user:\n${currentSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : null,
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
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (err) {
    return json({ error: 'Upstream request failed: ' + err.message }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return json({ error: data?.error?.message || 'Claude API error' }, upstream.status);

  const text = data?.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: 'Could not parse model response', raw: text }, 502);

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { return json({ error: 'Invalid JSON from model' }, 502); }

  const questions = Array.isArray(parsed.questions)
    ? parsed.questions
        .filter(q => q && typeof q.text === 'string' && Array.isArray(q.chips) && q.chips.length > 0)
        .slice(0, 2)
        .map(q => ({
          text: q.text.trim(),
          chips: q.chips
            .filter(c => typeof c === 'string' && c.trim())
            .map(c => c.trim())
            .slice(0, 4),
        }))
    : [];

  return json({ questions }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
