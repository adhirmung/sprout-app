/**
 * Anthropic API proxy — runs as a Netlify Edge Function (Deno runtime).
 *
 * - API key never reaches the browser
 * - Streams responses directly from Anthropic → client (SSE / text_stream)
 * - CORS headers allow the SPA to call /api/v1/messages from any origin
 *
 * Required Netlify environment variable (set in Netlify UI, NOT in netlify.toml):
 *   ANTHROPIC_API_KEY = sk-ant-...
 */

export default async (request: Request): Promise<Response> => {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // API key lives server-side only — never in the bundle
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const forwardHeaders: Record<string, string> = {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    };
    // Only forward anthropic-beta if the client actually sent it
    const betaHeader = request.headers.get('anthropic-beta');
    if (betaHeader) forwardHeaders['anthropic-beta'] = betaHeader;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: forwardHeaders,
      // Pipe the request body straight through — no buffering
      body: request.body,
    });

    // Pipe the upstream response (including SSE streams) straight back to the client
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type':                upstream.headers.get('content-type') ?? 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Proxy error', detail: String(err) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
