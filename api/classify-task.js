// Vercel Edge function — classifies a task into one of four categories used
// by the Small Chunker "Work With Me" video picker. Uses broad contextual
// understanding (not keyword matching), leans strongly toward computer_work
// (most tasks are screen-based), and reserves `general` for tasks that clearly
// happen away from a screen. Requires ANTHROPIC_API_KEY in Vercel settings.

export const config = { runtime: 'edge' };

const CATEGORIES = ['computer_work', 'cleaning', 'studying', 'general'];

const SYSTEM_PROMPT = `You are a task classifier for a focus app. Given a task title and optional description, classify it into exactly one of these four categories. Think about HOW and WHERE the person physically does the task — not just its topic.

computer_work — the task is done primarily at a desk or on a computer, phone, tablet, or any screen. Be very generous with this category: most modern tasks are screen-based even when they don't obviously involve writing or research. This includes planning, organizing information, budgeting, paying bills, booking or scheduling, online shopping, messaging or emailing, filling out or reviewing forms, managing accounts or files, looking something up, designing, coding, editing, or anything someone would reasonably do while sitting at a screen. When you are unsure whether a task touches a screen, choose computer_work.

studying — learning, memorizing, reviewing notes, homework, exam prep, reading, or academic work.

cleaning — physical cleaning, tidying, organizing a physical space, laundry, dishes, or household chores.

general — ONLY tasks that clearly happen away from any screen and are not cleaning or studying. Examples: physical errands, in-person activities, exercise, cooking, driving, going somewhere, making or fixing something by hand. Before choosing general, ask whether the task could reasonably be done at or with a screen — if it could, choose computer_work instead. Use general only when you are confident the task is not computer-related.

Return only the category name as a plain string. No explanation, no punctuation, no markdown.`;

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({
      error: 'ANTHROPIC_API_KEY is not configured. Add it as an environment variable in Vercel project settings, then redeploy.',
      category: 'general',
    }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body', category: 'general' }, 400); }

  const mission = (body?.mission || '').toString().trim();
  if (!mission) return json({ error: 'Missing mission', category: 'general' }, 400);
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
        max_tokens: 16,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (err) {
    return json({ error: 'Upstream request failed: ' + err.message, category: 'general' }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({ error: data?.error?.message || 'Claude API error', category: 'general' }, upstream.status);
  }

  const text = (data?.content?.[0]?.text || '').toLowerCase();
  const matched = CATEGORIES.find(c => text.includes(c)) || 'general';

  return json({ category: matched }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
