// Cloudflare Worker - Stream Index Proxy
// Tries multiple providers, falls back if one is blocked

const PROVIDERS = [
  {
    name: 'torrentio',
    baseUrl: 'https://torrentio.strem.fun',
    config: 'sort=qualitysize|qualityfilter=480p,scr,cam'
  },
  {
    name: 'comet',
    baseUrl: 'https://comet.elfhosted.com',
    config: ''
  },
  {
    name: 'mediafusion',
    baseUrl: 'https://mediafusion.elfhosted.com',
    config: ''
  }
];

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'stream-proxy', providers: PROVIDERS.map(p => p.name) });
    }

    // Stream search: /search?imdb=tt1375666&type=movie&season=1&episode=1&provider=torrentio
    if (url.pathname === '/search') {
      const imdbId = url.searchParams.get('imdb');
      const mediaType = url.searchParams.get('type') || 'movie';
      const season = url.searchParams.get('season');
      const episode = url.searchParams.get('episode');
      const preferredProvider = url.searchParams.get('provider');

      if (!imdbId) {
        return Response.json({ error: 'Missing imdb parameter' }, { status: 400 });
      }

      // Try each provider until one works
      const providersToTry = preferredProvider
        ? [PROVIDERS.find(p => p.name === preferredProvider), ...PROVIDERS.filter(p => p.name !== preferredProvider)].filter(Boolean)
        : PROVIDERS;

      for (const provider of providersToTry) {
        try {
          const streams = await fetchFromProvider(provider, imdbId, mediaType, season, episode);
          if (streams && streams.length > 0) {
            return Response.json(
              { success: true, provider: provider.name, streams },
              { headers: { 'Access-Control-Allow-Origin': '*' } }
            );
          }
        } catch (error) {
          console.log(`Provider ${provider.name} failed:`, error.message);
        }
      }

      return Response.json(
        { success: false, error: 'All providers failed or returned no streams' },
        { status: 503, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }

    // Test specific provider: /test?provider=torrentio
    if (url.pathname === '/test') {
      const providerName = url.searchParams.get('provider') || 'torrentio';
      const provider = PROVIDERS.find(p => p.name === providerName);

      if (!provider) {
        return Response.json({ error: 'Unknown provider' }, { status: 400 });
      }

      try {
        const streams = await fetchFromProvider(provider, 'tt1375666', 'movie', null, null);
        return Response.json({
          provider: provider.name,
          status: streams && streams.length > 0 ? 'working' : 'no_streams',
          streamCount: streams?.length || 0,
          sample: streams?.[0] || null
        }, { headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch (error) {
        return Response.json({
          provider: provider.name,
          status: 'error',
          error: error.message
        }, { headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
};

async function fetchFromProvider(provider, imdbId, mediaType, season, episode) {
  let endpoint;

  if (provider.config) {
    endpoint = `/${provider.config}/stream/${mediaType}/${imdbId}`;
  } else {
    endpoint = `/stream/${mediaType}/${imdbId}`;
  }

  if (mediaType === 'series' && season && episode) {
    endpoint += `:${season}:${episode}`;
  }
  endpoint += '.json';

  const targetUrl = `${provider.baseUrl}${endpoint}`;

  const response = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://web.stremio.com/',
      'Origin': 'https://web.stremio.com'
    }
  });

  const text = await response.text();

  // Check if we got HTML (blocked) instead of JSON
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html') || text.startsWith('Found')) {
    throw new Error('Blocked by provider');
  }

  const data = JSON.parse(text);

  // Return streams in Stremio format
  return (data.streams || []).map(s => ({
    name: s.name,
    title: s.title,
    description: s.description,
    url: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}` : s.url,
    infoHash: s.infoHash,
    fileIdx: s.fileIdx,
    behaviorHints: s.behaviorHints
  }));
}
