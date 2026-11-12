import { ERR, CODE_LENGTH, CODE_ALPHABET } from '/shared/protocol.js';
import { createStage } from './scene/stage.js';
import { createHud } from './hud.js';
import { createActionBar } from './actionbar.js';
import { createLobby } from './lobby.js';
import * as sound from './sound.js';
import { createNet } from './net.js';
import { createStore, profileFromUrl } from './store.js';
import { createDirector } from './director.js';

const SESSION_GONE = new Set([ERR.NO_ROOM, ERR.BAD_TOKEN, ERR.ROOM_CLOSED]);
const CODE_STRIP = new RegExp(`[^${CODE_ALPHABET}]`, 'g');

const hudRoot = document.getElementById('hud');
const store = createStore({ profile: profileFromUrl() });
const stage = createStage(document.getElementById('stage'));

/** 'home' | 'connecting' | 'waiting' | 'table' | 'scoreboard' | 'notice' */
let screen = 'home';
let pendingHello = null;
let resuming = false;
let expectSnapshot = false;

const barEl = document.getElementById('actionbar');

const hud = createHud(hudRoot, {
  screenPos: stage.screenPos,
  isMuted: sound.isMuted,
  isConnected: () => net.connected,
  onSizeClass: () => syncInsets(),
  onBack: () => net.send({ t: 'back' }),
  onMuteToggle: () => {
    sound.setMuted(!sound.isMuted());
    sound.unlock();
  },
  onStart: () => net.send({ t: 'start' }),
  onCloseTable: () => net.send({ t: 'close' }),
});

const bar = createActionBar(barEl, {
  onAction(a) {
    const turn = director.turn;
    if (!turn) return;
    const msg = { t: 'action', handId: turn.handId, turnId: turn.turnId, type: a.type };
    if (a.type === 'raiseTo') msg.amount = a.amount;
    if (net.send(msg)) director.acted();
    else director.refreshTurn();
  },
});

function syncInsets() {
  stage.setInsets?.(hud.metrics());
}

/** Offsets ignore the slide-in transform, so plates move out of the bar's final box straight away. */
function reportBar() {
  if (barEl.classList.contains('is-hidden')) return hud.setBar(null);
  const l = barEl.offsetLeft;
  const t = barEl.offsetTop;
  hud.setBar({ l, t, r: l + barEl.offsetWidth, b: t + barEl.offsetHeight });
}
new ResizeObserver(reportBar).observe(barEl);

const actionbar = {
  ...bar,
  show(args) {
    bar.show(args);
    reportBar();
  },
  hide() {
    bar.hide();
    reportBar();
  },
};

const lobby = createLobby(document.getElementById('screens'), {
  onCreate: ({ name, config }) => hello({ t: 'create', name, config }),
  onJoin: ({ code, name }) => {
    const token = store.session ? null : store.tokenFor(code);
    if (!token) return hello({ t: 'join', code, name });
    // Rejoining a table this browser already sits at takes the old seat back rather than a new buy-in.
    sound.unlock();
    store.setName(name);
    store.setSession({ code, token });
    lobby.showConnecting('Rejoining table…');
    if (net.connected) {
      resuming = true;
      net.send({ t: 'resume', code, token });
    } else net.connect();
  },
  onStart: () => net.send({ t: 'start' }),
  onCloseTable: () => net.send({ t: 'close' }),
  onLeave: () => {
    net.send({ t: 'leave' });
    store.clearSession({ forget: true });
    goHome();
  },
});

const net = createNet({
  hello() {
    if (store.session?.token) {
      resuming = true;
      return { t: 'resume', code: store.session.code, token: store.session.token };
    }
    return pendingHello;
  },
});

const director = createDirector({ stage, hud, actionbar, sound, store });
stage.onLayout(() => hud.layout());
syncInsets();

const connPill = document.createElement('div');
connPill.className = 'conn-pill glass';
connPill.setAttribute('role', 'status');
connPill.textContent = 'Reconnecting…';
connPill.hidden = true;
document.body.append(connPill);

function updateConnPill() {
  const inGame = !!store.session && (screen === 'table' || screen === 'waiting');
  connPill.hidden = !(inGame && !net.connected);
  hud.refresh();
}

function setUrlRoom(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code);
  else u.searchParams.delete('room');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}

function hello(msg) {
  sound.installAutoUnlock();
  sound.unlock();
  if (pendingHello || store.session) return;
  store.setName(msg.name);
  pendingHello = msg;
  if (net.connected) net.send(msg);
  else net.connect();
}

function showHomeScreen({ code, error } = {}) {
  screen = 'home';
  hudRoot.hidden = true;
  lobby.showHome({ code, name: store.name, error });
  updateConnPill();
}

