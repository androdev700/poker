import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_DIR = path.join(ROOT, 'client');

const MOUNTS = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared'), cache: 'no-cache' },
  { prefix: '/vendor/three/', dir: path.join(ROOT, 'node_modules', 'three', 'build'), cache: 'public, max-age=31536000, immutable' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  });
  res.end(res.req.method === 'HEAD' ? undefined : text);
}

function sendJson(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function resolveStatic(pathname) {
  if (pathname === '/') return { dir: CLIENT_DIR, rel: 'index.html', cache: 'no-cache' };
  const mount = MOUNTS.find((m) => pathname.startsWith(m.prefix));
  if (mount) return { dir: mount.dir, rel: pathname.slice(mount.prefix.length), cache: mount.cache };
  return { dir: CLIENT_DIR, rel: pathname.slice(1), cache: 'no-cache' };
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (decoded.includes('\0')) return sendText(res, 400, 'Bad request');

  const { dir, rel, cache } = resolveStatic(decoded);
  const filePath = path.resolve(dir, rel);
  if (filePath !== dir && !filePath.startsWith(dir + path.sep)) return sendText(res, 400, 'Bad request');

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'Not found');

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
    'Last-Modified': stat.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function createHttpServer({ getInfo }) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendText(res, 400, 'Bad request');
    }

    if (pathname === '/api/info') return sendJson(res, getInfo());

    serveStatic(req, res, pathname).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'Internal server error');
      else res.destroy();
    });
  });
}
