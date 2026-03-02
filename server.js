const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const HTTP_PORT = 8003;
const ROOT = __dirname;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ---- Global safety net ------------------------------------------------------
// Never let an unhandled error kill the process.

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server still running):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server still running):', err);
});

// ---- MIME types -------------------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ---- Rate limiter (per-IP, sliding window) ----------------------------------

const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX = 30;           // 30 proxy requests per minute per IP
const MAX_TRACKED_IPS = 10_000;
const rateBuckets = new Map();  // ip -> [timestamps]

// Clean stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateBuckets) {
    const valid = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (valid.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, valid);
  }
}, 300_000);

function isRateLimited(ip) {
  const now = Date.now();
  let timestamps = rateBuckets.get(ip);
  if (!timestamps) {
    // Cap tracked IPs to prevent memory exhaustion from botnets
    if (rateBuckets.size >= MAX_TRACKED_IPS) {
      // Evict oldest entry
      const oldest = rateBuckets.keys().next().value;
      rateBuckets.delete(oldest);
    }
    timestamps = [];
    rateBuckets.set(ip, timestamps);
  }
  // Prune old entries
  while (timestamps.length > 0 && now - timestamps[0] > RATE_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_MAX) return true;
  timestamps.push(now);
  return false;
}

function getClientIP(req) {
  // Trust X-Forwarded-For from Caddy
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---- Proxy whitelist --------------------------------------------------------

const ALLOWED_PROXY_PATHS = ['/events', '/markets', '/tags'];

function isAllowedProxyPath(urlPath) {
  // urlPath is everything after /api, e.g. "/events?active=true..."
  const pathOnly = urlPath.split('?')[0];
  return ALLOWED_PROXY_PATHS.some(p => pathOnly === p || pathOnly.startsWith(p + '/'));
}

// ---- Blocked static paths ---------------------------------------------------

function isBlockedPath(urlPath) {
  const basename = path.basename(urlPath);
  // Block dotfiles, logs, shell scripts, pem files
  if (basename.startsWith('.')) return true;
  if (basename.endsWith('.log')) return true;
  if (basename.endsWith('.sh')) return true;
  if (basename.endsWith('.pem')) return true;
  // Block certs directory
  if (urlPath.startsWith('/certs')) return true;
  return false;
}

// ---- Safe response helper ---------------------------------------------------

function safeEnd(res, statusCode, body) {
  try {
    if (!res.headersSent) {
      res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    }
    res.end(body);
  } catch { /* client already gone */ }
}

// ---- Request handler --------------------------------------------------------

function handleRequest(req, res) {
  try {
    // Only allow GET and OPTIONS
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      safeEnd(res, 405, 'Method Not Allowed');
      return;
    }

    // CORS — restrict to our domain (browsers on same origin don't send Origin header, so allow that too)
    const origin = req.headers['origin'];
    if (ALLOWED_ORIGIN === '*' || origin === ALLOWED_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- API proxy (GET only, whitelisted paths, rate-limited) ----
    if (req.url.startsWith('/api/')) {
      const proxyPath = req.url.slice(4); // strip "/api"

      if (!isAllowedProxyPath(proxyPath)) {
        safeEnd(res, 403, 'Forbidden');
        return;
      }

      const clientIP = getClientIP(req);
      if (isRateLimited(clientIP)) {
        safeEnd(res, 429, 'Too Many Requests');
        return;
      }

      const target = 'https://gamma-api.polymarket.com' + proxyPath;
      const proxyReq = https.get(target, (proxyRes) => {
        const headers = {
          'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        };
        if (ALLOWED_ORIGIN === '*' || origin === ALLOWED_ORIGIN) {
          headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
        }
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
        proxyRes.on('error', () => safeEnd(res, 502, 'Bad Gateway'));
      });
      proxyReq.on('error', () => safeEnd(res, 502, 'Bad Gateway'));
      proxyReq.setTimeout(10_000, () => {
        proxyReq.destroy();
        safeEnd(res, 504, 'Gateway Timeout');
      });
      return;
    }

    // ---- Static file serving ----
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      safeEnd(res, 400, 'Bad Request');
      return;
    }

    if (urlPath === '/') {
      urlPath = '/index.html';
    }

    // Block sensitive files
    if (isBlockedPath(urlPath)) {
      safeEnd(res, 404, 'Not Found');
      return;
    }

    const filePath = path.join(ROOT, urlPath);

    // Prevent directory traversal
    if (!filePath.startsWith(ROOT)) {
      safeEnd(res, 403, 'Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        const indexPath = path.join(filePath, 'index.html');
        fs.stat(indexPath, (err2, stats2) => {
          if (err2 || !stats2.isFile()) {
            safeEnd(res, 404, 'Not Found');
            return;
          }
          serveFile(indexPath, res);
        });
        return;
      }
      serveFile(filePath, res);
    });
  } catch (err) {
    console.error('Request handler error:', err.message);
    safeEnd(res, 500, 'Internal Server Error');
  }
}

function serveFile(filePath, res) {
  const mimeType = getMimeType(filePath);
  const stream = fs.createReadStream(filePath);

  stream.on('error', () => safeEnd(res, 500, 'Internal Server Error'));

  res.writeHead(200, { 'Content-Type': mimeType });
  stream.pipe(res);
}

// ---- Start server -----------------------------------------------------------

const server = http.createServer(handleRequest);

// Kill idle connections after 30 seconds, headers must arrive within 10
server.timeout = 30_000;
server.headersTimeout = 10_000;

server.listen(HTTP_PORT, () => {
  console.log(`prediction-space running on http://0.0.0.0:${HTTP_PORT}`);
});
