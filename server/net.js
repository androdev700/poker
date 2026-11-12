import { WebSocketServer } from 'ws';
import { ERR } from '../shared/protocol.js';
import { RoomManager } from './rooms.js';

export const HEARTBEAT_MS = 15_000;
export const RATE_LIMIT = { messages: 30, windowMs: 5_000 };
const CLOSE_GRACE_MS = 1_000;
const KNOWN_CODES = new Set(Object.values(ERR));

function sendError(ws, code, message) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ t: 'error', code, message }));
}

function parse(data, isBinary) {
  if (isBinary) return null;
  try {
    const msg = JSON.parse(data.toString('utf8'));
    return msg && typeof msg === 'object' && !Array.isArray(msg) && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}

export function attachWebSocket(httpServer, { share = { lan: [], tunnel: null }, roomOptions = {} } = {}) {
  const rooms = new RoomManager({ share, roomOptions });
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 4096 });
  // ws re-emits the HTTP server's errors (e.g. EADDRINUSE); the caller of listen() already handles those.
  wss.on('error', () => {});
  /** @type {WeakMap<import('ws').WebSocket, {room, playerId}>} */
  const bindings = new WeakMap();
  const alive = new WeakMap();

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function bound(ws) {
    const b = bindings.get(ws);
    if (!b) throw Object.assign(new Error('Join a table first'), { code: ERR.BAD_MESSAGE });
    if (!b.room.closed && !b.room.isBound(b.playerId, ws))
      throw Object.assign(new Error('This seat was opened in another tab'), { code: ERR.BAD_TOKEN });
    return b;
  }

  function unbound(ws) {
    if (bindings.has(ws)) throw Object.assign(new Error('Already seated at a table'), { code: ERR.BAD_MESSAGE });
  }

  function findRoom(code) {
    const room = rooms.get(code);
    if (!room) throw Object.assign(new Error('No table with that code'), { code: ERR.NO_ROOM });
    return room;
  }

  function handle(ws, msg) {
    switch (msg.t) {
      case 'create': {
        unbound(ws);
        const { room, player } = rooms.create(msg.name, msg.config, ws);
        bindings.set(ws, { room, playerId: player.id });
        return;
      }
      case 'join': {
        unbound(ws);
        const room = findRoom(msg.code);
        const player = room.join(msg.name, ws);
        bindings.set(ws, { room, playerId: player.id });
        return;
      }
      case 'resume': {
        unbound(ws);
        const room = findRoom(msg.code);
        if (room.closed && room.hasToken(msg.token)) {
          ws.send(JSON.stringify({ t: 'closed', scoreboard: room.scoreboard() }));
          return;
        }
        const player = room.resume(msg.token, ws);
        bindings.set(ws, { room, playerId: player.id });
        return;
      }
      case 'start': {
        const { room, playerId } = bound(ws);
        return room.start(playerId);
      }
      case 'action': {
        const { room, playerId } = bound(ws);
        return room.action(playerId, msg);
      }
      case 'close': {
        const { room, playerId } = bound(ws);
        return room.close(playerId);
      }
      case 'leave': {
        const { room, playerId } = bound(ws);
        room.leave(playerId);
        bindings.delete(ws);
        return;
      }
      case 'back': {
        const { room, playerId } = bound(ws);
        return room.back(playerId);
      }
      default:
        throw Object.assign(new Error('Unknown message type'), { code: ERR.BAD_MESSAGE });
    }
  }

  wss.on('connection', (ws) => {
    alive.set(ws, true);
    let windowStart = Date.now();
    let count = 0;

    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', () => {});
    ws.on('close', () => {
      const b = bindings.get(ws);
      if (b) b.room.disconnect(b.playerId, ws);
    });
    ws.on('message', (data, isBinary) => {
      alive.set(ws, true);
      const now = Date.now();
      if (now - windowStart >= RATE_LIMIT.windowMs) {
        windowStart = now;
        count = 0;
      }
      if (count >= RATE_LIMIT.messages) {
        if (count++ === RATE_LIMIT.messages) sendError(ws, ERR.RATE_LIMIT, 'Too many messages; slow down');
        return;
      }
      const msg = parse(data, isBinary);
      if (!msg) {
        count++;
        return sendError(ws, ERR.BAD_MESSAGE, 'Malformed message');
      }
      try {
        handle(ws, msg);
        // Accepted actions are already paced by the game, and fast bot tables send far more than any human.
        if (msg.t !== 'action') count++;
      } catch (err) {
        count++;
        if (KNOWN_CODES.has(err?.code)) return sendError(ws, err.code, err.message);
        console.error('ws handler error:', err);
        sendError(ws, ERR.BAD_MESSAGE, 'Something went wrong on the server');
      }
    });
  });

  async function closeAll() {
    clearInterval(heartbeat);
    rooms.closeAll();
    const clients = [...wss.clients];
    await new Promise((resolve) => {
      let pending = clients.filter((ws) => ws.readyState !== ws.CLOSED).length;
      if (pending === 0) return resolve();
      const timer = setTimeout(resolve, CLOSE_GRACE_MS);
      for (const ws of clients) {
        if (ws.readyState === ws.CLOSED) continue;
        if (ws.readyState === ws.OPEN) ws.close(1001, 'Server shutting down');
        ws.once('close', () => {
          if (--pending === 0) {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    });
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(() => resolve()));
  }

  return { closeAll, rooms };
}
