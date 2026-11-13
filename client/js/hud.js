import { createResults } from './results.js';

const NF = new Intl.NumberFormat('en-US');
export const fmtChips = (n) => NF.format(Math.round(n));

const UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];

/** Full value with separators below 1,000,000; three significant figures above ("1.25M"). */
export function fmtCompact(n) {
  const v = Math.round(n);
  const a = Math.abs(v);
  if (a < 1e6) return NF.format(v);
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const [d, s] = UNITS[i];
    const x = Number((a / d).toPrecision(3));
    if (x < 1000 || i === 0) return `${v < 0 ? '-' : ''}${x}${s}`;
  }
  return NF.format(v);
}

/** Three significant figures in thousands; 999,500 and up round to "1M", not "1000K". */
function fmtK(n) {
  const k = Number((n / 1e3).toPrecision(3));
  return Math.abs(k) < 1000 ? `${k}K` : `${Number((n / 1e6).toPrecision(3))}M`;
}

// Compact plates cannot fit "in 12,500" beside a stack (the narrow one not even "96,400 in 210K"), so they
// abbreviate from 10,000.
export const fmtTight = (n) => (Math.abs(n) >= 1e4 && Math.abs(n) < 1e6 ? fmtK(n) : fmtCompact(n));

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function button(className, text, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

const HAND_RANKS = [
  ['Royal Flush', 'As Ks Qs Js Ts', 'A-K-Q-J-10, all one suit'],
  ['Straight Flush', '9h 8h 7h 6h 5h', 'Five in a row, all one suit'],
  ['Four of a Kind', 'Qs Qh Qd Qc 4s', 'Four cards of the same rank'],
  ['Full House', 'Ks Kh Kd 7c 7s', 'Three of a kind plus a pair'],
  ['Flush', 'Ad Jd 8d 5d 2d', 'Five cards of one suit'],
  ['Straight', '8s 7h 6d 5c 4s', 'Five in a row, any suits'],
  ['Three of a Kind', '9s 9h 9d Kc 3s', 'Three cards of the same rank'],
  ['Two Pair', 'Js Jh 5d 5c As', 'Two different pairs'],
  ['Pair', 'Ts Th Ad 8c 3s', 'Two cards of the same rank'],
  ['High Card', 'As Jh 8d 5c 2s', 'None of the above; highest card plays'],
];
const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };

export function miniCard(code) {
  const red = code[1] === 'h' || code[1] === 'd';
  return el('span', red ? 'mini-card is-red' : 'mini-card', (code[0] === 'T' ? '10' : code[0]) + SUIT_GLYPH[code[1]]);
}

export function showHandRankings(host = document.body) {
  const scrim = el('div', 'dialog-scrim');
  const box = el('div', 'dialog glass ranks');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Hand rankings');
  const list = el('ol', 'ranks-list');
  for (const [name, cards, note] of HAND_RANKS) {
    const row = el('li', 'ranks-row');
    const text = el('div', 'ranks-text');
    text.append(el('div', 'ranks-name', name), el('div', 'ranks-note', note));
    const mini = el('div', 'ranks-cards');
    for (const c of cards.split(' ')) {
      mini.append(miniCard(c));
    }
    row.append(text, mini);
    list.append(row);
  }
  const close = button('btn btn-primary', 'Got it', () => done());
  box.append(
    el('h2', 'dialog-title', 'Hand rankings'),
    el('p', 'dialog-body', 'Strongest first. Your hand is the best five cards from your two plus the board.'),
    list,
    el('p', 'ranks-foot', 'Same hand type? Higher cards win; identical hands split the pot. An ace can also play low in A-2-3-4-5.'),
    close
  );
  scrim.append(box);
  host.append(scrim);
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') done();
  };
  function done() {
    document.removeEventListener('keydown', onKey, true);
    scrim.classList.remove('open');
    setTimeout(() => scrim.remove(), 180);
  }
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) done(); });
  requestAnimationFrame(() => scrim.classList.add('open'));
}

