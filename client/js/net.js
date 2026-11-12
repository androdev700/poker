import { WS_CLOSE_REPLACED } from '/shared/protocol.js';

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;

export function socketUrl(loc = location) {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

/**
 * WebSocket with automatic reconnect. `hello()` is asked for the first message on every open (resume,
 * create or join), so a reconnect re-establishes the session without the caller tracking sockets.
 * Events: 'open', 'message' (parsed object), 'close' ({code, replaced, willRetry}).
 */
export function createNet({ url = socketUrl(), hello } = {}) {
  const listeners = { open: new Set(), message: new Set(), close: new Set() };
  let ws = null;
  let wanted = false;
  let stopped = false;
  let attempt = 0;
  let timer = 0;

  function emit(type, arg) {
    for (const fn of listeners[type]) {
      try {
        fn(arg);
      } catch (err) {
        console.error(`net ${type} handler:`, err);
      }
    }
  }

  const live = () => !!ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN);

  function open() {
    clearTimeout(timer);
    timer = 0;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      console.error('net:', err);
      schedule();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      attempt = 0;
      emit('open');
      const first = hello?.();
      if (first) send(first);
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'closed') stopped = true;
      emit('message', msg);
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      const replaced = e.code === WS_CLOSE_REPLACED;
      if (replaced) stopped = true;
      const willRetry = wanted && !stopped;
      emit('close', { code: e.code, replaced, willRetry });
      if (willRetry) schedule();
    };
    sock.onerror = () => {};
  }

  function schedule() {
    if (timer || !wanted || stopped) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    attempt++;
    const delay = Math.min(BACKOFF_MAX_MS, base * (0.85 + Math.random() * 0.3));
    timer = setTimeout(() => {
      timer = 0;
      if (wanted && !stopped && !live()) open();
    }, delay);
  }

  function retryNow() {
    if (!wanted || stopped || live()) return;
    attempt = 0;
    open();
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') retryNow();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', retryNow);

  function connect() {
    wanted = true;
    stopped = false;
    if (live()) return;
    attempt = 0;
    open();
  }

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Explicit leave: close and never reconnect until connect() is called again. */
  function close() {
    wanted = false;
    clearTimeout(timer);
    timer = 0;
    const sock = ws;
    ws = null;
    if (sock) {
      try {
        sock.close(1000, 'leave');
      } catch {}
    }
  }

  /** Keep the current socket but do not reconnect when it drops (table closed). */
  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = 0;
  }

  function on(type, fn) {
    listeners[type].add(fn);
    return () => listeners[type].delete(fn);
  }

  return {
    connect,
    send,
    close,
    stop,
    on,
    get connected() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    get reconnecting() {
      return wanted && !stopped && !(ws && ws.readyState === WebSocket.OPEN);
    },
  };
}
