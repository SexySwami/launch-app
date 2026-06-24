// Vercel Edge function — generates task-specific clarifying questions and chips
// to help regenerate more accurate steps for the given task.
// Uses claude-haiku-4-5 for speed (single focused judgment call).
// Requires ANTHROPIC_API_KEY in Vercel settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You generate clarifying questions for a task-planning app. Given a task, output exactly 3 short questions — one per category, always in this order — each with 3-4 task-specific answer chips.

Category order (always follow this):
1. END STATE — what will the user have when this is done? A specific deliverable, artifact, or outcome. Not "done" generically — the actual thing.
2. STARTING POINT — what do they already have, or where are they starting from? Could be 0% to nearly done.
3. STUCK POINT — what part specifically feels hard or unclear? Specific to this task type, not generic anxiety.

Rules for question text:
- One short sentence, conversational, not clinical
- Make it SPECIFIC to this exact task — not a template
- Don't ask "why" — ask about outputs, starting points, or blocks
- Don't ask process questions ("how do you usually do this?")

Rules for chips:
- 3-4 chips per question, 2-5 words each
- Specific to this task — not generic filler
- Honest and relatable — how someone actually thinks about their work
- For the STUCK POINT question, always include "Nothing, I'm clear" as the last chip

Return JSON only, no preamble:
{"questions":[{"text":"End state question?","chips":["Option A","Option B","Option C"]},{"text":"Starting point question?","chips":["Option A","Option B","Option C"]},{"text":"Stuck point question?","chips":["Option A","Option B","Option C","Nothing, I'm clear"]}]}`;

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
        model: 'claude-haiku-4-5',
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

  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
  const questions = rawQuestions
    .filter(q => typeof q?.text === 'string' && q.text.trim() && Array.isArray(q.chips))
    .map(q => ({
      text: q.text.trim(),
      chips: q.chips
        .filter(c => typeof c === 'string' && c.trim())
        .map(c => c.trim())
        .slice(0, 4),
    }))
    .filter(q => q.chips.length > 0)
    .slice(0, 3);

  if (questions.length === 0) return json({ error: 'Could not parse questions from model' }, 502);

  return json({ questions }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
