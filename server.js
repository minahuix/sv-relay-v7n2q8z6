const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================
// HASHLAND RELAY SERVER
// Handles: SharePlay, Streams, Library, Auth
// All API keys stay here - clients never see them
// ============================================

const PORT = process.env.PORT || 8080;

// API Keys (stored in environment variables on Render)
const API_KEYS = {
    tmdb: process.env.TMDB_API_KEY || '1f54bd990f1cdfb230adb312546d765d',
    debrid: process.env.DEBRID_API_KEY || '21vctawafWMED4R3NgrQB-8l0W-cJ6ZORuobWmn-ZcHKZ14vWtsYoKe80n8N-gyp',
};

const DEBRID_BASE_URL = 'https://debrid-link.com/api/v2';

// User database (in production, use a real DB)
const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LIBRARIES_FILE = path.join(DATA_DIR, 'libraries.json');

// Load/Save helpers
function loadJSON(file, defaultVal = {}) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { console.error('Load error:', e); }
    return defaultVal;
}
function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Initialize data
let users = loadJSON(USERS_FILE, {
    hash: { password: 'hashed_123', role: 'admin', displayName: 'Hash', authorityRank: 100 },
    minah: { password: 'hashed_minah123', role: 'viewer', displayName: 'Minah', authorityRank: 30 },
    min: { password: 'hashed_123', role: 'cohost', displayName: 'Min', authorityRank: 50 },
});
let libraries = loadJSON(LIBRARIES_FILE, { hash: [], minah: [], min: [] });

// Active sessions for auth tokens
const authTokens = new Map(); // token -> { userId, expiresAt }
const onlineUsers = new Map(); // userId -> { ws, lastSeen, status }

