const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const HTTP_PORT = 8003;
const ROOT = __dirname;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

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

// ---- Request handler --------------------------------------------------------

function handleRequest(req, res) {
  // Only allow GET and OPTIONS
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
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
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const clientIP = getClientIP(req);
    if (isRateLimited(clientIP)) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too Many Requests');
      return;
    }

    const target = 'https://gamma-api.polymarket.com' + proxyPath;
    https.get(target, (proxyRes) => {
      const headers = {
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
      };
      if (origin === ALLOWED_ORIGIN) {
        headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
      }
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }).on('error', () => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    });
    return;
  }

  // ---- Static file serving ----
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath === '/') {
    urlPath = '/index.html';
  }

  // Block sensitive files
  if (isBlockedPath(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const filePath = path.join(ROOT, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(filePath, 'index.html');
      fs.stat(indexPath, (err2, stats2) => {
        if (err2 || !stats2.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        serveFile(indexPath, res);
      });
      return;
    }
    serveFile(filePath, res);
  });
}

function serveFile(filePath, res) {
  const mimeType = getMimeType(filePath);
  const stream = fs.createReadStream(filePath);

  stream.on('error', () => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  });

  res.writeHead(200, { 'Content-Type': mimeType });
  stream.pipe(res);
}

// HTTP only — Caddy handles TLS termination
http.createServer(handleRequest).listen(HTTP_PORT, () => {
  console.log(`prediction-space running on http://0.0.0.0:${HTTP_PORT}`);
});
