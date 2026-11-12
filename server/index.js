import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHttpServer } from './http.js';
import { startTunnel } from './tunnel.js';

const NET_MODULE_URL = new URL('./net.js', import.meta.url).href;

function lanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => `http://${iface.address}:${port}`);
}

async function loadNet() {
  try {
    return await import('./net.js');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && err.url === NET_MODULE_URL) return null;
    throw err;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

function printBanner({ url, share, tunnelRequested, tunnelError, wsAttached }) {
  const lines = ['', '  Poker server running', '', `    Local:   ${url}`];
  for (const lan of share.lan) lines.push(`    LAN:     ${lan}`);
  if (share.tunnel) lines.push(`    Tunnel:  ${share.tunnel}`);
  else if (tunnelRequested) lines.push(`    Tunnel:  unavailable - ${tunnelError}`);
  else lines.push('    Tunnel:  off (start with --tunnel to share over the internet)');
  if (!wsAttached) lines.push('', '  Notice: server/net.js not found; serving static files only.');
  lines.push('', '  Press Ctrl+C to stop.', '');
  console.log(lines.join('\n'));
}

export async function startServer({ port = 3000, tunnel = false, quiet = false, roomOptions } = {}) {
  const share = { lan: [], tunnel: null };
  const server = createHttpServer({ getInfo: () => share });

  const net = await loadNet();
  const ws = net ? net.attachWebSocket(server, { share, roomOptions }) : null;

  let actualPort;
  try {
    actualPort = await listen(server, port);
  } catch (err) {
    await ws?.closeAll();
    throw err;
  }
  const url = `http://localhost:${actualPort}`;
  share.lan.push(...lanUrls(actualPort));

  let tunnelHandle = null;
  let tunnelError = null;
  if (tunnel) {
    try {
      tunnelHandle = await startTunnel(actualPort);
      share.tunnel = tunnelHandle.url;
    } catch (err) {
      tunnelError = err.message;
    }
  }

  if (!quiet) printBanner({ url, share, tunnelRequested: tunnel, tunnelError, wsAttached: Boolean(ws) });

  let closing = null;
  const close = () => {
    closing ??= (async () => {
      try {
        await ws?.closeAll();
      } finally {
        tunnelHandle?.stop();
        share.tunnel = null;
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        });
      }
    })();
    return closing;
  };

  return { port: actualPort, url, share, close };
}

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT || 3000), tunnel: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tunnel') opts.tunnel = true;
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error('Port must be an integer between 0 and 65535.');
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let handle;
  let shuttingDown = false;
  const shutdown = () => {
    // process.exit (not the default signal death) so tunnel.js's 'exit' hook still kills ngrok.
    if (shuttingDown || !handle) process.exit(1);
    shuttingDown = true;
    console.log('\nShutting down...');
    setTimeout(() => process.exit(1), 5000).unref();
    handle.close().then(
      () => process.exit(0),
      (err) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    handle = await startServer(opts);
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${opts.port} is already in use.` : err);
    process.exit(1);
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(fs.realpathSync(entry)).href === import.meta.url) {
  main();
}
