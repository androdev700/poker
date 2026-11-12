import { eventMs, DEAL_CARD_MS } from '/shared/timing.js';
import { fmtChips } from './hud.js';

// A throttled tab (occluded window, background) can run rAF at ~1 Hz without ever reporting hidden, so a
// run of slow frames counts as stalled; a single long frame (texture upload, GC) must not.
const STALL_MS = 1000;
const SLOW_FRAME_MS = 250;
const SLOW_FRAMES = 3;
const MAX_BACKLOG = 2;
const STEP_SLACK_MS = 1500;

const VERB = { check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' };

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/**
 * Plays server updates as animation. Each event handler is a generator: plain statements patch the
 * display state, and each `yield`ed thunk starts scene work and sounds. Live playback runs the thunks and
 * awaits them; catch-up runs the same generators without them, so both paths reach the same state.
 */
export function createDirector({ stage, hud, actionbar, sound, store }) {
  let ds = emptyDs();
  let queue = [];
  let current = null;
  let busy = false;
  let loopId = 0;
  let lastFrameTs = performance.now();
  let lastFrameEnd = performance.now();
  let slowFrames = 0;
  let raf = 0;

  let shownKey = null;
  let actedKey = null;
  let turnSoundKey = null;
  let tickKey = null;
  let lastTickSec = null;
  let winSoundHand = null;

  function emptyDs() {
    return { room: null, seats: [], hand: null, you: null, turnEndsAt: null, bubbles: {}, handNames: {}, winners: {}, results: null, banner: null, highlight: null };
  }

  const mySeat = () => ds.you?.seat ?? store.session?.seat ?? -1;
  const nameOf = (seat) => ds.seats?.[seat]?.name ?? `Seat ${seat + 1}`;
  const seatOf = (seat) => ds.seats?.[seat] ?? null;
  const playerOf = (seat) => ds.hand?.players?.[seat] ?? null;
  const play = (name, opts) => sound.play(name, opts);

  function resetExtras() {
    ds.bubbles = {};
    ds.handNames = {};
    ds.winners = {};
    ds.results = null;
    ds.banner = null;
    ds.highlight = null;
    ds.showdown = undefined;
    ds.best5 = undefined;
  }

  function bannerFor(ev, showdown) {
    const ws = ev.winners.filter((w) => w.amount > 0);
    if (!ws.length) return ds.banner;
    const side = ev.potIndex > 0 ? ' side pot' : '';
    if (ws.length > 1) {
      const names = ws.map((w) => nameOf(w.seat));
      const list = names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
      return `Split${side || ' pot'} — ${list}`;
    }
    const w = ws[0];
    const hand = !ev.uncontested && showdown?.[w.seat] ? ` with ${showdown[w.seat]}` : '';
    return `${nameOf(w.seat)} wins${side} ${fmtChips(w.amount)}${hand}`;
  }

  function addToPot(n) {
    if (ds.hand) ds.hand.potTotal = Math.max(0, (ds.hand.potTotal || 0) + n);
  }

  const handlers = {
    *handStart(ev) {
      const prevButton = ds.hand?.button ?? null;
      const turnId = ds.hand?.turnId ?? 0;
      resetExtras();
      const players = {};
      for (const s of ev.seats) players[s] = { folded: false, allIn: false, streetBet: 0, committed: 0, cards: null };
      ds.turnEndsAt = null;
      if (ds.room) ds.room = { ...ds.room, status: 'playing' };
      ds.hand = {
        handId: ev.handId,
        phase: 'preflop',
        button: ev.button,
        sbSeat: ev.sbSeat,
        bbSeat: ev.bbSeat,
        board: [],
        pots: [],
        potTotal: 0,
        currentBet: 0,
        toAct: null,
        turnId,
        remainingMs: 0,
        turnMs: 0,
        players,
      };
      yield () => {
        stage.sync({ ...ds, hand: { ...ds.hand, button: prevButton ?? ev.button, players: {} } });
        return stage.moveButton(ev.button);
      };
    },

    *blind(ev) {
      const p = playerOf(ev.seat);
      const sv = seatOf(ev.seat);
      if (p) {
        p.streetBet += ev.amount;
        p.committed += ev.amount;
      }
      if (sv) sv.stack -= ev.amount;
      if (p && sv && sv.stack <= 0) p.allIn = true;
      addToPot(ev.amount);
      if (ds.hand && p) ds.hand.currentBet = Math.max(ds.hand.currentBet, p.streetBet);
      ds.bubbles[ev.seat] = ev.kind === 'small' ? 'SB' : 'BB';
      const total = p?.streetBet ?? ev.amount;
      yield () => {
        play('chips', { count: 2 });
        return stage.pushBet(ev.seat, total);
      };
    },

    *deal(ev) {
      const me = mySeat();
      const mine = ev.cards?.[me] ?? null;
      yield () => {
        const n = ev.order.length;
        for (let k = 0; k < n * 2; k++) play('deal', { delay: (k * DEAL_CARD_MS) / 1000 });
        const at = ev.order.indexOf(me);
        if (mine && at >= 0) play('flip', { delay: ((n + at) * DEAL_CARD_MS + 400) / 1000 });
        return stage.dealHole(ev.order, mine);
      };
      const p = playerOf(me);
      if (mine && p) p.cards = [...mine];
    },

    *turn(ev, entry) {
      if (!ds.hand) return;
      ds.hand.toAct = ev.seat;
      ds.hand.turnId = ev.turnId;
      const snap = entry.state.hand;
      const isLatest = snap && snap.toAct === ev.seat && snap.turnId === ev.turnId;
      ds.hand.turnMs = isLatest ? snap.turnMs : 0;
      ds.turnEndsAt = isLatest ? entry.turnEndsAt : null;
    },

    *action(ev) {
      const p = playerOf(ev.seat);
      const sv = seatOf(ev.seat);
      if (ds.hand) ds.hand.toAct = null;
      ds.turnEndsAt = null;
      if (ev.kind === 'fold') {
        if (p) p.folded = true;
        ds.bubbles[ev.seat] = 'Fold';
        yield () => {
          play('fold');
          return stage.foldHand(ev.seat);
        };
        return;
      }
      if (sv) sv.stack -= ev.added;
      if (p) {
        p.streetBet = ev.to;
        p.committed += ev.added;
        p.allIn = !!ev.allIn;
      }
      addToPot(ev.added);
      if (ds.hand) ds.hand.currentBet = Math.max(ds.hand.currentBet, ev.to);
      ds.bubbles[ev.seat] = VERB[ev.kind] || 'Bet';
      yield () => {
        if (ev.kind === 'check') play('check');
        else if (ev.allIn) {
          play('allIn');
          play('chips', { count: 6, delay: 0.3 });
        } else play('chips', { count: ev.kind === 'call' ? 3 : 5 });
        return ev.added > 0 ? stage.pushBet(ev.seat, ev.to) : null;
      };
    },

    *refund(ev) {
      const p = playerOf(ev.seat);
      const sv = seatOf(ev.seat);
      if (p) {
        p.streetBet = Math.max(0, p.streetBet - ev.amount);
        p.committed = Math.max(0, p.committed - ev.amount);
      }
      addToPot(-ev.amount);
      yield () => stage.returnBet(ev.seat, ev.amount);
      if (sv) sv.stack += ev.amount;
      if (p && sv && sv.stack > 0) p.allIn = false;
    },

    *collect(ev) {
      const h = ds.hand;
      if (h) {
        for (const p of Object.values(h.players)) p.streetBet = 0;
        h.pots = ev.pots.map((p) => ({ amount: p.amount }));
        h.currentBet = 0;
        h.potTotal = h.pots.reduce((s, p) => s + p.amount, 0);
      }
      yield () => {
        play('chips', { count: 6 });
        return stage.collectBets(ev.pots);
      };
    },

    *reveal(ev) {
      for (const { seat, cards } of ev.hands) {
        const p = playerOf(seat);
        if (p) p.cards = [...cards];
      }
      yield () =>
        Promise.all(
          ev.hands.map(({ seat, cards }, i) => {
            if (seat !== mySeat()) play('flip', { delay: i * 0.15 });
            return stage.revealHand(seat, cards);
          }),
        );
    },

    *board(ev) {
      ds.bubbles = {};
      if (ds.hand) {
        ds.hand.board.push(...ev.cards);
        ds.hand.phase = ev.street;
      }
      yield () => {
        ev.cards.forEach((_, i) => {
          play('deal', { delay: i * 0.22 });
          play('flip', { delay: i * 0.22 + 0.36 });
        });
        return stage.dealBoard(ev.cards);
      };
    },

    *showdown(ev) {
      ds.bubbles = {};
      const hidden = ev.hands.filter(({ seat }) => !playerOf(seat)?.cards);
      ds.showdown = {};
      ds.best5 = {};
      for (const { seat, cards, name, best5 } of ev.hands) {
        const p = playerOf(seat);
        if (p) p.cards = [...cards];
        ds.handNames[seat] = name;
        ds.showdown[seat] = name;
        ds.best5[seat] = best5;
      }
      yield () =>
        Promise.all(
          hidden.map(({ seat, cards }, i) => {
            play('flip', { delay: i * 0.15 });
            return stage.revealHand(seat, cards);
          }),
        );
    },

    *win(ev, entry) {
      const ws = ev.winners.filter((w) => w.amount > 0);
      for (const w of ws) ds.winners[w.seat] = (ds.winners[w.seat] || 0) + w.amount;
      const pots = (ds.results?.pots || []).filter((p) => p.index !== ev.potIndex);
      pots.push({
        index: ev.potIndex,
        amount: ev.amount,
        uncontested: !!ev.uncontested,
        winners: ev.winners.map((w) => ({ seat: w.seat, amount: w.amount })),
      });
      ds.results = { pots: pots.sort((a, b) => a.index - b.index) };
      ds.banner = bannerFor(ev, ev.uncontested ? null : ds.showdown);
      if (!ev.uncontested && ds.best5) {
        const cards = new Set(ds.highlight || []);
        for (const w of ws) for (const c of ds.best5[w.seat] || []) cards.add(c);
        ds.highlight = [...cards];
      }
      if (ds.hand?.pots?.[ev.potIndex]) ds.hand.pots[ev.potIndex].amount = 0;
      addToPot(-ev.amount);
      const handId = ds.hand?.handId;
      const me = mySeat();
      const iWin = entry.events.some((e) => e.e === 'win' && e.winners.some((w) => w.seat === me && w.amount > 0));
      const hl = ds.highlight;
      yield () => {
        if (winSoundHand !== handId) {
          winSoundHand = handId;
          play('win');
          if (iWin) {
            play('win', { delay: 0.5 });
            play('chips', { count: 8, delay: 0.9 });
            if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.([60, 40, 120]);
          }
        }
        return Promise.all([hl ? stage.highlightCards(hl) : null, stage.awardPot(ev.winners)]);
      };
      for (const w of ws) {
        const sv = seatOf(w.seat);
        const p = playerOf(w.seat);
        if (sv) sv.stack += w.amount;
        if (p) p.allIn = false;
      }
    },

    *bust(ev) {
      const sv = seatOf(ev.seat);
      if (sv) sv.busted = true;
      yield () => {
        play('bust');
        return null;
      };
    },

    *handEnd(ev) {
      for (const [seat, stack] of Object.entries(ev.stacks || {})) {
        const sv = seatOf(Number(seat));
        if (sv) sv.stack = stack;
      }
      if (ds.hand) {
        ds.hand.phase = 'complete';
        ds.hand.toAct = null;
        ds.hand.pots = [];
        ds.hand.potTotal = 0;
        for (const p of Object.values(ds.hand.players)) p.streetBet = 0;
      }
      ds.turnEndsAt = null;
    },
  };

  /** Replace the patched state with the server's truth, carrying over what lasts until the next hand. */
  function finalize(entry) {
    const prev = ds;
    const snap = clone(entry.state);
    const same = (prev.hand?.handId ?? null) === (snap.hand?.handId ?? null);
    const live = snap.hand && snap.hand.phase !== 'complete' && snap.hand.toAct != null;
    ds = {
      ...snap,
      turnEndsAt: live ? entry.turnEndsAt : null,
      bubbles: same ? prev.bubbles : {},
      handNames: same ? prev.handNames : {},
      winners: same ? prev.winners : {},
      results: same ? prev.results : null,
      banner: same ? prev.banner : null,
      highlight: same ? prev.highlight : null,
      showdown: same ? prev.showdown : undefined,
      best5: same ? prev.best5 : undefined,
    };
    store.ds = ds;
  }

  function render() {
    store.ds = ds;
    if (ds.room) hud.render(ds);
  }

  function commit(snap) {
    if (snap && ds.highlight?.length && ds.hand) stage.highlightCards(ds.highlight);
    stage.sync(ds);
    render();
  }

  const stalled = () =>
    document.hidden || slowFrames >= SLOW_FRAMES || performance.now() - lastFrameEnd > STALL_MS;

  function drainSilently(gen) {
    try {
      while (!gen.next().done);
    } catch (err) {
      console.error('director (catch-up):', err);
    }
  }

  function applySilently(ev, entry) {
    const h = handlers[ev.e];
    if (h) drainSilently(h(ev, entry));
  }

  /** Skip every pending animation and show the newest snapshot. */
  function flush() {
    loopId++;
    busy = false;
    const pending = [];
    if (current) {
      if (current.gen) drainSilently(current.gen);
      for (let i = current.i; i < current.entry.events.length; i++) applySilently(current.entry.events[i], current.entry);
      pending.push(current.entry);
    }
    current = null;
    for (const entry of queue) {
      if (pending.length) finalize(pending.at(-1));
      // Verbs from before a reconnect may belong to an older bet than the snapshot's streetBet.
      if (entry.snapshot) ds.bubbles = {};
      for (const ev of entry.events) applySilently(ev, entry);
      pending.push(entry);
    }
    queue = [];
    if (pending.length) finalize(pending.at(-1));
    commit(true);
    afterDrain();
  }

  async function playEvent(ev, entry, id) {
    const h = handlers[ev.e];
    if (!h) return true;
    const t0 = performance.now();
    const min = eventMs(ev);
    const gen = h(ev, entry);
    current.gen = gen;
    let step = gen.next();
    render();
    while (!step.done) {
      const thunk = step.value;
      const p = typeof thunk === 'function' ? thunk() : null;
      if (p) await Promise.race([p, sleep(min + STEP_SLACK_MS)]);
      if (id !== loopId) return false;
      if (stalled()) {
        flush();
        return false;
      }
      step = gen.next();
      render();
    }
    current.gen = null;
    const rest = min - (performance.now() - t0);
    if (rest > 4) await sleep(rest);
    if (id !== loopId) return false;
    if (stalled()) {
      flush();
      return false;
    }
    return true;
  }

  async function run(id) {
    try {
      while (queue.length && id === loopId) {
        if (stalled()) {
          flush();
          return;
        }
        const entry = queue.shift();
        current = { entry, i: 0, gen: null };
        while (current.i < entry.events.length) {
          const ev = entry.events[current.i++];
          if (!(await playEvent(ev, entry, id))) return;
        }
        current = null;
        finalize(entry);
        commit(false);
      }
    } catch (err) {
      console.error('director:', err);
      if (id === loopId) flush();
    } finally {
      if (id === loopId) {
        busy = false;
        current = null;
        afterDrain();
      }
    }
  }

  function pump() {
    if (busy) return;
    busy = true;
    run(++loopId);
  }

  const turnKey = (h) => (h ? `${h.handId}:${h.turnId}` : null);

  function myTurnIn(view) {
    const h = view?.hand;
    const you = view?.you;
    return !!(you?.legal && h && h.phase !== 'complete' && h.toAct === you.seat);
  }

  function afterDrain() {
    if (busy || queue.length) return;
    if (!myTurnIn(ds)) {
      if (shownKey) actionbar.hide();
      shownKey = null;
      return;
    }
    const h = ds.hand;
    const key = turnKey(h);
    if (key === actedKey) return;
    actionbar.show({
      legal: ds.you.legal,
      hand: h,
      stack: ds.seats[ds.you.seat]?.stack ?? 0,
      streetBet: h.players?.[ds.you.seat]?.streetBet ?? 0,
      bigBlind: ds.room.config.bigBlind,
    });
    shownKey = key;
    if (turnSoundKey !== key) {
      turnSoundKey = key;
      lastTickSec = null;
      tickKey = key;
      play('yourTurn');
    }
  }

  function enqueue(msg, { snapshot = false } = {}) {
    const h = msg.state?.hand;
    const entry = {
      events: Array.isArray(msg.events) ? msg.events : [],
      state: msg.state,
      snapshot,
      turnEndsAt: h && h.toAct != null && h.remainingMs > 0 ? performance.now() + h.remainingMs : null,
    };
    queue.push(entry);
    if (shownKey && !(myTurnIn(msg.state) && turnKey(h) === shownKey)) {
      actionbar.hide();
      shownKey = null;
    }
    const backlog = queue.reduce((n, e) => n + (e.events.length ? 1 : 0), 0);
    if (snapshot || stalled() || backlog > MAX_BACKLOG) {
      flush();
      return;
    }
    pump();
  }

  /** The local player just sent an action for the turn on screen. */
  function acted() {
    actedKey = shownKey;
    actionbar.hide();
    shownKey = null;
  }

  /** Re-enable the bar after the server rejected an action, if it is still our turn. */
  function refreshTurn() {
    actedKey = null;
    actionbar.hide();
    shownKey = null;
    afterDrain();
  }

  /** New socket session or leaving the table: drop pending playback; keep what is on screen. */
  function reset({ clear = false } = {}) {
    loopId++;
    busy = false;
    current = null;
    queue = [];
    actionbar.hide();
    shownKey = null;
    actedKey = null;
    if (clear) {
      ds = emptyDs();
      store.ds = ds;
      stage.sync(null);
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    slowFrames = now - lastFrameTs > SLOW_FRAME_MS ? slowFrames + 1 : 0;
    lastFrameTs = now;
    lastFrameEnd = performance.now();
    if (ds.turnEndsAt == null || !ds.room) return;
    hud.render(ds);
    if (!shownKey) return;
    const left = Math.max(0, ds.turnEndsAt - performance.now());
    actionbar.setTimeLeft(left);
    if (tickKey !== shownKey) return;
    const sec = Math.ceil(left / 1000);
    if (sec >= 1 && sec <= 5 && sec !== lastTickSec) {
      lastTickSec = sec;
      play(sec <= 2 ? 'tickUrgent' : 'tick');
    }
  }
  raf = requestAnimationFrame(frame);

  const onVisibility = () => {
    if (document.hidden && (busy || queue.length)) flush();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    enqueue,
    flush,
    acted,
    refreshTurn,
    reset,
    get ds() {
      return ds;
    },
    get turn() {
      const h = ds.hand;
      return shownKey && h ? { handId: h.handId, turnId: h.turnId } : null;
    },
    dispose() {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