function goHome(opts) {
  net.close();
  pendingHello = null;
  resuming = false;
  store.clearSession();
  director.reset({ clear: true });
  setUrlRoom(null);
  showHomeScreen(opts);
}

function route() {
  if (screen === 'scoreboard' || screen === 'notice' || !store.session) return;
  const v = store.view;
  if (!v) return;
  if (hudRoot.hidden) {
    hudRoot.hidden = false;
    hud.layout();
  }
  if (v.room.status === 'lobby' && v.hand === null) {
    screen = 'waiting';
    lobby.showWaiting(v);
  } else if (screen !== 'table') {
    screen = 'table';
    lobby.hide();
  }
  updateConnPill();
}

const seatedCount = (v) => (v?.seats || []).filter(Boolean).length;

function onWelcome(msg) {
  const sameRoom = store.session?.code === String(msg.code).toUpperCase();
  store.setSession({ playerId: msg.playerId, token: msg.token, code: msg.code, seat: msg.seat });
  pendingHello = null;
  resuming = false;
  expectSnapshot = true;
  setUrlRoom(store.session.code);
  director.reset({ clear: !sameRoom });
  stage.setPerspective(msg.seat);
  keepAwake();
  updateConnPill();
}

function onUpdate(msg) {
  if (!store.session) return;
  const before = store.view;
  if (!store.acceptUpdate(msg)) return;
  const snapshot = expectSnapshot;
  expectSnapshot = false;
  director.enqueue(msg, { snapshot });
  if (screen === 'waiting' && before && seatedCount(msg.state) > seatedCount(before)) sound.play('join');
  route();
}

function onError({ code, message }) {
  if (code === ERR.STALE_ACTION || code === ERR.ILLEGAL_ACTION) {
    director.refreshTurn();
    if (code === ERR.ILLEGAL_ACTION) lobby.setError(message);
    return;
  }
  if (resuming && SESSION_GONE.has(code)) {
    const roomCode = store.session?.code;
    store.clearSession({ forget: true });
    goHome({ code: code === ERR.BAD_TOKEN ? roomCode : undefined, error: message });
    if (code === ERR.BAD_TOKEN && roomCode) setUrlRoom(roomCode);
    return;
  }
  if (!store.session) pendingHello = null;
  lobby.setError(message);
}

function onClosed(msg) {
  store.clearSession({ forget: true });
  net.stop();
  director.reset();
  screen = 'scoreboard';
  hudRoot.hidden = true;
  updateConnPill();
  lobby.showScoreboard(msg.scoreboard || [], { onNewTable: () => goHome() });
}

net.on('open', () => {
  store.beginSocket();
  updateConnPill();
});

net.on('message', (msg) => {
  switch (msg.t) {
    case 'welcome':
      return onWelcome(msg);
    case 'update':
      return onUpdate(msg);
    case 'error':
      return onError(msg);
    case 'closed':
      return onClosed(msg);
  }
});

net.on('close', ({ replaced }) => {
  resuming = false;
  director.flush();
  director.reset();
  if (replaced) {
    screen = 'notice';
    hudRoot.hidden = true;
    lobby.showNotice({
      title: 'Seat opened in another tab',
      body: 'This table is now open in another tab or window. Only one of them can play your seat.',
      actionLabel: 'Play here instead',
      onAction: () => {
        screen = 'connecting';
        lobby.showConnecting('Reconnecting…');
        net.connect();
      },
      secondaryLabel: 'Back to home',
      onSecondary: () => goHome(),
    });
  } else if (!store.session && pendingHello) {
    lobby.setError('Can’t reach the server — retrying…');
  }
  updateConnPill();
});

let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !store.session || document.hidden || !window.isSecureContext || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) keepAwake();
});

let layoutQueued = false;
function queueLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    syncInsets();
    reportBar();
    hud.layout();
  });
}
window.addEventListener('resize', queueLayout);
// A 180° turn on iOS moves the notch to the other side without resizing the viewport.
window.screen.orientation?.addEventListener?.('change', queueLayout);
window.addEventListener('orientationchange', queueLayout);

function boot() {
  sound.installAutoUnlock();
  hudRoot.hidden = true;
  const raw = new URLSearchParams(location.search).get('room') || '';
  const code = raw.toUpperCase().replace(CODE_STRIP, '').slice(0, CODE_LENGTH);
  const token = code.length === CODE_LENGTH ? store.tokenFor(code) : null;
  if (token) {
    store.setSession({ code, token });
    screen = 'connecting';
    lobby.showConnecting('Rejoining table…');
    net.connect();
    return;
  }
  showHomeScreen({ code: code || undefined });
}

boot();
