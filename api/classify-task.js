// Vercel Edge function — classifies a task into one of four categories used
// by the Small Chunker "Work With Me" video picker. Uses broad contextual
// understanding (not keyword matching) and is generous with computer_work.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const CATEGORIES = ['computer_work', 'cleaning', 'studying', 'general'];

const SYSTEM_PROMPT = `You are a task classifier. Given a task title and optional description, classify the task into exactly one of these four categories:

computer_work — any task that would typically require or involve a computer, phone, or screen. Be generous with this category. If the task involves writing, reading online, designing, coding, editing, communicating digitally, researching, admin, scheduling, creative work on a device, or anything where someone would sit at a desk with a screen, classify it as computer_work.

cleaning — any task involving physical cleaning, tidying, organizing a physical space, laundry, dishes, or household chores.

studying — any task involving learning, memorizing, reviewing notes, homework, exam prep, or academic work that does not clearly require a computer.

general — anything that does not clearly fit the above three categories.

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
