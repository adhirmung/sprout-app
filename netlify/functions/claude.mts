import type { Config } from '@netlify/functions';

// Transparent proxy to Anthropic — API key never leaves the server
export default async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set on server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.text();

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
      'content-type':       'application/json',
    },
    body,
  });

  // Stream the response body straight through (handles both JSON and SSE streaming)
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type':                upstream.headers.get('content-type') ?? 'application/json',
      'access-control-allow-origin': '*',
    },
  });
};

export const config: Config = { path: '/api/v1/messages' };
