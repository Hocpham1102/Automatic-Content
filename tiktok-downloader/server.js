/**
 * TikSave – Local Proxy Server
 * Chạy: node server.js
 * Mở trình duyệt: http://localhost:3000
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

// ── MIME types ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
};

// ── Fetch helper (wraps https.get với redirect support) ──────
function httpsGet(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.tiktok.com/',
        ...(options.headers || {}),
      },
    };

    const makeRequest = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, reqOptions, (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return makeRequest(res.headers.location);
        }
        resolve(res);
      }).on('error', reject);
    };

    makeRequest(targetUrl);
  });
}

// ── Parse JSON from https ────────────────────────────────────
function fetchJson(targetUrl) {
  return new Promise((resolve, reject) => {
    httpsGet(targetUrl).then(res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).catch(reject);
  });
}

// ── Send JSON response ───────────────────────────────────────
function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ── Main server ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  // -- OPTIONS preflight --
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  // ── GET / → serve index.html ─────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── GET /api/info?url=<tiktok_url> ───────────────────────
  if (pathname === '/api/info') {
    const tiktokUrl = query.url;
    if (!tiktokUrl) return sendJson(res, { error: 'Missing url param' }, 400);

    try {
      const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
      const data = await fetchJson(apiUrl);
      sendJson(res, data);
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return;
  }

  // ── GET /api/download?url=<video_url>&filename=<name> ────
  if (pathname === '/api/download') {
    const videoUrl = query.url;
    const filename = query.filename || 'tiktok_video.mp4';

    if (!videoUrl) return sendJson(res, { error: 'Missing url param' }, 400);

    try {
      const upstream = await httpsGet(videoUrl);

      const contentType = upstream.headers['content-type'] || 'video/mp4';
      const contentLen  = upstream.headers['content-length'];

      const headers = {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      };
      if (contentLen) headers['Content-Length'] = contentLen;

      res.writeHead(200, headers);
      upstream.pipe(res);
      upstream.on('error', () => res.end());
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }
    return;
  }

  // ── Static files ─────────────────────────────────────────
  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✅  TikSave server đang chạy tại: http://localhost:${PORT}\n`);
  console.log(`   Mở trình duyệt và truy cập: http://localhost:${PORT}`);
  console.log(`   Nhấn Ctrl+C để dừng server.\n`);
});
