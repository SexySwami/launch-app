// Vercel Edge function — asks Claude to break a mission into 15 ADHD-friendly micro-steps.
// Requires ANTHROPIC_API_KEY env var in Vercel project settings.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are an ADHD task re-chunking engine. Your only goal is to reduce the
distance between the user and taking action. You do not optimize for
efficiency or logical planning. You optimize for reducing activation energy,
reducing resistance, and creating immediate momentum.

When given a task title and optional description, generate exactly 15 micro
steps following ALL of these rules:

CHUNKING RULES:
1. EMOTIONALLY SAFE FIRST STEP — The very first step must feel obvious,
   low-stakes, fast, and easy to begin. If it requires motivation, confidence,
   or mental preparation, it is still too big. Break it down further.

2. NO VAGUE VERBS — Never use words like: organize, research, brainstorm,
   figure out, prepare, optimize, work on, improve, or plan. Convert every
   abstract action into a specific physical or observable action. Bad:
   "Research competitors." Good: "Open Google. Search competitor name."

3. BINARY TASKS ONLY — Every step must have a clear beginning and a clear
   end. The user must always know when they started and when they finished.
   Bad: "Practice violin." Good: "Open violin case."

4. CHUNK FOR LOW DOPAMINE STATES — Assume the user is tired, anxious,
   distracted, or emotionally overwhelmed. Every step must be completable
   in a low-functioning mental state. If not, reduce complexity, duration,
   decisions, and setup requirements further.

5. OPTIMIZE FOR MOMENTUM NOT EFFICIENCY — Small completed actions create
   dopamine and reduce inertia. The goal is movement, not perfection.
   Bad: "Write marketing strategy." Good: "Open document. Write one
   ugly headline."

6. USE GATEWAY TASKS — Begin with ultra-low-resistance actions that bypass
   avoidance and create motion. Examples: open the app, sit at desk, open
   the document, plug in headphones. The first 2 to 3 steps should feel
   almost too easy.

7. SURFACE HIDDEN DEPENDENCIES — Identify invisible sub-requirements and
   surface them as explicit steps. If a task secretly requires finding files,
   making decisions, or gathering information first, those steps must appear
   before the main action steps.

8. ACTION-BASED NOT TIME-BASED — Never say "work for X minutes." Always
   define completion by a specific observable output. Bad: "Work for 10
   minutes." Good: "Write one sentence."

9. ASK INTERNALLY BEFORE WRITING EACH STEP:
   - Is this step vague?
   - Does it contain hidden decisions?
   - Is the first action emotionally difficult?
   - Does it require too much working memory?
   - Is it physically actionable?
   - Can it be completed quickly?
   - Would this feel overwhelming to someone with ADHD?
   - Can it become more binary and concrete?

FORMATTING RULES:
- Generate exactly 15 steps.
- Each step title: maximum 5 to 7 words, specific and action-based.
- Each step description: maximum 10 words, plain and direct.
- Steps should build gradually from gateway tasks at the start to
  slightly more involved actions toward the end.
- Return only a JSON array of 15 objects each with a title and
  description field. No explanation, no markdown, no bullet points.`;

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
        max_tokens: 2000,
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
  if (raw.length !== 15) {
    return json({ error: `Expected 15 steps, got ${raw.length}`, raw: text }, 502);
  }

  const steps = raw.map((s) => ({
    title: typeof s?.title === 'string' ? s.title.trim() : '',
    description: typeof s?.description === 'string' ? s.description.trim() : '',
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
