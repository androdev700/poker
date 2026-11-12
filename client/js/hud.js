const NF = new Intl.NumberFormat('en-US');
export const fmtChips = (n) => NF.format(Math.round(n));

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

/** Modal confirm. Resolves true on confirm, false on cancel / Esc / backdrop tap. */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
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
    document.body.append(scrim);

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
const WARN_MS = 5000;

function setText(node, text) {
  if (node._t !== text) {
    node._t = text;
    node.textContent = text;
  }
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function initialOf(name) {
  const first = [...(name || '?').trim()][0] || '?';
  return first.toUpperCase();
}

/**
 * @param {HTMLElement} root
 * @param {{screenPos:(seat:number|null, spot:'plate'|'bet'|'pot'|'board')=>({x:number,y:number}|null),
 *          onMuteToggle:()=>void, onCloseTable:()=>void, onStart:()=>void, isMuted:()=>boolean,
 *          bottomInset?:()=>number}} opts   bottomInset = px at the bottom that nameplates must stay clear of
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
  tools.append(muteBtn, menuBtn, menu);
  top.append(info, tools);
  top.hidden = true;

  const betLayer = el('div', 'hud-layer');
  const plateLayer = el('div', 'hud-layer');
  const pot = el('div', 'hud-pot');
  const potLabel = el('span', 'hud-pot-label', 'Pot');
  const potAmt = el('span', 'hud-pot-amt');
  pot.append(potLabel, potAmt);
  pot.hidden = true;
  const banner = el('div', 'hud-banner');
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  const bannerText = el('span', 'hud-banner-text');
  const dealBtn = button('btn btn-primary hud-deal', 'Deal next hand', () => opts.onStart?.());
  banner.append(bannerText, dealBtn);
  const outChip = el('div', 'hud-out glass', 'You’re out — spectating');
  outChip.hidden = true;

  const safeProbe = el('div', 'hud-safe-probe');
  root.append(safeProbe, betLayer, pot, plateLayer, banner, top, outChip);

  const seatEls = [];
  let seatSig = '';
  let sawHandIn = null;
  let menuOpen = false;
  let timerSeat = null;
  let closing = false;
  let potAboveBoard = false;

  function onDocPointer(e) {
    if (menuOpen && !menu.contains(e.target) && e.target !== menuBtn) toggleMenu(false);
  }
  function onDocKey(e) {
    if (menuOpen && e.key === 'Escape') toggleMenu(false);
  }
  document.addEventListener('pointerdown', onDocPointer);
  document.addEventListener('keydown', onDocKey);

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

  function makeSeat(seat) {
    const plate = el('div', 'plate');
    const bubble = el('div', 'plate-bubble');
    const win = el('div', 'plate-win');
    const av = el('div', 'plate-av');
    av.innerHTML = `<svg class="plate-ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="ring-bg" cx="24" cy="24" r="${RING_R}"/><circle class="ring-fg" cx="24" cy="24" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="0"/></svg>`;
    const ring = av.querySelector('.ring-fg');
    const initial = el('span', 'plate-initial');
    const dealer = el('span', 'plate-dealer', 'D');
    const blind = el('span', 'plate-blind');
    av.append(initial, dealer, blind);
    const body = el('div', 'plate-body');
    const nameRow = el('div', 'plate-name-row');
    const name = el('span', 'plate-name');
    const you = el('span', 'plate-you', 'You');
    nameRow.append(name, you);
    const stack = el('div', 'plate-stack');
    const tag = el('span', 'plate-tag');
    body.append(nameRow, stack);
    const handName = el('div', 'plate-hand');
    plate.append(bubble, win, av, body, tag, handName);
    plateLayer.append(plate);

    const bet = el('div', 'hud-bet');
    const betAmt = el('span', 'hud-bet-amt');
    bet.append(el('i', 'chip-dot'), betAmt);
    bet.hidden = true;
    betLayer.append(bet);

    return { seat, plate, bubble, win, ring, initial, dealer, blind, name, you, stack, tag, handName, bet, betAmt, cls: {} };
  }

  function cls(s, name, on) {
    if (s.cls[name] !== on) {
      s.cls[name] = on;
      s.plate.classList.toggle(name, on);
    }
  }

  function removeSeat(i) {
    const s = seatEls[i];
    if (!s) return;
    s.plate.remove();
    s.bet.remove();
    seatEls[i] = undefined;
  }

  function updateSeat(s, sv, ds) {
    const { hand, you } = ds;
    const p = hand?.players?.[s.seat];
    const live = !!hand && hand.phase !== 'complete';
    setText(s.name, sv.name);
    setText(s.initial, initialOf(sv.name));
    setText(s.stack, sv.busted ? 'Out' : fmtChips(sv.stack));

    const isYou = s.seat === you?.seat;
    setHidden(s.you, !isYou);
    setHidden(s.dealer, !(hand && hand.button === s.seat));
    const blind = hand && hand.sbSeat === s.seat ? 'SB' : hand && hand.bbSeat === s.seat ? 'BB' : '';
    setText(s.blind, blind);
    setHidden(s.blind, !blind);

    const folded = !!p?.folded;
    const allIn = !!p?.allIn;
    const tag = sv.busted ? '' : allIn ? 'All-in' : !sv.connected ? 'Offline' : sv.away ? 'Away' : '';
    setText(s.tag, tag);
    setHidden(s.tag, !tag);
    const kind = allIn ? 'allin' : 'status';
    if (s.tag.dataset.kind !== kind) s.tag.dataset.kind = kind;

    const bubble = ds.bubbles?.[s.seat] || '';
    if (s.bubble._t !== bubble) {
      setText(s.bubble, bubble);
      s.bubble.classList.remove('pop');
      if (bubble) {
        void s.bubble.offsetWidth;
        s.bubble.classList.add('pop');
      }
    }

    const won = ds.winners?.[s.seat];
    setText(s.win, won ? `+${fmtChips(won)}` : '');
    const handName = ds.handNames?.[s.seat] || '';
    setText(s.handName, handName);

    cls(s, 'is-you', isYou);
    cls(s, 'is-turn', live && hand.toAct === s.seat);
    cls(s, 'is-folded', folded);
    cls(s, 'is-allin', allIn);
    cls(s, 'is-away', sv.away || !sv.connected);
    cls(s, 'is-busted', !!sv.busted);
    cls(s, 'is-winner', won != null && won > 0);
    cls(s, 'has-bubble', !!bubble);
    cls(s, 'has-hand', !!handName);

    const betAmt = p && p.streetBet > 0 ? p.streetBet : 0;
    setHidden(s.bet, !betAmt);
    if (betAmt) setText(s.betAmt, fmtChips(betAmt));
  }

  function updateTimer(ds) {
    const hand = ds.hand;
    const live = hand && hand.phase !== 'complete' && hand.toAct != null && ds.turnEndsAt != null && hand.turnMs > 0;
    const seat = live ? hand.toAct : null;
    if (timerSeat !== seat && timerSeat != null && seatEls[timerSeat]) {
      const prev = seatEls[timerSeat];
      prev.ring.style.strokeDashoffset = '0';
      cls(prev, 'is-warn', false);
      cls(prev, 'has-timer', false);
    }
    timerSeat = seat;
    const s = seat != null ? seatEls[seat] : null;
    if (!s) return;
    const left = Math.max(0, ds.turnEndsAt - performance.now());
    const frac = Math.min(1, left / hand.turnMs);
    s.ring.style.strokeDashoffset = String(RING_C * (1 - frac));
    cls(s, 'has-timer', true);
    cls(s, 'is-warn', left <= WARN_MS);
  }

  function render(ds) {
    const { room, seats, hand, you } = ds;
    setHidden(top, false);
    syncMute();

    if (hand) sawHandIn = room.code;
    const handsPlayed = !!hand || sawHandIn === room.code;
    setText(codeEl, room.code);
    setText(blindsEl, `${fmtChips(room.config.smallBlind)}/${fmtChips(room.config.bigBlind)}`);
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
    setHidden(dealBtn, !canDeal);

    const sig = seats.map((sv) => (sv ? 1 : 0)).join('') + ':' + (you?.seat ?? '');
    for (let i = 0; i < seats.length; i++) {
      const sv = seats[i];
      if (!sv) { removeSeat(i); continue; }
      if (!seatEls[i]) seatEls[i] = makeSeat(i);
      updateSeat(seatEls[i], sv, ds);
    }
    for (let i = seats.length; i < seatEls.length; i++) removeSeat(i);

    const potTotal = hand?.potTotal ?? 0;
    setHidden(pot, !(hand && potTotal > 0));
    if (potTotal > 0) setText(potAmt, fmtChips(potTotal));

    const bannerMsg = waiting ? 'Waiting for players to come back…' : ds.banner || '';
    setText(bannerText, bannerMsg);
    setHidden(bannerText, !bannerMsg);
    placeBanner();
    banner.classList.toggle('show', !!bannerMsg || canDeal);

    const me = you?.seat != null ? seats[you.seat] : null;
    setHidden(outChip, !me?.busted);

    updateTimer(ds);
    if (sig !== seatSig) {
      seatSig = sig;
      layout();
    }
  }

  function place(node, pos, clampBox) {
    if (!pos) {
      node.style.visibility = 'hidden';
      return null;
    }
    let { x, y } = pos;
    if (clampBox) {
      const hw = node.offsetWidth / 2;
      const hh = node.offsetHeight / 2;
      x = Math.min(Math.max(x, clampBox.l + hw), clampBox.r - hw);
      y = Math.min(Math.max(y, clampBox.t + hh), clampBox.b - hh);
    }
    node.style.visibility = '';
    node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`;
    return x;
  }

  function layout() {
    const w = root.clientWidth || innerWidth;
    const h = root.clientHeight || innerHeight;
    const sa = getComputedStyle(safeProbe);
    const topBottom = top.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
    const box = {
      l: 6 + (parseFloat(sa.paddingLeft) || 0),
      r: w - 6 - (parseFloat(sa.paddingRight) || 0),
      t: Math.max(topBottom + 6, 6),
      b: h - 6 - Math.max(parseFloat(sa.paddingBottom) || 0, opts.bottomInset?.() || 0),
    };
    const handHalf = (parseFloat(getComputedStyle(root).getPropertyValue('--hand-max')) || 190) / 2;
    for (const s of seatEls) {
      if (!s) continue;
      const x = place(s.plate, opts.screenPos(s.seat, 'plate'), box);
      if (x != null) {
        const shift = Math.max(0, handHalf - (x - box.l)) - Math.max(0, handHalf - (box.r - x));
        s.plate.style.setProperty('--edge-shift', `${Math.round(shift)}px`);
      }
      place(s.bet, opts.screenPos(s.seat, 'bet'));
    }
    const potPos = opts.screenPos(null, 'pot');
    place(pot, potPos);
    const board = opts.screenPos(null, 'board');
    if (board) {
      banner.style.left = `${Math.round(board.x)}px`;
      banner.style.top = `${Math.round(board.y)}px`;
    } else {
      banner.style.left = '50%';
      banner.style.top = '42%';
    }
    potAboveBoard = !!(board && potPos && potPos.y < board.y);
    placeBanner();
  }

  // The banner sits on whichever side of the board a visible pot label is not on. Once the pot is gone,
  // landscape keeps it above (below is the local player's cards) and portrait below (above are seats).
  function placeBanner() {
    const portrait = root.clientHeight > root.clientWidth;
    // Phones keep the banner above the board so it never covers the hole cards; it rides higher
    // while the pot label is still showing there.
    const below = potAboveBoard && !pot.hidden && !portrait;
    banner.classList.toggle('is-raised', portrait && potAboveBoard && !pot.hidden);
    if (banner.classList.contains('is-below') === below) return;
    const snap = !banner.classList.contains('show');
    if (snap) banner.style.transition = 'none';
    banner.classList.toggle('is-below', below);
    if (snap) {
      void banner.offsetWidth;
      banner.style.transition = '';
    }
  }

  function destroy() {
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onDocKey);
    root.replaceChildren();
    root.classList.remove('hud');
    seatEls.length = 0;
  }

  return { render, layout, destroy };
}