// ============================================
// HTTP SERVER (REST API)
// ============================================
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Parse body for POST/PUT
    let body = '';
    if (method === 'POST' || method === 'PUT') {
        body = await new Promise(resolve => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => resolve(data));
        });
    }

    try {
        // ========== AUTH ==========
        if (pathname === '/auth/login' && method === 'POST') {
            const { username, password } = JSON.parse(body);
            const user = users[username.toLowerCase()];

            if (user && user.password === `hashed_${password}`) {
                const token = crypto.randomBytes(32).toString('hex');
                authTokens.set(token, {
                    userId: username.toLowerCase(),
                    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
                });
                sendJSON(res, {
                    success: true,
                    token,
                    user: {
                        id: username.toLowerCase(),
                        displayName: user.displayName,
                        role: user.role,
                        authorityRank: user.authorityRank
                    }
                });
            } else {
                sendJSON(res, { success: false, error: 'Invalid credentials' }, 401);
            }
            return;
        }

        if (pathname === '/auth/verify' && method === 'GET') {
            const auth = verifyAuth(req);
            if (auth) {
                const user = users[auth.userId];
                sendJSON(res, {
                    valid: true,
                    user: {
                        id: auth.userId,
                        displayName: user.displayName,
                        role: user.role,
                        authorityRank: user.authorityRank
                    }
                });
            } else {
                sendJSON(res, { valid: false }, 401);
            }
            return;
        }

        // ========== STREAMS ==========

        // Stream Search - Returns list of available streams (for local debrid resolution)
        if (pathname === '/streams/search' && method === 'POST') {
            const auth = verifyAuth(req);
            if (!auth) return sendJSON(res, { error: 'Unauthorized' }, 401);

            const { imdbId, mediaType, season, episode } = JSON.parse(body);
            console.log(`[Stream Search] ${auth.userId} searching: ${imdbId} (${mediaType})`);

            const streams = await searchStreams(imdbId, mediaType, season, episode);
            sendJSON(res, { success: true, streams });
            return;
        }

        // Stream Resolve - Full resolution (search + debrid) for thin clients
        if (pathname === '/streams/resolve' && method === 'POST') {
            const auth = verifyAuth(req);
            if (!auth) return sendJSON(res, { error: 'Unauthorized' }, 401);

            const { tmdbId, mediaType, title, season, episode } = JSON.parse(body);

            console.log(`[Stream] Resolving for ${auth.userId}: ${title} (${tmdbId})`);

            // This is where all the secret magic happens
            // Client just asks "give me stream for Interstellar"
            // Server does: stream search -> debrid -> clean URL
            const streamResult = await resolveStream(tmdbId, mediaType, title, season, episode);

            if (streamResult) {
                sendJSON(res, { success: true, stream: streamResult });
            } else {
                sendJSON(res, { success: false, error: 'No streams found' }, 404);
            }
            return;
        }

        // ========== LIBRARY ==========
        if (pathname === '/library' && method === 'GET') {
            const auth = verifyAuth(req);
            if (!auth) return sendJSON(res, { error: 'Unauthorized' }, 401);

            sendJSON(res, { library: libraries[auth.userId] || [] });
            return;
        }

        if (pathname === '/library' && method === 'POST') {
            const auth = verifyAuth(req);
            if (!auth) return sendJSON(res, { error: 'Unauthorized' }, 401);

            const { item } = JSON.parse(body);
            if (!libraries[auth.userId]) libraries[auth.userId] = [];
            libraries[auth.userId].push({ ...item, addedAt: Date.now() });
            saveJSON(LIBRARIES_FILE, libraries);

            sendJSON(res, { success: true });
            return;
        }

        if (pathname.startsWith('/library/') && method === 'DELETE') {
            const auth = verifyAuth(req);
            if (!auth) return sendJSON(res, { error: 'Unauthorized' }, 401);

            const itemId = pathname.split('/')[2];
            if (libraries[auth.userId]) {
                libraries[auth.userId] = libraries[auth.userId].filter(i => i.id !== parseInt(itemId));
                saveJSON(LIBRARIES_FILE, libraries);
            }
            sendJSON(res, { success: true });
            return;
        }

        // ========== TMDB PROXY (hides API key) ==========
        if (pathname.startsWith('/tmdb/')) {
            const auth = verifyAuth(req);
            if (!auth) return sendJSON(res, { error: 'Unauthorized' }, 401);

            const tmdbPath = pathname.replace('/tmdb', '');
            const tmdbUrl = `https://api.themoviedb.org/3${tmdbPath}?api_key=${API_KEYS.tmdb}&${parsedUrl.query ? new URLSearchParams(parsedUrl.query).toString() : ''}`;

            const tmdbData = await fetchJSON(tmdbUrl);
            sendJSON(res, tmdbData);
            return;
        }

        // ========== ADMIN ENDPOINTS (Hash only) ==========
        if (pathname.startsWith('/admin/')) {
            const auth = verifyAuth(req);
            if (!auth || users[auth.userId].role !== 'admin') {
                return sendJSON(res, { error: 'Admin access required' }, 403);
            }

            // Get all users status
            if (pathname === '/admin/users' && method === 'GET') {
                const userList = Object.entries(users).map(([id, u]) => ({
                    id,
                    displayName: u.displayName,
                    role: u.role,
                    authorityRank: u.authorityRank,
                    online: onlineUsers.has(id),
                    lastSeen: onlineUsers.get(id)?.lastSeen,
                    libraryCount: (libraries[id] || []).length
                }));
                sendJSON(res, { users: userList });
                return;
            }

            // Get specific user's library (for remote management)
            if (pathname.startsWith('/admin/library/') && method === 'GET') {
                const userId = pathname.split('/')[3];
                sendJSON(res, { library: libraries[userId] || [] });
                return;
            }

            // Add item to user's library remotely
            if (pathname.startsWith('/admin/library/') && method === 'POST') {
                const userId = pathname.split('/')[3];
                const { item } = JSON.parse(body);
                if (!libraries[userId]) libraries[userId] = [];
                libraries[userId].push({ ...item, addedAt: Date.now(), addedBy: 'admin' });
                saveJSON(LIBRARIES_FILE, libraries);
                sendJSON(res, { success: true });
                return;
            }

            // Remove item from user's library remotely
            if (pathname.startsWith('/admin/library/') && method === 'DELETE') {
                const parts = pathname.split('/');
                const userId = parts[3];
                const itemId = parts[4];
                if (libraries[userId]) {
                    libraries[userId] = libraries[userId].filter(i => i.id !== parseInt(itemId));
                    saveJSON(LIBRARIES_FILE, libraries);
                }
                sendJSON(res, { success: true });
                return;
            }
        }

        // ========== HEALTH CHECK ==========
        if (pathname === '/health') {
            sendJSON(res, { status: 'ok', uptime: process.uptime() });
            return;
        }

        // 404
        sendJSON(res, { error: 'Not found' }, 404);

    } catch (error) {
        console.error('Server error:', error);
        sendJSON(res, { error: 'Internal server error' }, 500);
    }
});

