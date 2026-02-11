// Cloudflare Worker - Stream Index Proxy
// Deploy to: https://workers.cloudflare.com

const ALLOWED_ORIGINS = ['*']; // Restrict in production

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
      return Response.json({ status: 'ok', service: 'stream-proxy' });
    }

    // Stream search: /search?imdb=tt1375666&type=movie&season=1&episode=1
    if (url.pathname === '/search') {
      const imdbId = url.searchParams.get('imdb');
      const mediaType = url.searchParams.get('type') || 'movie';
      const season = url.searchParams.get('season');
      const episode = url.searchParams.get('episode');

      if (!imdbId) {
        return Response.json({ error: 'Missing imdb parameter' }, { status: 400 });
      }

      const config = 'sort=qualitysize|qualityfilter=480p,scr,cam';
      let endpoint = `/${config}/stream/${mediaType}/${imdbId}`;

      if (mediaType === 'series' && season && episode) {
        endpoint += `:${season}:${episode}`;
      }
      endpoint += '.json';

      const targetUrl = `https://torrentio.strem.fun${endpoint}`;

      try {
        const response = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json'
          }
        });

        const data = await response.json();

        // Return streams in same format as torrentio (for StremioStream compatibility)
        const streams = (data.streams || []).map(s => ({
          name: s.name,
          title: s.title,
          description: s.description,
          url: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}` : s.url,
          infoHash: s.infoHash,
          fileIdx: s.fileIdx,
          behaviorHints: s.behaviorHints
        }));

        return Response.json(
          { success: true, streams },
          { headers: { 'Access-Control-Allow-Origin': '*' } }
        );

      } catch (error) {
        return Response.json(
          { success: false, error: error.message },
          { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
        );
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
};
