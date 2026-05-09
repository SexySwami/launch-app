// Vercel serverless function — proxies audio to OpenAI Whisper.
// Requires OPENAI_API_KEY environment variable to be set in Vercel project settings.

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({
      error: 'OPENAI_API_KEY is not configured. Add it as an environment variable in the Vercel project settings, then redeploy.',
    }, 500);
  }

  let audioFile;
  try {
    const formData = await request.formData();
    audioFile = formData.get('audio');
  } catch (err) {
    return json({ error: 'Could not parse multipart body: ' + err.message }, 400);
  }

  if (!audioFile || typeof audioFile === 'string') {
    return json({ error: 'No audio file in request' }, 400);
  }

  const upstream = new FormData();
  upstream.append('file', audioFile, audioFile.name || 'audio.webm');
  upstream.append('model', 'whisper-1');
  upstream.append('response_format', 'json');

  let upstreamRes;
  try {
    upstreamRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    });
  } catch (err) {
    return json({ error: 'Upstream request failed: ' + err.message }, 502);
  }

  const data = await upstreamRes.json().catch(() => ({}));
  if (!upstreamRes.ok) {
    return json({ error: data?.error?.message || 'Whisper API error', upstreamStatus: upstreamRes.status }, upstreamRes.status);
  }
  return json({ text: data.text || '' }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
