import { el, button, fmtChips, fmtTight, miniCard } from './hud.js';

const SEATS = 6;
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const potName = (index) => (index === 0 ? 'Main' : `Side ${index}`);

function listNames(names) {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Everything the panel shows, as plain data; equal models render identically. */
function model(ds, { canDeal = false, waiting = false, away = false, busted = false, myStack = null, compact = false } = {}) {
  const hand = ds.hand;
  const res = ds.results;
  const seats = ds.seats || [];
  const me = ds.you?.seat;
  const nameOf = (s) => seats[s]?.name ?? `Seat ${s + 1}`;
  const pots = res?.pots || [];
  const multi = pots.length > 1;

  const won = new Map();
  for (const pot of pots) {
    const ws = pot.winners.filter((w) => w.amount > 0);
    for (const w of ws) {
      const e = won.get(w.seat) || { amount: 0, tags: [], outright: false };
      e.amount += w.amount;
      e.tags.push(potName(pot.index));
      if (ws.length === 1) e.outright = true;
      won.set(w.seat, e);
    }
  }

  const names = ds.handNames || {};
  const shown = new Set(Object.keys(names).map(Number));
  let fallback = false;
  if (!res && !shown.size && hand?.phase === 'complete') {
    for (const [k, p] of Object.entries(hand.players || {})) if (p?.cards && !p.folded) shown.add(Number(k));
    if ([...shown].some((s) => s !== me)) fallback = true;
    else shown.clear();
  }

  const uncontested = pots.some((p) => p.uncontested);
  const clockwise = (s) => (((s - (me ?? 0)) % SEATS) + SEATS) % SEATS;
  const rows = [...new Set([...won.keys(), ...shown])]
    .map((seat) => {
      const e = won.get(seat);
      const cards = shown.has(seat) ? hand?.players?.[seat]?.cards || null : null;
      return {
        seat,
        name: nameOf(seat),
        you: seat === me,
        sub: names[seat] || (e && uncontested && !shown.has(seat) ? 'Everyone else folded' : ''),
        cards: cards ? [...cards] : null,
        amount: e ? e.amount : 0,
        tags: e && multi ? e.tags : [],
        badge: e ? (e.outright ? 'WIN' : 'SPLIT') : '',
      };
    })
    .sort((a, b) => b.amount - a.amount || clockwise(a.seat) - clockwise(b.seat));

  let title = 'Hand over';
  const winners = rows.filter((r) => r.amount > 0);
  if (winners.length) {
    const only = pots.length === 1 ? pots[0].winners.filter((w) => w.amount > 0) : [];
    title = only.length > 1
      ? `Split pot: ${listNames(only.map((w) => nameOf(w.seat)))}`
      : winners.map((r) => `${r.name} wins ${fmtChips(r.amount)}`).join(' · ');
  } else if (shown.size && !fallback) title = 'Showdown';

  const live = waiting ? 'Waiting for players to come back…' : ds.banner || '';
  return {
    open: !!(rows.length || canDeal || waiting),
    handId: hand?.handId ?? null,
    title,
    rows,
    canDeal: !!canDeal,
    waiting: !!waiting,
    away: !!away,
    busted: !!busted,
    myStack: Number.isFinite(myStack) ? myStack : null,
    compact: !!compact,
    live,
  };
}

/**
 * The end-of-hand panel, docked to the table (placement is CSS, sizing is hud.layout()). render() is called every animation step and is a no-op unless the model changed.
 * @param {HTMLElement} root
 * @param {{onStart:()=>void, onBack?:()=>void, onToggle?:()=>void}} handlers
 */
export function createResults(root, { onStart, onBack, onToggle }) {
  const panel = el('section', 'results');
  panel.setAttribute('aria-label', 'Hand results');
  panel.hidden = true;

  const head = button('results-head', null, () => {
    collapsed = !collapsed;
    paint();
    onToggle?.();
  });
  head.setAttribute('aria-expanded', 'true');
  const title = el('span', 'results-title');
  const chevron = el('span', 'results-chevron');
  chevron.innerHTML = ICON_CHEVRON;
  head.append(title, chevron);

  const rowsEl = el('div', 'results-rows');
  rowsEl.setAttribute('role', 'list');
  const foot = el('div', 'results-foot');
  const deal = button('btn btn-primary btn-block results-deal', 'Deal next hand', () => onStart?.());
  const wait = el('p', 'results-wait', 'Waiting for players to come back…');
  const back = button('btn btn-block results-back', 'You were away — tap to play', () => onBack?.());
  const meLine = el('p', 'results-me');
  const meLabel = el('span', 'results-me-label');
  const meAmt = el('span', 'results-me-amt');
  meLine.append(meLabel, meAmt);
  foot.append(meLine, back, deal, wait);

  const liveEl = el('span', 'sr-only');
  liveEl.setAttribute('role', 'status');
  liveEl.setAttribute('aria-live', 'polite');

  panel.append(head, rowsEl, foot);
  root.append(panel, liveEl);

  let m = null;
  let key = '';
  let collapsed = false;
  let collapsedFor = null;

  function rowEl(r) {
    const row = el('div', 'results-row');
    row.setAttribute('role', 'listitem');
    if (r.amount > 0) row.classList.add('is-winner');
    const badge = el('span', 'results-badge', r.badge);
    if (r.badge) badge.dataset.kind = r.badge.toLowerCase();
    const who = el('div', 'results-who');
    const name = el('div', 'results-name');
    name.append(el('span', 'results-name-text', r.name));
    if (r.you) name.append(el('span', 'results-you', 'you'));
    who.append(name);
    if (r.sub) who.append(el('div', 'results-sub', r.sub));
    const cards = el('div', 'results-cards');
    for (const c of r.cards || []) cards.append(miniCard(c));
    const amt = el('div', 'results-amt');
    if (r.amount > 0) amt.append(el('div', 'results-plus', `+${(m.compact ? fmtTight : fmtChips)(r.amount)}`));
    if (r.tags.length) amt.append(el('div', 'results-tags', r.tags.join(' · ')));
    row.append(badge, who, cards, amt);
    return row;
  }

  function paint() {
    const open = !!m?.open;
    panel.hidden = !open;
    if (!open) return;
    if (collapsedFor !== m.handId) {
      collapsedFor = m.handId;
      collapsed = false;
    }
    title.textContent = m.title;
    head.title = m.title;
    head.setAttribute('aria-expanded', String(!collapsed));
    head.setAttribute('aria-label', `${m.title}. ${collapsed ? 'Show' : 'Hide'} details`);
    panel.toggleAttribute('data-collapsed', collapsed);
    rowsEl.replaceChildren(...m.rows.map(rowEl));
    rowsEl.hidden = !m.rows.length;
    deal.hidden = !m.canDeal;
    wait.hidden = !m.waiting;
    back.hidden = !m.away;
    meLabel.textContent = m.busted ? 'You’re out — spectating' : 'Your stack';
    meAmt.textContent = m.busted || m.myStack == null ? '' : fmtChips(m.myStack);
    meLine.hidden = !(m.busted || m.myStack != null);
    foot.hidden = !(m.canDeal || m.waiting || m.away || !meLine.hidden);
  }

  function render(ds, opts) {
    m = model(ds, opts);
    if (liveEl.textContent !== m.live) liveEl.textContent = m.live;
    const k = JSON.stringify(m);
    if (k === key) return;
    key = k;
    paint();
  }

  return {
    render,
    el: panel,
    isOpen: () => !panel.hidden,
    isCollapsed: () => !panel.hidden && collapsed,
    state: () => (panel.hidden ? 'closed' : collapsed ? 'collapsed' : 'open'),
    rect() {
      if (panel.hidden) return null;
      return { l: panel.offsetLeft, t: panel.offsetTop, r: panel.offsetLeft + panel.offsetWidth, b: panel.offsetTop + panel.offsetHeight };
    },
  };
}
