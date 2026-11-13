import { validateConfig, TURN_SECONDS_OPTIONS, NAME_MAX, CODE_LENGTH, CODE_ALPHABET, MAX_SEATS } from '../shared/protocol.js';
import { el, button, fmtChips, confirmDialog } from './hud.js';

const DEFAULTS = { buyIn: 1000, smallBlind: 5, bigBlind: 10, turnSeconds: 30 };
const CODE_STRIP = new RegExp(`[^${CODE_ALPHABET}]`, 'g');

function suggestBlinds(buyIn) {
  const target = Math.max(1, buyIn / 100);
  const mag = 10 ** Math.floor(Math.log10(target));
  const bb = [5, 2, 1].map((m) => m * mag).find((v) => v <= target) ?? 1;
  return { bigBlind: bb, smallBlind: bb === 1 ? 1 : Math.floor(bb / 2) };
}

function field(label, input, hint) {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'field-label', label), input);
  if (hint) wrap.append(el('span', 'field-hint', hint));
  return wrap;
}

function numberInput(value) {
  const i = el('input', 'input input-num');
  Object.assign(i, { type: 'text', inputMode: 'numeric', autocomplete: 'off', value: String(value) });
  i.setAttribute('enterkeyhint', 'next');
  return i;
}

function intOf(input) {
  const digits = input.value.replace(/[^0-9]/g, '');
  return digits ? Number(digits) : NaN;
}

function shareLinks(view) {
  const code = view.room.code;
  const out = [];
  const seen = new Set();
  const add = (base, label) => {
    if (!base) return;
    const url = `${String(base).replace(/\/+$/, '')}/?room=${code}`;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ label, url });
  };
  add(view.room.share?.tunnel, 'Anywhere — internet link');
  for (const lan of view.room.share?.lan || []) add(lan, 'Same Wi-Fi');
  add(location.origin, 'This address');
  return out;
}

