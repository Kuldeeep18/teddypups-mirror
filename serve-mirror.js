// Local server for the ./mirror copy of puppy.instabizweb.com.
//   node serve-mirror.js        -> http://localhost:4173
//   PORT=8080 node serve-mirror.js
// Plain static serving plus the two things a Next.js build expects from its host:
// the /_next/image optimiser (served here as the original file, unresized) and
// RSC requests (answered from payloads recorded by tools/record_rsc.js; anything
// unrecorded gets a 404, which makes the router fall back to a full page load).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { rscKey } = require('./rsc-key');

const ROOT = path.join(__dirname, 'mirror');
const PORT = Number(process.env.PORT) || 4173;

let rscIndex = {};
try {
  rscIndex = JSON.parse(fs.readFileSync(path.join(ROOT, '_rsc', 'index.json'), 'utf8'));
} catch {
  console.warn('No recorded RSC payloads; links will do full page loads (run tools/record_rsc.js)');
}

// The live CDN ignores the query string on RSC requests, so fall back to the bare route
function findRsc(url, headers) {
  const key = rscKey(url, headers);
  const [route, kind] = key.split('|');
  const file = rscIndex[key] || rscIndex[`${route.split('?')[0]}|${kind}`];
  return file && path.join(ROOT, '_rsc', file);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

function resolve(urlPath) {
  const file = path.normalize(path.join(ROOT, decodeURIComponent(urlPath)));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  for (const candidate of [file, path.join(file, 'index.html'), file + '.html']) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function send(req, res, file, status = 200) {
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };

  // Range support so <video> can seek
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && status === 200) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function notFound(req, res) {
  const page = path.join(ROOT, '404.html');
  if (fs.existsSync(page)) return send(req, res, page, 404);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.headers.rsc || url.searchParams.has('_rsc')) {
    const file = findRsc(url, req.headers);
    if (file) {
      res.writeHead(200, { 'Content-Type': 'text/x-component', 'Cache-Control': 'no-cache', Vary: 'RSC, Next-Router-Prefetch, Next-Router-Segment-Prefetch' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end();
  }

  if (url.pathname === '/_next/image') {
    const src = url.searchParams.get('url') || '';
    if (/^https?:\/\//.test(src)) {
      res.writeHead(302, { Location: src });
      return res.end();
    }
    const file = src.startsWith('/') && resolve(src);
    return file ? send(req, res, file) : notFound(req, res);
  }

  const file = resolve(url.pathname);
  if (file) return send(req, res, file);
  // the live site has no admin or API here; say so instead of serving a page
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'API is not available in the offline mirror' }));
  }
  notFound(req, res);
}).listen(PORT, () => {
  console.log(`Mirror of puppy.instabizweb.com at http://localhost:${PORT}`);
});
