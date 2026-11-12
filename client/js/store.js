const PROFILE_RE = /^[a-z0-9_-]{1,24}$/i;

/** `?p=<profile>` namespaces every key so several tabs on one origin can each hold their own seat. */
export function profileFromUrl(search = location.search) {
  const p = new URLSearchParams(search).get('p');
  return p && PROFILE_RE.test(p) ? p : null;
}

export function createStore({ profile = null } = {}) {
  const ns = profile ? `poker:${profile}:` : 'poker:';

  function read(key) {
    try {
      return localStorage.getItem(ns + key);
    } catch {
      return null;
    }
  }
  function write(key, value) {
    try {
      if (value == null) localStorage.removeItem(ns + key);
      else localStorage.setItem(ns + key, value);
    } catch {}
  }
  const roomKey = (code) => `room:${String(code).toUpperCase()}`;

  let lastSeq = 0;

  const store = {
    profile,
    /** @type {null|{playerId?:string, token:string, code:string, seat?:number}} */
    session: null,
    /** latest server View */
    view: null,
    /** what the HUD and scene draw; owned and patched by the director */
    ds: null,

    get name() {
      return read('name') || '';
    },
    setName(name) {
      write('name', name || null);
    },

    tokenFor(code) {
      if (!code) return null;
      try {
        const data = JSON.parse(read(roomKey(code)) || 'null');
        return typeof data?.token === 'string' ? data.token : null;
      } catch {
        return null;
      }
    },
    rememberRoom(code, token) {
      write(roomKey(code), JSON.stringify({ token }));
    },
    forgetRoom(code) {
      if (code) write(roomKey(code), null);
    },

    setSession(s) {
      store.session = { ...s, code: String(s.code).toUpperCase() };
      if (s.token) store.rememberRoom(store.session.code, s.token);
    },
    /** Drops the session; with `forget` the room's stored token goes too. */
    clearSession({ forget = false } = {}) {
      if (forget && store.session) store.forgetRoom(store.session.code);
      store.session = null;
      store.view = null;
    },

    /** Called once per socket: seq numbers only order updates within one connection. */
    beginSocket() {
      lastSeq = 0;
    },
    /** @returns false when the update is stale and must be ignored */
    acceptUpdate(msg) {
      if (!Number.isFinite(msg?.seq) || msg.seq <= lastSeq) return false;
      lastSeq = msg.seq;
      store.view = msg.state;
      return true;
    },
  };
  return store;
}