// ============================================
// WEBSOCKET SERVER (SharePlay)
// ============================================
const wss = new WebSocket.Server({ server });

const sessions = new Map(); // sessionId -> Set<WebSocket>

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    console.log('[WS] New client connected');

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            const { type, sessionId, senderId, payload } = message;

            // Track online users
            if (senderId) {
                onlineUsers.set(senderId.toLowerCase(), {
                    ws,
                    lastSeen: Date.now(),
                    status: 'online'
                });
            }

            if (!sessionId) return;

            // Handle session management
            if (!sessions.has(sessionId)) {
                sessions.set(sessionId, new Set());
                console.log(`[WS] Created session: ${sessionId}`);
            }

            const sessionClients = sessions.get(sessionId);

            if (!sessionClients.has(ws)) {
                sessionClients.add(ws);
                ws.sessionId = sessionId;
                ws.userId = senderId;
                console.log(`[WS] ${senderId} joined session: ${sessionId}`);
            }

            // Relay to all other clients in session
            sessionClients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(message));
                }
            });

            // Handle leave
            if (type === 'leave') {
                sessionClients.delete(ws);
                if (sessionClients.size === 0) {
                    sessions.delete(sessionId);
                    console.log(`[WS] Session ${sessionId} removed`);
                }
            }

        } catch (e) {
            console.error('[WS] Error:', e);
        }
    });

    ws.on('close', () => {
        if (ws.sessionId && sessions.has(ws.sessionId)) {
            sessions.get(ws.sessionId).delete(ws);
            if (sessions.get(ws.sessionId).size === 0) {
                sessions.delete(ws.sessionId);
            }
        }
        if (ws.userId) {
            onlineUsers.delete(ws.userId.toLowerCase());
        }
        console.log('[WS] Client disconnected');
    });
});

// Heartbeat
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ============================================
// HELPER FUNCTIONS
// ============================================

function sendJSON(res, data, statusCode = 200) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function verifyAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7);
    const session = authTokens.get(token);

    if (!session || session.expiresAt < Date.now()) {
        authTokens.delete(token);
        return null;
    }
    return session;
}

async function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// ============================================
// STREAM RESOLUTION (The Secret Sauce)
// This is where all the magic happens
// Client never sees stream source URLs
// ============================================

// Stream Index URL (kept on server only)
const STREAM_INDEX_URL = 'https://torrentio.strem.fun';
const STREAM_INDEX_CONFIG = 'sort=qualitysize|qualityfilter=480p,scr,cam';

// Search streams - returns list for local debrid resolution
async function searchStreams(imdbId, mediaType, season, episode) {
    try {
        const typeStr = mediaType === 'movie' ? 'movie' : 'series';
        let endpoint = `/${STREAM_INDEX_CONFIG}/stream/${typeStr}/${imdbId}`;

        if (mediaType === 'series' && season && episode) {
            endpoint += `:${season}:${episode}`;
        }
        endpoint += '.json';

        const url = `${STREAM_INDEX_URL}${endpoint}`;
        console.log(`[Search] Fetching: ${url}`);

        const response = await fetchJSON(url);

        if (!response.streams || response.streams.length === 0) {
            console.log('[Search] No streams found');
            return [];
        }

        // Convert to clean format with source links constructed on server
        const streams = response.streams.map(s => ({
            name: s.name,
            title: s.title,
            quality: s.name?.match(/\d{3,4}p/)?.[0] || null,
            size: s.title?.match(/💾\s*([\d.]+\s*GB)/)?.[1] || null,
            // Server constructs the full source link - client never sees the protocol
            source: s.infoHash ? `magnet:?xt=urn:btih:${s.infoHash}` : s.url,
            infoHash: s.infoHash,
            fileIdx: s.fileIdx
        }));

        console.log(`[Search] Found ${streams.length} streams`);
        return streams;

    } catch (error) {
        console.error('[Search] Error:', error.message);
        return [];
    }
}