/** Modal confirm. Resolves true on confirm, false on cancel / Esc / backdrop tap. */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, host = document.body }) {
  return new Promise((resolve) => {
    const scrim = el('div', 'dialog-scrim');
    const box = el('div', 'dialog glass');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const heading = el('h2', 'dialog-title', title);
    heading.id = `dlg-${Math.random().toString(36).slice(2)}`;
    box.setAttribute('aria-labelledby', heading.id);
    const actions = el('div', 'dialog-actions');
    const cancel = button('btn btn-ghost', cancelLabel, () => done(false));
    const ok = button(danger ? 'btn btn-danger' : 'btn btn-primary', confirmLabel, () => done(true));
    actions.append(cancel, ok);
    box.append(heading);
    if (body) box.append(el('p', 'dialog-body', body));
    box.append(actions);
    scrim.append(box);
    host.append(scrim);

    // Capture-phase so game shortcuts (F/C/R, Esc) never fire underneath an open dialog.
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') done(false);
    };
    function done(v) {
      document.removeEventListener('keydown', onKey, true);
      scrim.classList.remove('open');
      setTimeout(() => scrim.remove(), 180);
      resolve(v);
    }
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) done(false); });
    requestAnimationFrame(() => scrim.classList.add('open'));
    cancel.focus({ preventScroll: true });
  });
}

const ICON_SOUND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor"/><path class="ico-on" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path class="ico-off" d="M16 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_MENU = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="18.5" cy="12" r="1.8" fill="currentColor"/></svg>';
const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;
const RING_SVG = `<svg class="plate-ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="ring-bg" cx="24" cy="24" r="${RING_R}"/><circle class="ring-fg" cx="24" cy="24" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="0"/></svg>`;
const WARN_MS = 5000;
const SEATS = 6;

// Plate footprints and top-bar heights per size class; style.css sizes the same boxes. `dock` is the smallest
// box the action bar takes in the free rect's bottom-right corner (its 220x66 plus margins beyond GAP).
const DIMS = { n: { w: 136, h: 52 }, c: { w: 160, h: 56 }, f: { w: 172, h: 78 } };
const SIZES = {
  compact: { bar: 50, side: 'n', top: 'n', hero: 'c', dock: { w: 224, h: 68 } },
  wide: { bar: 58, side: 'f', top: 'f', hero: 'f' },
};
const GAP = 6;
const PUSH_GAP = 4;
const SLIDE_TOL = 8;
const COLLAPSED_MIN_W = 200;

const classify = (h) => (h <= 520 ? 'compact' : 'wide');

