import { spawn } from 'node:child_process';

const API_URL = 'http://127.0.0.1:4040/api/tunnels';
const POLL_MS = 500;
const TIMEOUT_MS = 15_000;
const AUTH_HINT = 'If this is a fresh ngrok install, run `ngrok config add-authtoken <token>` first.';

async function findTunnelUrl(port) {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(POLL_MS) });
    if (!res.ok) return null;
    const { tunnels = [] } = await res.json();
    // Another ngrok agent may already own :4040, so only accept a tunnel pointing at our port.
    const ours = tunnels.find(
      (t) => t.public_url?.startsWith('https://') && String(t.config?.addr ?? '').endsWith(`:${port}`),
    );
    return ours?.public_url ?? null;
  } catch {
    return null;
  }
}

export function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('ngrok', ['http', String(port)], { stdio: 'ignore' });
    let settled = false;
    let timer;

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    process.on('exit', kill);

    const stop = () => {
      process.off('exit', kill);
      kill();
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(new Error(message));
    };

    child.on('error', (err) => {
      fail(err.code === 'ENOENT'
        ? 'ngrok not found on PATH. Install it from https://ngrok.com/download, then run `ngrok config add-authtoken <token>`.'
        : `Failed to start ngrok: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      fail(`ngrok exited before the tunnel came up (${signal ?? `code ${code}`}). ${AUTH_HINT}`);
    });

    const deadline = Date.now() + TIMEOUT_MS;
    const poll = async () => {
      if (settled) return;
      const url = await findTunnelUrl(port);
      if (settled) return;
      if (url) {
        settled = true;
        resolve({ url, stop });
      } else if (Date.now() >= deadline) {
        fail(`Timed out after ${TIMEOUT_MS / 1000}s waiting for the ngrok tunnel. ${AUTH_HINT}`);
      } else {
        timer = setTimeout(poll, POLL_MS);
      }
    };
    timer = setTimeout(poll, POLL_MS);
  });
}