async function copyText(input, text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to manual selection */ }
  }
  input.focus({ preventScroll: true });
  input.select();
  input.setSelectionRange(0, text.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/**
 * @param {HTMLElement} root
 * @param {{onCreate:(a:{name:string, config:object})=>void, onJoin:(a:{code:string, name:string})=>void,
 *          onStart:()=>void, onCloseTable:()=>void, onLeave:()=>void, toastHost?:()=>HTMLElement}} handlers
 */
export function createLobby(root, handlers) {
  const toastHost = handlers.toastHost || (() => document.body);
  root.classList.add('screens');
  root.replaceChildren();
  const scrim = el('div', 'screens-scrim');
  const toast = el('div', 'toast glass');
  toast.setAttribute('role', 'alert');
  root.append(scrim);

  let mode = null;
  let card = null;
  let errorEl = null;
  let toastTimer = 0;

  function open(nextMode, build) {
    if (mode !== nextMode) {
      mode = nextMode;
      card = build();
      scrim.replaceChildren(card);
      scrim.scrollTop = 0;
    }
    root.classList.add('is-open');
    return card;
  }

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
    if (message) {
      errorEl.classList.remove('shake');
      void errorEl.offsetWidth;
      errorEl.classList.add('shake');
    }
  }

  // ---------- home ----------
  let home = null;
  function buildHome() {
    const c = el('div', 'card glass card-home');
    const brand = el('div', 'brand');
    const suits = el('div', 'brand-suits');
    for (const [s, red] of [['♠', 0], ['♥', 1], ['♦', 1], ['♣', 0]]) suits.append(el('span', red ? 'suit red' : 'suit', s));
    brand.append(suits, el('h1', 'brand-title', 'Poker Night'), el('p', 'brand-sub', 'No-Limit Texas Hold’em with friends'));

    const name = el('input', 'input');
    Object.assign(name, { type: 'text', maxLength: NAME_MAX, autocomplete: 'nickname', spellcheck: false, placeholder: 'e.g. Alex' });
    name.setAttribute('enterkeyhint', 'next');
    name.setAttribute('autocapitalize', 'words');
    const nameField = field('Your name', name);

    const tabs = el('div', 'seg seg-tabs');
    tabs.setAttribute('role', 'tablist');
    const joinTab = button('seg-btn', 'Join table', () => setTab('join'));
    const createTab = button('seg-btn', 'Create table', () => setTab('create'));
    joinTab.setAttribute('role', 'tab');
    createTab.setAttribute('role', 'tab');
    tabs.append(joinTab, createTab);

    const joinForm = el('form', 'pane');
    joinForm.noValidate = true;
    const code = el('input', 'input input-code');
    Object.assign(code, { type: 'text', maxLength: CODE_LENGTH, autocomplete: 'off', spellcheck: false, placeholder: '• • • •' });
    code.setAttribute('autocapitalize', 'characters');
    code.setAttribute('enterkeyhint', 'go');
    code.setAttribute('aria-label', 'Room code');
    const joinBtn = el('button', 'btn btn-primary btn-block', 'Join table');
    joinBtn.type = 'submit';
    joinForm.append(field('Room code', code, `${CODE_LENGTH} characters, from the host’s screen`), joinBtn);

    const createForm = el('form', 'pane');
    createForm.noValidate = true;
    const buyIn = numberInput(DEFAULTS.buyIn);
    const sb = numberInput(DEFAULTS.smallBlind);
    const bb = numberInput(DEFAULTS.bigBlind);
    const grid = el('div', 'field-grid');
    const buyInField = field('Buy-in', buyIn);
    buyInField.classList.add('span-2');
    grid.append(buyInField, field('Small blind', sb), field('Big blind', bb));
    const timerSeg = el('div', 'seg seg-timer');
    timerSeg.setAttribute('role', 'radiogroup');
    timerSeg.setAttribute('aria-label', 'Turn timer');
    let turnSeconds = DEFAULTS.turnSeconds;
    const timerBtns = TURN_SECONDS_OPTIONS.map((sec) => {
      const b = button('seg-btn', `${sec}s`, () => { turnSeconds = sec; syncTimer(); validate(); });
      b.setAttribute('role', 'radio');
      timerSeg.append(b);
      return { sec, b };
    });
    const timerField = el('div', 'field');
    timerField.append(el('span', 'field-label', 'Turn timer'), timerSeg);
    const configErr = el('p', 'form-error');
    configErr.hidden = true;
    const createBtn = el('button', 'btn btn-primary btn-block', 'Create table');
    createBtn.type = 'submit';
    createForm.append(grid, timerField, configErr, createBtn);

    const err = el('p', 'form-error form-error-main');
    err.setAttribute('role', 'alert');
    err.hidden = true;

    c.append(brand, nameField, tabs, joinForm, createForm, err);

    function syncTimer() {
      for (const { sec, b } of timerBtns) {
        b.classList.toggle('is-active', sec === turnSeconds);
        b.setAttribute('aria-checked', String(sec === turnSeconds));
      }
    }
    syncTimer();

    function setTab(tab) {
      joinForm.hidden = tab !== 'join';
      createForm.hidden = tab !== 'create';
      joinTab.classList.toggle('is-active', tab === 'join');
      createTab.classList.toggle('is-active', tab === 'create');
      joinTab.setAttribute('aria-selected', String(tab === 'join'));
      createTab.setAttribute('aria-selected', String(tab === 'create'));
      showError('');
    }

    function config() {
      return { buyIn: intOf(buyIn), smallBlind: intOf(sb), bigBlind: intOf(bb), turnSeconds };
    }

    function validate() {
      const msg = validateConfig(config());
      configErr.textContent = msg || '';
      configErr.hidden = !msg;
      createBtn.disabled = !!msg;
      for (const i of [buyIn, sb, bb]) i.classList.toggle('is-invalid', !!msg && !(intOf(i) > 0));
      return !msg;
    }

    const digitsOnly = (i) => i.addEventListener('input', () => {
      const d = i.value.replace(/[^0-9]/g, '');
      if (d !== i.value) i.value = d;
    });
    [buyIn, sb, bb].forEach(digitsOnly);
    buyIn.addEventListener('input', () => {
      const v = intOf(buyIn);
      if (v > 0) {
        const s = suggestBlinds(v);
        sb.value = String(s.smallBlind);
        bb.value = String(s.bigBlind);
      }
      validate();
    });
    sb.addEventListener('input', validate);
    bb.addEventListener('input', validate);
    for (const i of [buyIn, sb, bb]) {
      i.addEventListener('blur', () => { if (intOf(i) > 0) i.value = String(intOf(i)); });
    }

    code.addEventListener('input', () => {
      const v = code.value.toUpperCase().replace(CODE_STRIP, '').slice(0, CODE_LENGTH);
      if (v !== code.value) code.value = v;
      joinBtn.disabled = v.length !== CODE_LENGTH;
    });

    function requireName() {
      const n = name.value.trim();
      if (!n) {
        showError('Enter your name first');
        name.focus();
        return null;
      }
      return n.slice(0, NAME_MAX);
    }

    joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = requireName();
      if (!n) return;
      if (code.value.length !== CODE_LENGTH) {
        showError(`Room codes are ${CODE_LENGTH} characters`);
        code.focus();
        return;
      }
      showError('');
      handlers.onJoin?.({ code: code.value, name: n });
    });
    createForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const n = requireName();
      if (!n || !validate()) return;
      showError('');
      handlers.onCreate?.({ name: n, config: config() });
    });
    name.addEventListener('input', () => { if (name.value.trim()) showError(''); });

    validate();
    joinBtn.disabled = true;
    return { c, err, name, code, setTab };
  }

  function showHome({ code, name, error } = {}) {
    if (!home || mode !== 'home') {
      home = buildHome();
      open('home', () => home.c);
      home.setTab(code ? 'join' : 'create');
    } else {
      open('home', () => home.c);
    }
    errorEl = home.err;
    if (name != null && !home.name.value) home.name.value = String(name).slice(0, NAME_MAX);
    if (code) {
      home.code.value = String(code).toUpperCase().replace(CODE_STRIP, '').slice(0, CODE_LENGTH);
      home.code.dispatchEvent(new Event('input'));
      home.setTab('join');
    }
    showError(error || '');
  }

  // ---------- waiting room ----------
  let wait = null;
  function buildWaiting() {
    const c = el('div', 'card glass card-wait');
    const head = el('div', 'wait-head');
    head.append(el('span', 'eyebrow', 'Room code'));
    const codeTiles = el('div', 'code-tiles');
    codeTiles.setAttribute('aria-live', 'polite');
    head.append(codeTiles);

    const playersSec = el('section', 'wait-sec');
    const playersHead = el('div', 'sec-head');
    const playersTitle = el('h2', 'sec-title', 'Players');
    const playersCount = el('span', 'sec-meta');
    playersHead.append(playersTitle, playersCount);
    const list = el('ul', 'player-list');
    playersSec.append(playersHead, list);

    const shareSec = el('section', 'wait-sec');
    const shareHead = el('div', 'sec-head');
    shareHead.append(el('h2', 'sec-title', 'Invite friends'));
    const shareList = el('div', 'share-list');
    shareSec.append(shareHead, shareList);

    const settings = el('div', 'settings-row');

    const actions = el('div', 'wait-actions');
    const startBtn = button('btn btn-primary btn-block btn-lg', 'Start game', () => handlers.onStart?.());
    const startHint = el('p', 'hint');
    const waitMsg = el('p', 'waiting-msg');
    waitMsg.append(el('span', 'dots'), document.createTextNode('Waiting for host to start'));
    const closeBtn = button('btn btn-ghost btn-danger-text', 'Close table', async () => {
      const ok = await confirmDialog({
        title: 'Close the table?',
        body: 'This ends the session for everyone and shows the final scoreboard.',
        confirmLabel: 'Close table',
        danger: true,
      });
      if (ok) handlers.onCloseTable?.();
    });
    const leaveBtn = button('btn btn-ghost', 'Leave', () => handlers.onLeave?.());
    actions.append(startBtn, startHint, waitMsg, closeBtn, leaveBtn);

    const err = el('p', 'form-error form-error-main');
    err.setAttribute('role', 'alert');
    err.hidden = true;

    const main = el('div', 'wait-col wait-main');
    const side = el('div', 'wait-col wait-side');
    const rotateHint = el('p', 'rotate-hint', 'The table plays sideways — turn your phone when the game starts');
    main.append(head, settings, playersSec, err, actions, rotateHint);
    side.append(shareSec);
    c.append(main, side);
    return { c, err, codeTiles, list, playersCount, shareList, settings, startBtn, startHint, waitMsg, closeBtn, leaveBtn, keys: {} };
  }

  function renderShare(w, view) {
    const links = shareLinks(view);
    const key = links.map((l) => l.url).join('|');
    if (w.keys.share === key) return;
    w.keys.share = key;
    w.shareList.replaceChildren(...links.map(({ label, url }) => {
      const rowEl = el('div', 'share-row');
      rowEl.append(el('span', 'share-label', label));
      const line = el('div', 'share-line');
      const input = el('input', 'input share-url');
      Object.assign(input, { type: 'text', readOnly: true, value: url, spellcheck: false });
      input.setAttribute('aria-label', label);
      input.addEventListener('focus', () => input.select());
      const copy = button('btn btn-small', 'Copy', async () => {
        const ok = await copyText(input, url);
        copy.textContent = ok ? 'Copied' : 'Selected';
        copy.classList.toggle('is-done', ok);
        setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('is-done'); }, 1800);
      });
      line.append(input, copy);
      if (navigator.share) {
        const share = button('btn btn-small btn-ghost', 'Share', () => {
          navigator.share({ title: 'Poker Night', text: `Join my poker table — room ${view.room.code}`, url }).catch(() => {});
        });
        line.append(share);
      }
      rowEl.append(line);
      return rowEl;
    }));
  }

  function showWaiting(view) {
    if (!wait || mode !== 'waiting') {
      wait = buildWaiting();
      open('waiting', () => wait.c);
    } else {
      open('waiting', () => wait.c);
    }
    errorEl = wait.err;
    const w = wait;
    const { room, seats, you } = view;

    if (w.keys.code !== room.code) {
      w.keys.code = room.code;
      w.codeTiles.replaceChildren(...[...room.code].map((ch) => el('span', 'code-tile', ch)));
      w.codeTiles.setAttribute('aria-label', `Room code ${room.code.split('').join(' ')}`);
    }

    const seated = seats.filter(Boolean);
    const listKey = JSON.stringify(seats.map((s) => s && [s.name, s.isHost, s.connected, s.away]).concat(you.seat));
    if (w.keys.list !== listKey) {
      w.keys.list = listKey;
      const items = [];
      for (const s of seated) {
        const li = el('li', 'player');
        li.classList.toggle('is-offline', !s.connected);
        const av = el('span', 'player-av', [...s.name.trim()][0]?.toUpperCase() || '?');
        const nm = el('span', 'player-name', s.name);
        const badges = el('span', 'player-badges');
        if (s.seat === you.seat) badges.append(el('span', 'badge badge-you', 'You'));
        if (s.isHost) badges.append(el('span', 'badge badge-host', 'Host'));
        const dot = el('span', 'status-dot');
        dot.title = s.connected ? (s.away ? 'Away' : 'Connected') : 'Disconnected';
        dot.classList.toggle('is-away', s.connected && s.away);
        li.append(av, nm, badges, dot);
        items.push(li);
      }
      const open = MAX_SEATS - seated.length;
      if (open > 0) {
        const li = el('li', 'player player-empty');
        li.append(el('span', 'player-av'), el('span', 'player-name', `${open} open seat${open === 1 ? '' : 's'}`));
        items.push(li);
      }
      w.list.replaceChildren(...items);
      w.playersCount.textContent = `${seated.length} / ${MAX_SEATS}`;
    }

    renderShare(w, view);

    const cfg = room.config;
    const cfgKey = JSON.stringify(cfg);
    if (w.keys.cfg !== cfgKey) {
      w.keys.cfg = cfgKey;
      const stat = (label, value) => {
        const d = el('div', 'stat');
        d.append(el('span', 'stat-label', label), el('span', 'stat-value', value));
        return d;
      };
      w.settings.replaceChildren(
        stat('Buy-in', fmtChips(cfg.buyIn)),
        stat('Blinds', `${fmtChips(cfg.smallBlind)} / ${fmtChips(cfg.bigBlind)}`),
        stat('Timer', `${cfg.turnSeconds}s`),
      );
    }

    const host = !!you.isHost;
    const enough = seated.length >= 2;
    w.startBtn.hidden = !host;
    w.startBtn.disabled = !enough;
    w.startHint.hidden = !host || enough;
    w.startHint.textContent = 'Need at least 2 players to start';
    w.waitMsg.hidden = host;
    w.closeBtn.hidden = !host;
    w.leaveBtn.hidden = host;
  }

  // ---------- scoreboard ----------
  function showScoreboard(rows, { onNewTable } = {}) {
    mode = null;
    open('scoreboard', () => {
      const c = el('div', 'card glass card-score');
      const head = el('div', 'score-head');
      head.append(el('span', 'eyebrow', 'Table closed'), el('h1', 'score-title', 'Final standings'));
      const list = el('ol', 'score-list');
      rows.forEach((r, i) => {
        const li = el('li', 'score-row');
        if (i === 0 && rows.length > 1) li.classList.add('is-winner');
        li.append(el('span', 'score-rank', i === 0 ? '♛' : String(i + 1)));
        const who = el('span', 'score-who');
        who.append(el('span', 'score-name', r.name), el('span', 'score-sub', `${r.handsWon} hand${r.handsWon === 1 ? '' : 's'} won`));
        const nums = el('span', 'score-nums');
        const net = el('span', `score-net ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : 'zero'}`, `${r.net > 0 ? '+' : r.net < 0 ? '−' : '±'}${fmtChips(Math.abs(r.net))}`);
        nums.append(el('span', 'score-stack', fmtChips(r.stack)), net);
        li.append(who, nums);
        list.append(li);
      });
      if (!rows.length) list.append(el('li', 'score-empty', 'No hands were played.'));
      const back = button('btn btn-primary btn-block btn-lg', 'Back to home', () => onNewTable?.());
      const err = el('p', 'form-error form-error-main');
      err.hidden = true;
      errorEl = err;
      c.append(head, list, back, err);
      return c;
    });
  }

  function showConnecting(text = 'Connecting…') {
    mode = null;
    errorEl = null;
    open('connecting', () => {
      const c = el('div', 'card glass card-connecting');
      c.append(el('div', 'spinner'), el('p', 'connecting-text'));
      return c;
    });
    card.querySelector('.connecting-text').textContent = text;
    mode = 'connecting';
  }

  function showNotice({ title, body, actionLabel, onAction, secondaryLabel, onSecondary }) {
    mode = null;
    open('notice', () => {
      const c = el('div', 'card glass card-notice');
      c.append(el('h1', 'notice-title', title));
      if (body) c.append(el('p', 'notice-body', body));
      if (actionLabel) c.append(button('btn btn-primary btn-block btn-lg', actionLabel, () => onAction?.()));
      if (secondaryLabel) c.append(button('btn btn-ghost btn-block', secondaryLabel, () => onSecondary?.()));
      return c;
    });
    errorEl = null;
  }

  function setError(message) {
    if (root.classList.contains('is-open') && errorEl) {
      showError(message);
      return;
    }
    clearTimeout(toastTimer);
    if (message) {
      const host = toastHost();
      if (toast.parentNode !== host) {
        host.append(toast);
        void toast.offsetWidth;
      }
    }
    toast.textContent = message || '';
    toast.classList.toggle('show', !!message);
    if (message) toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
  }

  function hide() {
    root.classList.remove('is-open');
    mode = null;
    errorEl = null;
    home = null;
    wait = null;
    setTimeout(() => { if (!mode) scrim.replaceChildren(); }, 250);
  }

  return { showHome, showWaiting, showScoreboard, showConnecting, showNotice, setError, hide };
}