function setText(node, text) {
  if (node._t !== text) {
    node._t = text;
    node.textContent = text;
  }
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function toggle(node, name, on) {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

function initialOf(name) {
  const first = [...(name || '?').trim()][0] || '?';
  return first.toUpperCase();
}

const hit = (a, b, gap = 0) => a.l < b.r + gap && b.l < a.r + gap && a.t < b.b + gap && b.t < a.b + gap;
const finite = (...xs) => xs.every(Number.isFinite);
const rectOf = (p) => (p && finite(p.l, p.t, p.r, p.b) && p.r > p.l && p.b > p.t ? { l: p.l, t: p.t, r: p.r, b: p.b } : null);
const offsetRect = (node) => ({ l: node.offsetLeft, t: node.offsetTop, r: node.offsetLeft + node.offsetWidth, b: node.offsetTop + node.offsetHeight });

/**
 * @param {HTMLElement} root
 * @param {{screenPos:(seat:number|null, spot:'plate'|'board'|'pot'|'hero', opts?:{pots:number})=>object|null,
 *          onMuteToggle:()=>void, onCloseTable:()=>void, onStart:()=>void, onBack?:()=>void, isMuted:()=>boolean,
 *          isConnected?:()=>boolean, onSizeClass?:()=>void}} opts
 */
export function createHud(root, opts) {
  root.classList.add('hud');
  root.replaceChildren();

  const top = el('div', 'hud-top');
  const info = el('div', 'hud-info glass');
  const codeEl = el('span', 'hud-code');
  const blindsEl = el('span', 'hud-blinds');
  const handEl = el('span', 'hud-handno');
  info.append(codeEl, blindsEl, handEl);

  const tools = el('div', 'hud-tools');
  const muteBtn = button('icon-btn glass hud-mute', null, () => {
    opts.onMuteToggle?.();
    syncMute();
  });
  muteBtn.innerHTML = ICON_SOUND;
  const menuBtn = button('icon-btn glass hud-menu-btn', null, (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  menuBtn.innerHTML = ICON_MENU;
  menuBtn.setAttribute('aria-label', 'Table menu');
  menuBtn.setAttribute('aria-haspopup', 'menu');
  const menu = el('div', 'hud-menu glass');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const dealItem = button('menu-item', 'Deal next hand', () => { toggleMenu(false); opts.onStart?.(); });
  const closeItem = button('menu-item menu-item-danger', 'Close table…', () => { toggleMenu(false); askClose(); });
  dealItem.setAttribute('role', 'menuitem');
  closeItem.setAttribute('role', 'menuitem');
  menu.append(dealItem, closeItem);
  const overlayHost = () => root.parentElement || document.body;
  const helpBtn = button('icon-btn glass hud-help', '?', () => showHandRankings(overlayHost()));
  helpBtn.setAttribute('aria-label', 'Hand rankings');
  tools.append(helpBtn, muteBtn, menuBtn, menu);
  top.append(info, tools);
  top.hidden = true;

  const plateLayer = el('div', 'hud-layer');
  const pot = el('div', 'hud-pot');
  const potAmt = el('span', 'hud-pot-amt');
  const potSplit = el('span', 'hud-pot-split');
  pot.append(el('span', 'hud-pot-label', 'Pot'), potAmt, potSplit);
  pot.hidden = true;

  const status = el('div', 'dock-status');
  const statusText = el('span', 'dock-status-text');
  const backBtn = button('btn dock-back', 'You were away — tap to play', () => opts.onBack?.());
  status.append(statusText, backBtn);
  status.hidden = true;

  const resultsHost = el('div', 'hud-results-host');
  const results = createResults(resultsHost, {
    onStart: () => opts.onStart?.(),
    onBack: () => opts.onBack?.(),
    onToggle: () => lastDs && render(lastDs),
  });

  const safeProbe = el('div', 'hud-safe-probe');
  root.append(safeProbe, pot, plateLayer, status, resultsHost, top);

  const seatEls = [];
  let lastDs = null;
  let layoutSig = '';
  let sawHandIn = null;
  let menuOpen = false;
  let timerSeat = null;
  let closing = false;
  let size = '';
  let mySeat = 0;
  let barRect = null;
  let ready = false;
  let rendering = false;
  let barRoom;

  function onDocPointer(e) {
    if (menuOpen && !menu.contains(e.target) && e.target !== menuBtn) toggleMenu(false);
  }
  function onDocKey(e) {
    if (menuOpen && e.key === 'Escape') toggleMenu(false);
  }
  document.addEventListener('pointerdown', onDocPointer);
  document.addEventListener('keydown', onDocKey);

  let roQueued = false;
  const ro = new ResizeObserver(() => {
    if (roQueued) return;
    roQueued = true;
    requestAnimationFrame(() => {
      roQueued = false;
      layout();
    });
  });
  ro.observe(root);
  ro.observe(results.el);

  function toggleMenu(force) {
    menuOpen = force ?? !menuOpen;
    menu.hidden = !menuOpen;
    menuBtn.setAttribute('aria-expanded', String(menuOpen));
  }

  async function askClose() {
    if (closing) return;
    closing = true;
    const ok = await confirmDialog({
      title: 'Close the table?',
      body: 'This ends the game for everyone. Live bets are returned and the final scoreboard is shown.',
      confirmLabel: 'Close table',
      danger: true,
      host: overlayHost(),
    });
    closing = false;
    if (ok) opts.onCloseTable?.();
  }

  function syncMute() {
    const muted = !!opts.isMuted?.();
    if (muteBtn._m !== muted) {
      muteBtn._m = muted;
      muteBtn.classList.toggle('is-muted', muted);
      muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
      muteBtn.setAttribute('aria-pressed', String(muted));
    }
  }

  const connected = () => opts.isConnected?.() ?? true;

  // #table, not the window: when the table is drawn rotated its client size is the logical landscape size.
  function viewport() {
    const host = root.parentElement;
    const w = root.clientWidth || host?.clientWidth || 0;
    const h = root.clientHeight || host?.clientHeight || 0;
    return { w, h };
  }

  function safe() {
    const cs = getComputedStyle(safeProbe);
    return {
      t: parseFloat(cs.paddingTop) || 0,
      r: parseFloat(cs.paddingRight) || 0,
      b: parseFloat(cs.paddingBottom) || 0,
      l: parseFloat(cs.paddingLeft) || 0,
    };
  }

  /** Re-derives the size class; restyles plates and notifies when it changed. */
  function applySize() {
    const { h } = viewport();
    const next = classify(h);
    if (next === size) return false;
    size = next;
    root.dataset.size = size;
    for (const s of seatEls) if (s) shapeSeat(s);
    layoutSig = '';
    if (ready) opts.onSizeClass?.();
    // Plate texts depend on the class; nothing else re-renders a static table.
    if (lastDs && !rendering) render(lastDs);
    return true;
  }

  const viewOf = (seat) => (((seat - mySeat) % SEATS) + SEATS) % SEATS;

  function shapeOf(seat) {
    const k = SIZES[size] || SIZES.wide;
    const v = viewOf(seat);
    if (v === 0) return k.hero;
    return v === 3 ? k.top : k.side;
  }

  function shapeSeat(s) {
    const shape = shapeOf(s.seat);
    s.dims = DIMS[shape];
    if (s.plate.dataset.shape !== shape) s.plate.dataset.shape = shape;
    s.act._t = null;
    s.stack._t = null;
    s.inPot._t = null;
  }

  function metrics() {
    applySize();
    const k = SIZES[size] || SIZES.wide;
    const sa = safe();
    const dims = (shape) => ({ ...DIMS[shape] });
    return {
      top: Math.round(sa.t + k.bar + GAP),
      bottom: Math.round(sa.b + GAP),
      left: Math.round(sa.l + GAP),
      right: Math.round(sa.r + GAP),
      plates: { side: dims(k.side), top: dims(k.top), hero: dims(k.hero) },
      dock: k.dock ? { ...k.dock } : null,
    };
  }

  function makeSeat(seat) {
    const plate = el('div', 'plate');
    plate.dataset.seat = String(seat);
    const act = el('div', 'plate-act');
    const card = el('div', 'plate-card');
    const av = el('div', 'plate-av');
    av.innerHTML = RING_SVG;
    const ring = av.querySelector('.ring-fg');
    const initial = el('span', 'plate-initial');
    const dealer = el('span', 'plate-dealer', 'D');
    const blind = el('span', 'plate-blind');
    av.append(initial, dealer, blind);
    const infoEl = el('div', 'plate-info');
    const head = el('div', 'plate-head');
    const name = el('div', 'plate-name');
    head.append(name, el('span', 'plate-you', 'You'));
    const line = el('div', 'plate-line');
    const stack = el('span', 'plate-stack');
    const inPot = el('span', 'plate-inpot');
    line.append(stack, inPot);
    infoEl.append(head, line);
    card.append(av, infoEl);
    plate.append(act, card);
    plateLayer.append(plate);
    const s = { seat, plate, act, ring, initial, dealer, blind, name, stack, inPot, dims: DIMS.c };
    shapeSeat(s);
    return s;
  }

  function removeSeat(i) {
    const s = seatEls[i];
    if (!s) return;
    s.plate.remove();
    seatEls[i] = undefined;
  }

  function actionOf(sv, p, ds) {
    const won = ds.winners?.[sv.seat] || 0;
    if (won > 0) return ['WIN', 'win'];
    if (sv.busted) return ['Out', 'out'];
    if (p?.allIn) return ['All-in', 'allin'];
    if (p?.folded) return ['Fold', 'fold'];
    if (!sv.connected) return ['Offline', 'status'];
    if (sv.away) return ['Away', 'status'];
    const hand = ds.hand;
    if (!p || !hand || hand.phase === 'complete') return ['', ''];
    const verb = ds.bubbles?.[sv.seat] || '';
    const bet = p.streetBet > 0 ? p.streetBet : 0;
    if (!verb) return bet ? [['Bet', bet], 'bet'] : ['', ''];
    const kind = verb.toLowerCase();
    if (verb === 'Check' || verb === 'Fold' || !bet) return [verb, kind];
    return [[verb, bet], kind];
  }

  function updateSeat(s, sv, ds) {
    const { hand, you } = ds;
    const p = hand?.players?.[s.seat];
    const live = !!hand && hand.phase !== 'complete';
    const shape = s.plate.dataset.shape;
    setText(s.name, sv.name);
    if (s.name.title !== sv.name) s.name.title = sv.name;
    setText(s.initial, initialOf(sv.name));
    setText(s.stack, (shape === 'n' ? fmtTight : fmtCompact)(sv.busted ? 0 : sv.stack));

    const [act, kind] = actionOf(sv, p, ds);
    const actText = Array.isArray(act) ? `${act[0]} ${fmtCompact(act[1])}` : act;
    setText(s.act, actText);
    if (s.act.dataset.kind !== kind) s.act.dataset.kind = kind;

    const won = ds.winners?.[s.seat] || 0;
    const committed = live && p?.committed > 0 ? p.committed : 0;
    const fmtIn = shape === 'f' ? fmtCompact : fmtTight;
    const inPot = won > 0 ? `+${fmtIn(won)}` : committed ? `${shape === 'f' ? 'In pot' : 'in'} ${fmtIn(committed)}` : '';
    setText(s.inPot, inPot);

    setHidden(s.dealer, !(hand && hand.button === s.seat));
    const blind = hand && hand.sbSeat === s.seat ? 'SB' : hand && hand.bbSeat === s.seat ? 'BB' : '';
    setText(s.blind, blind);
    setHidden(s.blind, !blind);
    toggle(s.plate, 'has-badge', !!blind || !s.dealer.hidden);

    toggle(s.plate, 'is-you', s.seat === you?.seat);
    toggle(s.plate, 'is-turn', live && hand.toAct === s.seat);
    toggle(s.plate, 'is-folded', !!p?.folded);
    toggle(s.plate, 'is-away', !!(sv.away || !sv.connected));
    toggle(s.plate, 'is-busted', !!sv.busted);
    toggle(s.plate, 'is-winner', won > 0);
  }

  function statusOf(ds) {
    const { you, seats } = ds;
    const me = you?.seat;
    const sv = me != null ? seats?.[me] : null;
    if (!sv) return { text: '', back: false };
    if (sv.busted) return { text: 'You’re out — spectating', back: false };
    return { text: '', back: !!sv.away && connected() };
  }

  function updateStatus(ds) {
    const st = statusOf(ds);
    setText(statusText, st.text);
    setHidden(statusText, !st.text);
    setHidden(backBtn, !st.back);
    const show = !barRect && !results.isOpen() && !!(st.text || st.back) && !!lastDs?.you;
    setHidden(status, !show);
  }

  function updateTimer(ds) {
    const hand = ds.hand;
    const live = hand && hand.phase !== 'complete' && hand.toAct != null && ds.turnEndsAt != null && hand.turnMs > 0;
    const seat = live ? hand.toAct : null;
    if (timerSeat !== seat && timerSeat != null) {
      const prev = seatEls[timerSeat];
      if (prev) {
        prev.ring.style.strokeDashoffset = '0';
        toggle(prev.plate, 'is-warn', false);
        toggle(prev.plate, 'has-timer', false);
      }
    }
    timerSeat = seat;
    if (seat == null) return;
    const left = Math.max(0, ds.turnEndsAt - performance.now());
    const off = String(RING_C * (1 - Math.min(1, left / hand.turnMs)));
    const s = seatEls[seat];
    if (s) {
      s.ring.style.strokeDashoffset = off;
      toggle(s.plate, 'has-timer', true);
      toggle(s.plate, 'is-warn', left <= WARN_MS);
    }
  }

  const livePots = (hand) => (hand?.pots || []).filter((p) => p.amount > 0);

  function render(ds) {
    rendering = true;
    try {
      paint(ds);
    } finally {
      rendering = false;
    }
  }

  function paint(ds) {
    lastDs = ds;
    const { room, seats, hand, you } = ds;
    setHidden(top, false);
    syncMute();
    if (Number.isInteger(you?.seat) && you.seat !== mySeat) {
      mySeat = you.seat;
      for (const s of seatEls) if (s) shapeSeat(s);
    }
    applySize();

    if (hand) sawHandIn = room.code;
    const handsPlayed = !!hand || sawHandIn === room.code;
    setText(codeEl, room.code);
    const bb = room.config.bigBlind;
    const fmtBlind = (n) => (bb >= 1e4 && bb < 1e6 && n >= 1e3 ? fmtK(n) : fmtCompact(n));
    setText(blindsEl, `${fmtBlind(room.config.smallBlind)}/${fmtBlind(room.config.bigBlind)}`);
    setText(handEl, hand ? `#${hand.handId}` : '');
    setHidden(handEl, !hand);

    const isHost = !!you?.isHost;
    setHidden(menuBtn, !isHost);
    if (!isHost && menuOpen) toggleMenu(false);
    const withChips = seats.filter((sv) => sv && !sv.busted).length;
    const present = seats.filter((sv) => sv && !sv.busted && sv.connected && !sv.away).length;
    const between = room.status === 'lobby' && handsPlayed && withChips >= 2;
    const canDeal = isHost && between && present >= 2;
    const waiting = between && present < 2;
    setHidden(dealItem, !canDeal);

    for (let i = 0; i < seats.length; i++) {
      const sv = seats[i];
      if (!sv) { removeSeat(i); continue; }
      if (!seatEls[i]) seatEls[i] = makeSeat(i);
      updateSeat(seatEls[i], sv, ds);
    }
    for (let i = seats.length; i < seatEls.length; i++) removeSeat(i);

    const potTotal = hand?.potTotal ?? 0;
    const pots = livePots(hand);
    setHidden(pot, !(hand && potTotal > 0));
    if (potTotal > 0) {
      setText(potAmt, fmtCompact(potTotal));
      // Mid-street the total also holds the live bets, which belong to no pot yet.
      const settled = pots.reduce((n, p) => n + p.amount, 0) === potTotal;
      setText(potSplit, pots.length > 1 && settled ? `(${pots.map((p) => fmtCompact(p.amount)).join(' + ')})` : '');
    }

    const me = you?.seat != null ? seats[you.seat] : null;
    results.render(ds, {
      canDeal,
      waiting,
      away: !!(me?.away && !me.busted && connected()),
      busted: !!me?.busted,
      myStack: me && !me.busted ? me.stack : null,
      compact: size === 'compact',
    });
    updateStatus(ds);
    updateTimer(ds);

    const sig = [
      seats.map((sv) => (sv ? 1 : 0)).join(''),
      you?.seat ?? '',
      pots.length,
      pot.hidden ? 0 : 1,
      results.state(),
      size,
      status.hidden ? 0 : 1,
      potAmt._t,
      potSplit._t,
    ].join('|');
    if (sig !== layoutSig) {
      layoutSig = sig;
      layout();
    }
  }

  function sp(seat, spot, o) {
    try {
      const p = opts.screenPos?.(seat, spot, o);
      return p && typeof p === 'object' ? p : null;
    } catch {
      return null;
    }
  }

  /** `rect` of the docked action bar in root coordinates, or null when it is hidden. */
  function setBar(rect) {
    const next = rectOf(rect);
    const same = next === barRect || (next && barRect && ['l', 't', 'r', 'b'].every((k) => Math.round(next[k]) === Math.round(barRect[k])));
    if (same) return;
    barRect = next;
    if (lastDs) updateStatus(lastDs);
    layout();
  }

  function sizeResults(w, h, sa, m, board, potRect, items) {
    const node = results.el;
    if (!results.isOpen()) return;
    const boardB = board ? board.b : h * 0.55;
    const right = sa.r + 8;
    const [gap, minW, maxW] = size === 'compact' ? [8, 200, 360] : [16, 264, 400];
    const room = w - right - (board ? board.r : w * 0.62) - gap;
    const beside = room >= minW;
    let width = beside ? Math.min(maxW, room) : Math.min(maxW, w - sa.l - right - 8);
    if (results.isCollapsed()) {
      // Collapsing exists to uncover the table, so the header row stops short of the plates beside it; plates
      // further right than that are left to slide clear.
      const b = h - (sa.b + 8);
      const t = b - node.offsetHeight;
      const limit = w - right - COLLAPSED_MIN_W;
      const near = items.map(rectAt).filter((r) => r.b > t && r.t < b && (r.l + r.r) / 2 < limit);
      const edge = Math.max(0, ...near.map((r) => r.r + GAP));
      if (edge && edge <= limit) width = Math.min(width, w - right - edge);
    }
    const topLimit = beside ? m.top : Math.max(m.top, boardB + 12, potRect ? potRect.b + GAP : 0);
    node.style.width = `${Math.round(width)}px`;
    node.style.maxHeight = `${Math.max(Math.round(h - (sa.b + 8) - topLimit), 120)}px`;
  }

  function placePot(w, h, box, board) {
    if (pot.hidden) return null;
    const n = livePots(lastDs?.hand).length;
    const a = sp(null, 'pot', { pots: n });
    if (!a || !finite(a.x, a.y)) {
      pot.style.visibility = 'hidden';
      return null;
    }
    pot.style.visibility = '';
    const maxW = Number.isFinite(a.maxW) && a.maxW > 0 ? Math.min(a.maxW, box.r - box.l) : box.r - box.l;
    pot.style.maxWidth = '';
    toggle(pot, 'is-stacked', false);
    setHidden(potSplit, !potSplit._t);
    if (!potSplit.hidden && pot.offsetWidth > maxW) setHidden(potSplit, true);
    if (pot.offsetWidth > maxW) toggle(pot, 'is-stacked', true);
    // maxW drops the breakdown, then stacks label over amount; the total itself is never clipped.
    pot.style.maxWidth = `${Math.floor(Math.max(maxW, pot.offsetWidth))}px`;
    const pw = pot.offsetWidth;
    const ph = pot.offsetHeight;
    let l;
    let t;
    if (a.align === 'left-of-chips') {
      l = a.x - pw;
      t = a.y - ph / 2;
    } else {
      l = a.x - pw / 2;
      t = a.y - ph / 2;
    }
    l = Math.min(Math.max(l, box.l), box.r - pw);
    t = Math.min(Math.max(t, box.t), box.b - ph);
    if (board && hit({ l, t, r: l + pw, b: t + ph }, board, 4)) {
      t = Math.max(box.t, board.t - 4 - ph);
    }
    pot.style.transform = `translate3d(${Math.round(l)}px, ${Math.round(t)}px, 0)`;
    return { l: Math.round(l), t: Math.round(t), r: Math.round(l) + pw, b: Math.round(t) + ph };
  }

  /**
   * Moves a covered plate along its screen edge until it clears every overlay, or reports failure. A slide may
   * not cover any spot where cards, bets or the button can land (`felt`, from the stage); without that, it
   * may not carry the plate inside the felt's tangent line at its anchor, where the seat's own cards lie.
   */
  function slide(it, overlays, placed, box, felt, potRect) {
    const cands = [];
    const edgeX = it.ux > 0 ? box.r - it.hw : box.l + it.hw;
    const edgeY = it.uy > 0 ? box.b - it.hh : box.t + it.hh;
    for (const o of overlays) {
      if (it.side) {
        for (const cy of [o.t - GAP - it.hh, o.b + GAP + it.hh]) cands.push({ cx: it.cx, cy }, { cx: edgeX, cy });
      } else {
        for (const cx of [o.l - GAP - it.hw, o.r + GAP + it.hw]) cands.push({ cx, cy: it.cy }, { cx, cy: edgeY });
      }
    }
    cands.sort((p, q) => Math.hypot(p.cx - it.cx, p.cy - it.cy) - Math.hypot(q.cx - it.cx, q.cy - it.cy));
    for (const c of cands) {
      const r = { l: c.cx - it.hw, t: c.cy - it.hh, r: c.cx + it.hw, b: c.cy + it.hh };
      if (r.l < box.l - 0.5 || r.r > box.r + 0.5 || r.t < box.t - 0.5 || r.b > box.b + 0.5) continue;
      if (felt) {
        if (felt.some((o) => hit(r, o, PUSH_GAP))) continue;
      } else {
        const depth = Math.min((r.l - it.ax) * it.ux, (r.r - it.ax) * it.ux) + Math.min((r.t - it.ay) * it.uy, (r.b - it.ay) * it.uy);
        if (depth < -SLIDE_TOL) continue;
      }
      if (overlays.some((o) => hit(r, o))) continue;
      if (potRect && hit(r, potRect, GAP)) continue;
      if (placed.some((q) => q !== it && !q.covered && hit(r, rectAt(q), GAP))) continue;
      it.cx = c.cx;
      it.cy = c.cy;
      return true;
    }
    return false;
  }

  const rectAt = (it) => ({ l: it.cx - it.hw, t: it.cy - it.hh, r: it.cx + it.hw, b: it.cy + it.hh });

  function clampItem(it, box) {
    it.cx = Math.min(Math.max(it.cx, box.l + it.hw), box.r - it.hw);
    it.cy = Math.min(Math.max(it.cy, box.t + it.hh), box.b - it.hh);
  }

  function layout() {
    // Hidden (display:none) there is nothing to measure; the ResizeObserver on root re-runs this once shown.
    if (!root.offsetWidth || !root.offsetHeight) return;
    applySize();
    const { w, h } = viewport();
    const sa = safe();
    const m = metrics();
    const box = { l: m.left, t: m.top, r: w - m.right, b: h - m.bottom };
    const boardPos = sp(null, 'board');
    const board = rectOf(boardPos);
    const centre = boardPos && finite(boardPos.x, boardPos.y) && board ? { x: boardPos.x, y: boardPos.y } : { x: w / 2, y: (box.t + box.b) / 2 };

    const room = board ? Math.floor(w - board.r - 8 - sa.r - (size === 'compact' ? 10 : 16)) : null;
    if (room !== barRoom) {
      barRoom = room;
      if (room == null) document.documentElement.style.removeProperty('--bar-room');
      else document.documentElement.style.setProperty('--bar-room', `${room}px`);
    }

    const items = [];
    for (const s of seatEls) {
      if (!s) continue;
      const a = sp(s.seat, 'plate');
      if (!a || !finite(a.x, a.y)) {
        s.plate.style.visibility = 'hidden';
        continue;
      }
      let ux = a.ux;
      let uy = a.uy;
      if (!finite(ux, uy) || (!ux && !uy)) {
        const dx = a.x - centre.x;
        const dy = a.y - centre.y;
        const n = Math.hypot(dx, dy) || 1;
        ux = dx / n;
        uy = dy / n;
      }
      const hw = s.dims.w / 2;
      const hh = s.dims.h / 2;
      const d = hw * Math.abs(ux) + hh * Math.abs(uy);
      const it = { s, cx: a.x + ux * d, cy: a.y + uy * d, hw, hh, ax: a.x, ay: a.y, ux, uy, side: Math.abs(ux) >= Math.abs(uy), covered: false };
      clampItem(it, box);
      items.push(it);
    }

    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const A = items[i];
          const B = items[j];
          const ra = rectAt(A);
          const rb = rectAt(B);
          const ox = Math.min(ra.r, rb.r) - Math.max(ra.l, rb.l) + PUSH_GAP;
          const oy = Math.min(ra.b, rb.b) - Math.max(ra.t, rb.t) + PUSH_GAP;
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const dir = A.cx <= B.cx ? -1 : 1;
            A.cx += (dir * ox) / 2;
            B.cx -= (dir * ox) / 2;
          } else {
            const dir = A.cy <= B.cy ? -1 : 1;
            A.cy += (dir * oy) / 2;
            B.cy -= (dir * oy) / 2;
          }
          clampItem(A, box);
          clampItem(B, box);
          moved = true;
        }
      }
      if (!moved) break;
    }

    const potRect = placePot(w, h, box, board);
    sizeResults(w, h, sa, m, board, potRect, items);

    const resultsRect = results.rect();
    const overlays = [];
    if (barRect) overlays.push(barRect);
    if (resultsRect) overlays.push(resultsRect);
    if (!status.hidden) overlays.push(offsetRect(status));

    const feltPos = sp(null, 'felt');
    const felt = Array.isArray(feltPos) ? feltPos.map(rectOf).filter(Boolean) : null;
    for (const it of items) {
      if (overlays.some((o) => hit(rectAt(it), o)) && !slide(it, overlays, items, box, felt, potRect)) it.covered = true;
    }

    for (const it of items) {
      const { s } = it;
      s.plate.style.visibility = '';
      toggle(s.plate, 'is-covered', it.covered);
      s.plate.style.transform = `translate3d(${Math.round(it.cx - it.hw)}px, ${Math.round(it.cy - it.hh)}px, 0)`;
    }

    if (potRect) {
      const potBlockers = overlays.filter((o) => o !== resultsRect);
      const blocked = potBlockers.some((o) => hit(potRect, o)) || items.some((it) => !it.covered && hit(potRect, rectAt(it)));
      toggle(pot, 'is-covered', blocked);
    } else toggle(pot, 'is-covered', false);
  }

  function destroy() {
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onDocKey);
    ro.disconnect();
    document.documentElement.style.removeProperty('--bar-room');
    root.replaceChildren();
    root.classList.remove('hud');
    delete root.dataset.size;
    seatEls.length = 0;
  }

  applySize();
  ready = true;
  /** Re-renders the last state, e.g. after the connection changed. */
  const refresh = () => lastDs && render(lastDs);

  return { render, refresh, layout, metrics, setBar, destroy, get sizeClass() { return { size }; } };
}
