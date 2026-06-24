// Vercel Edge function — generates 2 targeted clarifying questions to help
// regenerate better, more accurate steps for a specific task. Questions are
// task-specific (not generic), focused on the context Claude most needs:
// access/tools already in place, experience level, scope, or where in the
// task the user actually is. Requires ANTHROPIC_API_KEY in Vercel settings.

export const config = { runtime: 'edge' };

const QUESTIONS = [
  'What will you have when this is done?',
  'What do you already have, or where are you starting from?',
  'Is there anything specific that feels hard or unclear about this?',
];

const SYSTEM_PROMPT = `You generate chip answer options for 3 fixed questions in a task-planning app. For the given task, produce 3-4 short chip answers (2-5 words each) for each question:

Q1 — "What will you have when this is done?"
Chips = realistic completion states: the specific deliverable, artifact, or outcome for THIS task.

Q2 — "What do you already have, or where are you starting from?"
Chips = realistic starting points: blank slate, partial work, has some pieces, already started, etc.

Q3 — "Is there anything specific that feels hard or unclear about this?"
Chips = the most likely actual blockers for THIS task type — specific unknowns or missing pieces, not generic anxiety. Always include "Nothing, I'm clear" as the last chip.

Rules:
- Chips must be SPECIFIC to this exact task. "A document" is bad. "Drafted intro paragraph" is good.
- Honest and relatable — how someone actually thinks about their work, not formal language.
- 2-5 words per chip, 3-4 chips per question.

Output JSON only, no preamble:
{"chips":[["Q1 chip A","Q1 chip B","Q1 chip C"],["Q2 chip A","Q2 chip B","Q2 chip C"],["Q3 chip A","Q3 chip B","Q3 chip C","Nothing, I'm clear"]]}`;

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

  const rawChips = Array.isArray(parsed.chips) ? parsed.chips : [];
  const questions = QUESTIONS.map((text, i) => ({
    text,
    chips: (Array.isArray(rawChips[i]) ? rawChips[i] : [])
      .filter(c => typeof c === 'string' && c.trim())
      .map(c => c.trim())
      .slice(0, 4),
  })).filter(q => q.chips.length > 0);

  if (questions.length === 0) return json({ error: 'Could not parse chip options from model' }, 502);

  return json({ questions }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
