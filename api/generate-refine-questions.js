// Vercel Edge function — generates 2 targeted clarifying questions to help
// regenerate better, more accurate steps for a specific task. Questions are
// task-specific (not generic), focused on the context Claude most needs:
// access/tools already in place, experience level, scope, or where in the
// task the user actually is. Requires ANTHROPIC_API_KEY in Vercel settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a task-clarity engine for an ADHD focus app. Someone's AI-generated steps don't feel quite right. Your job is to generate exactly 2 clarifying questions whose answers would most change the steps Claude suggests next.

Look at the task and current steps carefully. Ask about the thing that is MOST AMBIGUOUS — the single piece of missing context that would most affect what the right next actions are.

Good question types (pick the 2 that matter most for THIS specific task):
- Access/tools: "Do you have [specific thing] you need?" — when the task requires a tool, account, file, or resource that may or may not be ready
- Experience: "How familiar are you with [specific aspect]?" — when the steps would be very different for a beginner vs. someone who's done it before
- Scope: "Which part are you focusing on?" — when the task is broad and a specific slice would make steps much more targeted
- Current state: "Where are you in this right now?" — when the task might already be partially done
- Physical context: "Are you at [location/device]?" — when the environment changes what steps are possible

Rules:
- Make questions SPECIFIC to the task — never generic. "How experienced are you?" is bad. "Have you used Notion's database feature before?" is good.
- Each question needs 3-4 short chips (2-5 words each) covering the most likely real situations
- Chips should be mutually exclusive and exhaustive for their question
- Do NOT ask about things already clear from the task title or description
- Do NOT ask about motivation, feelings, or reasons — only practical context

Output JSON only, no preamble:
{"questions":[{"text":"Question 1?","chips":["Option A","Option B","Option C"]},{"text":"Question 2?","chips":["Option A","Option B","Option C"]}]}`;

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