async function resolveStream(tmdbId, mediaType, title, season, episode) {
    console.log(`[Resolve] Starting for: ${title} (${mediaType})`);

    try {
        // Step 0: Get IMDB ID from TMDB (Torrentio uses IMDB IDs)
        const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${API_KEYS.tmdb}`;
        console.log(`[Resolve] Getting IMDB ID from TMDB...`);
        const externalIds = await fetchJSON(tmdbUrl);
        const imdbId = externalIds.imdb_id;

        if (!imdbId) {
            console.log('[Resolve] No IMDB ID found');
            return null;
        }
        console.log(`[Resolve] Got IMDB ID: ${imdbId}`);

        // Step 1: Search streams via Stream Index (using IMDB ID)
        const streamUrl = mediaType === 'movie'
            ? `${STREAM_INDEX_URL}/${STREAM_INDEX_CONFIG}/stream/movie/${imdbId}.json`
            : `${STREAM_INDEX_URL}/${STREAM_INDEX_CONFIG}/stream/series/${imdbId}:${season}:${episode}.json`;
        const torrentioUrl = streamUrl;

        console.log(`[Resolve] Fetching: ${torrentioUrl}`);
        const torrents = await fetchJSON(torrentioUrl);

        if (!torrents.streams || torrents.streams.length === 0) {
            console.log('[Resolve] No torrents found');
            return null;
        }

        // Find best quality stream (prefer 1080p/4K with good seeds)
        const bestStream = torrents.streams.find(s =>
            s.name?.includes('1080p') || s.name?.includes('2160p') || s.name?.includes('4K')
        ) || torrents.streams[0];

        console.log(`[Resolve] Selected: ${bestStream.name || bestStream.title}`);

        // Step 2: If we have debrid API key, resolve through debrid
        if (API_KEYS.debrid && bestStream.infoHash) {
            const magnet = `magnet:?xt=urn:btih:${bestStream.infoHash}`;
            const debridUrl = await resolveDebrid(magnet);
            if (debridUrl) {
                console.log('[Resolve] ✅ Got debrid URL - returning clean stream');
                return {
                    type: 'url',
                    url: debridUrl,
                    name: bestStream.name,
                    quality: bestStream.name?.match(/\d{3,4}p/)?.[0] || '1080p',
                    size: bestStream.title?.match(/💾\s*([\d.]+\s*GB)/)?.[1] || 'Unknown'
                };
            }
        }

        // Step 3: Return direct stream URL if available
        if (bestStream.url) {
            console.log('[Resolve] Using direct URL');
            return { type: 'url', url: bestStream.url };
        }

        // Step 4: Return magnet link for client-side debrid resolution
        if (bestStream.infoHash) {
            const magnet = `magnet:?xt=urn:btih:${bestStream.infoHash}&dn=${encodeURIComponent(bestStream.behaviorHints?.filename || 'video')}`;
            console.log('[Resolve] Returning magnet for client debrid');
            return {
                type: 'magnet',
                magnet: magnet,
                name: bestStream.name,
                quality: bestStream.name?.match(/\d{3,4}p/)?.[0] || '1080p',
                size: bestStream.title?.match(/💾\s*([\d.]+\s*GB)/)?.[1] || 'Unknown'
            };
        }

        return null;

    } catch (error) {
        console.error('[Resolve] Error:', error);
        return null;
    }
}

async function resolveDebrid(magnetLink) {
    if (!API_KEYS.debrid) {
        console.log('[Debrid] No API key configured');
        return null;
    }

    try {
        console.log('[Debrid] Adding magnet to seedbox...');

        // Step 1: Add magnet to seedbox
        const addResponse = await fetch(`${DEBRID_BASE_URL}/seedbox/add`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEYS.debrid}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `url=${encodeURIComponent(magnetLink)}&async=true`
        });

        const addData = await addResponse.json();
        console.log('[Debrid] Add response:', addData.success ? 'SUCCESS' : addData.error);

        if (!addData.success || !addData.value) {
            console.error('[Debrid] Failed to add magnet:', addData.error);
            return null;
        }

        const torrentId = addData.value.id;
        console.log('[Debrid] Torrent ID:', torrentId);

        // Step 2: Poll for completion (max 60 seconds)
        let attempts = 0;
        const maxAttempts = 120; // 60 seconds
        let torrent = addData.value;

        while (torrent.status !== 100 && (!torrent.files || torrent.files.length === 0)) {
            if (attempts >= maxAttempts) {
                console.log('[Debrid] Timeout waiting for torrent');
                break;
            }

            await new Promise(r => setTimeout(r, 500)); // Wait 0.5s
            attempts++;

            // Check status
            const listResponse = await fetch(`${DEBRID_BASE_URL}/seedbox/list?ids=${torrentId}`, {
                headers: { 'Authorization': `Bearer ${API_KEYS.debrid}` }
            });
            const listData = await listResponse.json();

            if (listData.success && listData.value && listData.value.length > 0) {
                torrent = listData.value[0];
                if (attempts % 10 === 0) {
                    console.log(`[Debrid] Status: ${torrent.status}%, files: ${torrent.files?.length || 0}`);
                }
            }
        }

        // Step 3: Get the largest video file
        if (!torrent.files || torrent.files.length === 0) {
            console.log('[Debrid] No files in torrent');
            return null;
        }

        // Find largest video file
        const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm'];
        let bestFile = null;
        let maxSize = 0;

        for (const file of torrent.files) {
            const isVideo = videoExtensions.some(ext =>
                file.name?.toLowerCase().endsWith(ext)
            );
            if (isVideo && file.size > maxSize) {
                maxSize = file.size;
                bestFile = file;
            }
        }

        // Fallback to largest file if no video found
        if (!bestFile) {
            bestFile = torrent.files.reduce((a, b) => (a.size > b.size ? a : b));
        }

        if (bestFile && bestFile.downloadUrl) {
            console.log(`[Debrid] ✅ Got stream URL for: ${bestFile.name} (${(bestFile.size / 1024 / 1024 / 1024).toFixed(2)} GB)`);
            return bestFile.downloadUrl;
        }

        console.log('[Debrid] No download URL found');
        return null;

    } catch (error) {
        console.error('[Debrid] Error:', error.message);
        return null;
    }
}

// ============================================
// START SERVER
// ============================================
server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           HASHLAND RELAY SERVER v1.1                          ║
║═══════════════════════════════════════════════════════════════║
║  HTTP API:    http://localhost:${PORT}                           ║
║  WebSocket:   ws://localhost:${PORT}                             ║
║                                                               ║
║  Endpoints:                                                   ║
║    POST /auth/login        - Login                           ║
║    GET  /auth/verify       - Verify token                    ║
║    POST /streams/search    - Search streams (for local mode) ║
║    POST /streams/resolve   - Full resolution (thin client)   ║
║    GET  /library           - Get user library                ║
║    POST /library           - Add to library                  ║
║    GET  /tmdb/*            - TMDB proxy (hides API key)      ║
║    GET  /admin/users       - List all users (admin only)     ║
║    *    /admin/library/*   - Manage user libraries           ║
║                                                               ║
║  Users: hash (admin), minah (viewer), min (cohost)           ║
╚═══════════════════════════════════════════════════════════════╝
    `);
    saveJSON(USERS_FILE, users);
    saveJSON(LIBRARIES_FILE, libraries);
});

