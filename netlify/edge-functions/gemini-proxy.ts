/**
 * Gemini API proxy — runs as a Netlify Edge Function (Deno runtime).
 *
 * - API key never reaches the browser
 * - Streams SSE responses directly from Google → client
 * - CORS headers allow the SPA to call /api/gemini/* from any origin
 *
 * Required Netlify environment variable (set in Netlify UI, NOT in netlify.toml):
 *   GEMINI_API_KEY = AIza...
 *
 * The @google/genai SDK is configured with:
 *   httpOptions: { baseUrl: `${origin}/api/gemini` }
 * so every SDK call arrives here as:
 *   POST /api/gemini/v1beta/models/<model>:generateContent?key=via-proxy
 * We strip the fake key and inject the real server-side one.
 */

export default async (request: Request): Promise<Response> => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'GEMINI_API_KEY is not configured on the server.' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } },
    );
  }

  try {
    // Strip the /api/gemini prefix to get the real Gemini API path
    const incoming = new URL(request.url);
    const apiPath  = incoming.pathname.replace(/^\/api\/gemini/, '');

    // Rebuild query params: replace the fake 'via-proxy' key with the real one
    const params = new URLSearchParams(incoming.search);
    params.set('key', apiKey);

    const upstreamUrl = `https://generativelanguage.googleapis.com${apiPath}?${params.toString()}`;

    const upstream = await fetch(upstreamUrl, {
      method:  request.method,
      headers: { 'Content-Type': 'application/json' },
      body:    request.body,
    });

    // Pipe the response body (including SSE streams) straight back to the client
    return new Response(upstream.body, {
      status:  upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        ...CORS,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Proxy error', detail: String(err) }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } },
    );
  }
};
