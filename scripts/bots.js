import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { seededRng } from '../server/engine/deck.js';
import { MAX_SEATS, WS_CLOSE_REPLACED } from '../shared/protocol.js';

const TURN_SECONDS = 15;
const WATCHDOG_MS = 10_000;
const DROP_RATE = 0.003;
const RECONNECT_KINDS = ['replace', 'close', 'terminate'];
const AGREEMENT_WINDOW = 512;
const CARD_RE = /^[2-9TJQKA][cdhs]$/;
const STATUSES = ['lobby', 'playing', 'closed'];
const PHASES = ['preflop', 'flop', 'turn', 'river', 'complete'];
const BOARD_LEN = { preflop: [0], flop: [3], turn: [4], river: [5], complete: [0, 3, 4, 5] };
const NEXT_STREET = { 0: ['flop', 3], 3: ['turn', 1], 4: ['river', 1] };

const isInt = Number.isInteger;
const isNonNeg = (n) => isInt(n) && n >= 0;
const isPos = (n) => isInt(n) && n > 0;
const isSeat = (s) => isInt(s) && s >= 0 && s < MAX_SEATS;
const isCard = (c) => typeof c === 'string' && CARD_RE.test(c);
const isHole = (cs) => Array.isArray(cs) && cs.length === 2 && cs.every(isCard);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const sum = (xs, f = (x) => x) => xs.reduce((t, x) => t + f(x), 0);
const sameKeys = (o, keys) => isObj(o) && Object.keys(o).sort().join() === [...keys].sort().join();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(problem) {
  console.error(`${problem}\nUsage: npm run bots -- --players 6 --hands 2000 --seed 1 [--buyin 1000 --sb 5 --bb 10]`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { players: 6, hands: 2000, seed: 1, buyin: 1000, sb: 5, bb: 10 };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m || !(m[1] in opts)) usage(`Unknown argument: ${argv[i]}`);
    const n = Number(m[2] ?? argv[++i]);
    if (!isInt(n)) usage(`--${m[1]} needs an integer`);
    opts[m[1]] = n;
  }
  if (opts.players < 2 || opts.players > MAX_SEATS) usage(`--players must be 2..${MAX_SEATS}`);
  if (opts.hands < 1) usage('--hands must be at least 1');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const config = { buyIn: opts.buyin, smallBlind: opts.sb, bigBlind: opts.bb, turnSeconds: TURN_SECONDS };
const masterRng = seededRng(opts.seed);
const stats = {
  tables: 0,
  hands: 0,
  abortedHands: 0,
  actions: { fold: 0, check: 0, call: 0, min: 0, sized: 0, allIn: 0 },
  showdowns: 0,
  uncontested: 0,
  sidePotHands: 0,
  splitPots: 0,
  runouts: 0,
  busts: 0,
  reconnects: { replace: 0, close: 0, terminate: 0 },
  replacedVerified: 0,
  actionsAfterResume: 0,
  lateJoins: 0,
  closedMidHand: 0,
  updates: 0,
};
let currentTable = null;
let lastUpdateAt = Date.now();

function fail(message, details = {}) {
  const lines = [
    '',
    `FAIL: ${message}`,
    `  repro: npm run bots -- --players ${opts.players} --hands ${opts.hands} --seed ${opts.seed} --buyin ${opts.buyin} --sb ${opts.sb} --bb ${opts.bb}`,
  ];
  if (currentTable) lines.push(`  table: #${currentTable.no} code=${currentTable.code}`);
  for (const [k, v] of Object.entries(details)) lines.push(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  console.error(lines.join('\n'));
  process.exit(1);
}

function chooseAction(legal, rng) {
  const { check, raise } = legal;
  const x = rng();
  if (raise && x < (check ? 0.25 : 0.15)) {
    const y = rng();
    if (raise.min === raise.max || y < 0.08) return { type: 'raiseTo', amount: raise.max, label: 'allIn' };
    if (y < 0.5) return { type: 'raiseTo', amount: raise.min, label: 'min' };
    return { type: 'raiseTo', amount: raise.min + Math.floor((raise.max - raise.min) * rng() ** 3), label: 'sized' };
  }
  if (check) return x < 0.97 ? { type: 'check', label: 'check' } : { type: 'fold', label: 'fold' };
  return x < 0.4 ? { type: 'fold', label: 'fold' } : { type: 'call', label: 'call' };
}

const EVENT_SCHEMAS = {
  handStart: [
    ['handId', 'button', 'sbSeat', 'bbSeat', 'seats', 'e'],
    (ev) =>
      isPos(ev.handId) &&
      [ev.button, ev.sbSeat, ev.bbSeat].every(isSeat) &&
      Array.isArray(ev.seats) &&
      ev.seats.length >= 2 &&
      ev.seats.every(isSeat) &&
      ev.seats.every((s, i) => i === 0 || s > ev.seats[i - 1]) &&
      [ev.button, ev.sbSeat, ev.bbSeat].every((s) => ev.seats.includes(s)),
  ],
  blind: [['seat', 'amount', 'kind', 'e'], (ev) => isSeat(ev.seat) && isPos(ev.amount) && ['small', 'big'].includes(ev.kind)],
  deal: [
    ['order', 'cards', 'e'],
    (ev) => Array.isArray(ev.order) && ev.order.every(isSeat) && isObj(ev.cards) && Object.values(ev.cards).every(isHole),
  ],
  turn: [['seat', 'turnId', 'e'], (ev) => isSeat(ev.seat) && isPos(ev.turnId)],
  action: [
    ['seat', 'kind', 'added', 'to', 'allIn', 'e'],
    (ev) =>
      isSeat(ev.seat) &&
      ['fold', 'check', 'call', 'bet', 'raise'].includes(ev.kind) &&
      isNonNeg(ev.added) &&
      isNonNeg(ev.to) &&
      typeof ev.allIn === 'boolean' &&
      (['fold', 'check'].includes(ev.kind) ? ev.added === 0 : ev.added > 0) &&
      ev.added <= ev.to,
  ],
  refund: [['seat', 'amount', 'e'], (ev) => isSeat(ev.seat) && isPos(ev.amount)],
  collect: [
    ['pots', 'e'],
    (ev) => Array.isArray(ev.pots) && ev.pots.length >= 1 && ev.pots.every((p) => sameKeys(p, ['amount']) && isPos(p.amount)),
  ],
  reveal: [
    ['hands', 'e'],
    (ev) =>
      Array.isArray(ev.hands) &&
      ev.hands.length >= 2 &&
      ev.hands.every((h) => sameKeys(h, ['seat', 'cards']) && isSeat(h.seat) && isHole(h.cards)),
  ],
  board: [
    ['street', 'cards', 'e'],
    (ev) =>
      ['flop', 'turn', 'river'].includes(ev.street) &&
      Array.isArray(ev.cards) &&
      ev.cards.length === (ev.street === 'flop' ? 3 : 1) &&
      ev.cards.every(isCard),
  ],
  showdown: [
    ['hands', 'e'],
    (ev) =>
      Array.isArray(ev.hands) &&
      ev.hands.length >= 2 &&
      ev.hands.every(
        (h) =>
          sameKeys(h, ['seat', 'cards', 'name', 'best5']) &&
          isSeat(h.seat) &&
          isHole(h.cards) &&
          typeof h.name === 'string' &&
          h.name.length > 0 &&
          Array.isArray(h.best5) &&
          h.best5.length === 5 &&
          h.best5.every(isCard),
      ),
  ],
  win: [
    ['potIndex', 'amount', 'winners', 'uncontested', 'e'],
    (ev) =>
      isNonNeg(ev.potIndex) &&
      isPos(ev.amount) &&
      typeof ev.uncontested === 'boolean' &&
      Array.isArray(ev.winners) &&
      ev.winners.length >= 1 &&
      ev.winners.every((w) => sameKeys(w, ['seat', 'amount']) && isSeat(w.seat) && isNonNeg(w.amount)),
  ],
  bust: [['seat', 'e'], (ev) => isSeat(ev.seat)],
  handEnd: [
    ['stacks', 'e'],
    (ev) => isObj(ev.stacks) && Object.entries(ev.stacks).every(([k, v]) => isSeat(Number(k)) && isNonNeg(v)),
  ],
};

/** The parts of an update every seat must see identically. */
function publicProjection(msg) {
  const { state } = msg;
  const hand = state.hand && {
    ...state.hand,
    remainingMs: undefined,
    players: Object.fromEntries(
      Object.entries(state.hand.players).map(([s, p]) => [s, { folded: p.folded, allIn: p.allIn, streetBet: p.streetBet }]),
    ),
  };
  return JSON.stringify({
    events: msg.events.map((ev) => (ev.e === 'deal' ? { e: 'deal', order: ev.order } : ev)),
    room: { ...state.room, share: undefined },
    seats: state.seats,
    hand,
  });
}

class Table {
  constructor(no, wsUrl) {
    this.no = no;
    this.wsUrl = wsUrl;
    this.code = null;
    this.hostId = null;
    this.bots = [];
    this.startSent = false;
    this.started = false;
    this.closing = false;
    this.reconnecting = false;
    this.lateState = 'none';
    this.lateAtHand = 2 + Math.floor(masterRng() * 4);
    this.forcedDropHand = 1 + Math.floor(masterRng() * 5);
    this.forcedDropDone = false;
    this.dropRng = seededRng(Math.floor(masterRng() * 2 ** 32));
    this.handsBefore = stats.hands;
    this.decided = new Set();
    this.seqViews = new Map();
    this.pendingReplace = new Set();
    this.handsWonBySeat = new Map();
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  get host() {
    return this.bots[0];
  }

  agree(seq, projection, bot) {
    const seen = this.seqViews.get(seq);
    if (!seen) {
      this.seqViews.set(seq, { projection, by: bot.name });
      if (this.seqViews.size > AGREEMENT_WINDOW) this.seqViews.delete(this.seqViews.keys().next().value);
      return;
    }
    if (seen.projection !== projection)
      bot.fail(`bots disagree on public state for seq ${seq}`, { [seen.by]: JSON.parse(seen.projection), [bot.name]: JSON.parse(projection) });
  }

  get held() {
    return this.closing || this.reconnecting || this.lateState === 'joining';
  }

  /**
   * Table-level choices (late join, socket drop, close at target) are made once per turn, on the update that
   * announces it, while the server is blocked on a bot. All bots hold their actions until the choice settles,
   * so a seed replays identically regardless of socket timing.
   */
  decide(msg) {
    const turn = msg.events.find((ev) => ev.e === 'turn');
    const hand = msg.state.hand;
    if (!turn || !hand || hand.phase === 'complete' || this.closing) return;
    const key = `${hand.handId}:${turn.turnId}`;
    if (this.decided.has(key)) return;
    this.decided.add(key);
    if (this.decided.size > 64) this.decided.delete(this.decided.values().next().value);

    if (this.handsBefore + hand.handId - 1 >= opts.hands) {
      this.host.closeTable();
    } else if (this.lateState === 'waiting' && hand.handId >= this.lateAtHand) {
      this.lateState = 'joining';
      this.late.open({ t: 'join', code: this.code, name: this.late.name });
    } else {
      const forced = !this.forcedDropDone && hand.handId >= this.forcedDropHand;
      if (!forced && this.dropRng() >= DROP_RATE) return;
      this.forcedDropDone = true;
      this.reconnecting = true;
      this.dropper.reconnect().catch((err) => this.dropper.fail(`reconnect threw: ${err.stack}`));
    }
  }

  release() {
    for (const bot of this.bots) if (bot.lastState && bot.session && !bot.session.retiring) bot.maybeAct(bot.lastState);
  }

  checkDone() {
    if (!this.closing || this.reconnecting || this.pendingReplace.size > 0) return;
    if (this.bots.every((b) => !b.joined || (b.closedMsg && b.session.closeCode !== null))) this.resolveDone();
  }

  finalChecks() {
    const joined = this.bots.filter((b) => b.joined);
    const [first] = joined;
    const board = first.closedMsg.scoreboard;
    for (const b of joined)
      if (!eq(b.closedMsg.scoreboard, board)) b.fail('scoreboards differ between bots', { [first.name]: board, [b.name]: b.closedMsg.scoreboard });
    if (board.length !== joined.length) first.fail('scoreboard row count != players at the table', { board });
    const names = new Set(joined.map((b) => b.name));
    for (const row of board) {
      if (!sameKeys(row, ['name', 'stack', 'net', 'handsWon'])) first.fail('malformed scoreboard row', { row });
      if (!names.has(row.name)) first.fail('scoreboard has an unknown name', { row });
      if (row.net !== row.stack - config.buyIn) first.fail('scoreboard net != stack - buyIn', { row });
    }
    if (sum(board, (r) => r.stack) !== config.buyIn * joined.length)
      first.fail(`scoreboard stacks sum to ${sum(board, (r) => r.stack)}, expected ${config.buyIn * joined.length}`, { board });
    if (sum(board, (r) => r.net) !== 0) first.fail('scoreboard nets do not sum to 0', { board });
    for (let i = 1; i < board.length; i++)
      if (board[i].stack > board[i - 1].stack) first.fail('scoreboard not sorted by stack desc', { board });
    const last = this.host.lastState;
    const midHand = last.hand !== null && last.hand.phase !== 'complete';
    if (midHand) stats.closedMidHand++;
    const seatByName = new Map(last.seats.filter(Boolean).map((s) => [s.name, s]));
    for (const row of board) {
      const seat = seatByName.get(row.name).seat;
      const won = this.handsWonBySeat.get(seat) ?? 0;
      if (row.handsWon !== won) first.fail(`scoreboard handsWon for ${row.name} is ${row.handsWon}, host counted ${won}`, { board });
      // A mid-hand close aborts the hand and refunds every bet, so the last broadcast stacks only hold between hands.
      if (!midHand && row.stack !== seatByName.get(row.name).stack)
        first.fail(`scoreboard stack for ${row.name} differs from the last state`, { board, seats: this.host.lastState.seats });
    }
  }
}

class Bot {
  constructor(table, index) {
    this.table = table;
    this.index = index;
    this.name = `T${table.no}-B${index}`;
    this.rng = seededRng(Math.floor(masterRng() * 2 ** 32));
    this.session = null;
    this.sessions = 0;
    this.joined = false;
    this.token = null;
    this.playerId = null;
    this.seat = null;
    this.pending = null;
    this.hand = null;
    this.lastHandId = null;
    this.lastMsg = null;
    this.lastState = null;
    this.closedMsg = null;
    this.awaitingSnapshot = false;
    this.resumedNoActionYet = false;
  }

  get isHost() {
    return this.index === 0;
  }

  fail(message, extra = {}) {
    const h = this.lastMsg?.state?.hand;
    fail(message, {
      bot: `${this.name} seat=${this.seat} session=${this.sessions}`,
      handId: h ? h.handId : null,
      seq: this.lastMsg?.seq ?? null,
      ...extra,
      message: this.lastMsg,
    });
  }

  check(cond, message, extra) {
    if (!cond) this.fail(message, extra);
  }

  open(firstMsg) {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.table.wsUrl);
      const session = {
        ws,
        id: ++this.sessions,
        lastSeq: null,
        welcomed: false,
        retiring: false,
        selfClosed: false,
        expectCloseCode: null,
        closeCode: null,
        gotClosed: false,
        onWelcome: resolve,
      };
      this.session = session;
      ws.on('open', () => ws.send(JSON.stringify(firstMsg)));
      ws.on('message', (data, isBinary) => this.onMessage(session, data, isBinary));
      ws.on('close', (code) => this.onClose(session, code));
      ws.on('error', (err) => {
        if (!session.retiring) this.fail(`socket error: ${err.message}`);
      });
    });
  }

  send(msg) {
    this.session.ws.send(JSON.stringify(msg));
  }

  onMessage(session, data, isBinary) {
    let msg;
    try {
      if (isBinary) throw new Error('binary frame');
      msg = JSON.parse(data.toString('utf8'));
    } catch (err) {
      this.fail(`unparseable message: ${err.message}`, { raw: String(data) });
    }
    this.lastMsg = msg;
    this.check(!session.gotClosed, 'message received after closed');
    switch (msg?.t) {
      case 'welcome':
        return this.onWelcome(session, msg);
      case 'update':
        return this.onUpdate(session, msg);
      case 'closed':
        return this.onClosed(session, msg);
      case 'error':
        return this.fail(`unexpected error from server: ${msg.code} - ${msg.message}`);
      default:
        return this.fail('unknown message type');
    }
  }

  onWelcome(session, msg) {
    this.check(!session.welcomed, 'second welcome on one socket');
    this.check(
      sameKeys(msg, ['t', 'playerId', 'token', 'code', 'seat']) &&
        typeof msg.playerId === 'string' &&
        typeof msg.token === 'string' &&
        typeof msg.code === 'string' &&
        isSeat(msg.seat),
      'malformed welcome',
    );
    if (this.playerId !== null) {
      this.check(
        msg.playerId === this.playerId && msg.seat === this.seat && msg.token === this.token,
        'resume welcome changed identity',
        { before: { playerId: this.playerId, seat: this.seat } },
      );
    } else {
      Object.assign(this, { playerId: msg.playerId, token: msg.token, seat: msg.seat, joined: true });
    }
    if (this.isHost && this.table.code === null) {
      this.table.code = msg.code;
      this.table.hostId = msg.playerId;
    }
    this.check(msg.code === this.table.code, 'welcome code differs from table code');
    session.welcomed = true;
    if (this === this.table.late && this.table.lateState === 'joining') {
      this.table.lateState = 'joined';
      stats.lateJoins++;
      this.table.release();
    }
    session.onWelcome();
  }

  onUpdate(session, msg) {
    stats.updates++;
    lastUpdateAt = Date.now();
    this.check(session.welcomed, 'update before welcome');
    this.check(sameKeys(msg, ['t', 'seq', 'events', 'state']) && isPos(msg.seq) && Array.isArray(msg.events), 'malformed update');
    if (session.lastSeq !== null) {
      this.check(msg.seq > session.lastSeq, `seq went from ${session.lastSeq} to ${msg.seq} on one socket`);
      this.check(msg.seq === session.lastSeq + 1, `seq gap ${session.lastSeq} -> ${msg.seq} on one socket`);
    }
    session.lastSeq = msg.seq;

    for (const ev of msg.events) this.checkEventShape(ev);
    this.checkState(msg.state);
    this.table.agree(msg.seq, publicProjection(msg), this);

    if (session.retiring) {
      this.checkCards(msg.state, null);
      return;
    }
    const resumed = this.awaitingSnapshot;
    if (resumed) {
      this.check(msg.events.length === 0, 'first update after resume is not an events-free snapshot');
      this.awaitingSnapshot = false;
      this.resumedNoActionYet = true;
    }

    for (const ev of msg.events) this.trackEvent(ev, msg.state);
    this.lastState = msg.state;
    const hand = msg.state.hand;
    if (this.hand && hand && hand.handId === this.hand.id) {
      this.check(eq(hand.board, this.hand.board), 'state board differs from board events', { tracked: this.hand.board });
      this.checkCards(msg.state, this.hand);
    } else {
      this.checkCards(msg.state, null);
    }

    if (this.pending && (!hand || hand.handId !== this.pending.handId || hand.turnId !== this.pending.turnId || hand.phase === 'complete'))
      this.pending = null;

    this.table.decide(msg);
    if (this.isHost) this.hostLogic(msg.state);
    if (resumed) {
      this.table.reconnecting = false;
      this.table.release();
    } else {
      this.maybeAct(msg.state);
    }
  }

  checkEventShape(ev) {
    const schema = isObj(ev) && EVENT_SCHEMAS[ev.e];
    this.check(schema, 'unknown event', { event: ev });
    this.check(sameKeys(ev, schema[0]) && schema[1](ev), `malformed ${ev.e} event`, { event: ev });
    if (ev.e === 'deal') {
      const keys = Object.keys(ev.cards).map(Number);
      const expected = ev.order.includes(this.seat) ? [this.seat] : [];
      this.check(eq(keys, expected), 'deal event leaks cards of another seat', { event: ev });
    }
  }

  checkState(state) {
    const t = this.table;
    this.check(sameKeys(state, ['room', 'seats', 'hand', 'you']), 'malformed state');
    const { room, seats, hand, you } = state;
    this.check(
      sameKeys(room, ['code', 'status', 'hostId', 'config', 'share']) &&
        room.code === t.code &&
        STATUSES.includes(room.status) &&
        room.status !== 'closed' &&
        room.hostId === t.hostId &&
        eq(room.config, config),
      'bad state.room',
    );
    this.check(Array.isArray(seats) && seats.length === MAX_SEATS, 'state.seats must have MAX_SEATS entries');
    const live = hand !== null && hand.phase !== 'complete';
    seats.forEach((s, i) => {
      if (s === null) return;
      this.check(
        sameKeys(s, ['seat', 'name', 'stack', 'busted', 'connected', 'away', 'isHost']) &&
          s.seat === i &&
          isNonNeg(s.stack) &&
          s.isHost === (t.host.seat === i),
        `bad seat ${i}`,
      );
      this.check(!s.busted || s.stack === 0, `seat ${i} busted with chips`);
      this.check(live || s.stack > 0 || s.busted, `seat ${i} has no chips between hands but is not busted`);
      this.check(!s.away, `seat ${i} is away: a turn timed out`);
      this.check(s.connected || (t.dropper && i === t.dropper.seat), `seat ${i} shows disconnected`);
    });
    this.check(
      sameKeys(you, ['playerId', 'seat', 'isHost', 'legal']) &&
        you.playerId === this.playerId &&
        you.seat === this.seat &&
        you.isHost === this.isHost &&
        seats[this.seat]?.name === this.name,
      'bad state.you',
    );

    const occupied = seats.filter(Boolean);
    const potTotal = live ? hand.potTotal : 0;
    const chips = sum(occupied, (s) => s.stack) + potTotal;
    this.check(
      chips === config.buyIn * occupied.length,
      `chip conservation: stacks ${sum(occupied, (s) => s.stack)} + pot ${potTotal} = ${chips}, expected ${config.buyIn * occupied.length}`,
    );

    if (hand) this.checkHand(state, live);
    else this.check(you.legal === null && room.status === 'lobby', 'no hand but legal/playing');

    this.checkLegal(state, live);
  }

  checkHand(state, live) {
    const { hand, seats } = state;
    this.check(
      sameKeys(hand, [
        'handId', 'phase', 'button', 'sbSeat', 'bbSeat', 'board', 'pots', 'potTotal',
        'currentBet', 'toAct', 'turnId', 'remainingMs', 'turnMs', 'players',
      ]) &&
        isPos(hand.handId) &&
        PHASES.includes(hand.phase) &&
        [hand.button, hand.sbSeat, hand.bbSeat].every(isSeat) &&
        Array.isArray(hand.board) &&
        hand.board.every(isCard) &&
        BOARD_LEN[hand.phase].includes(hand.board.length) &&
        Array.isArray(hand.pots) &&
        hand.pots.every((p) => sameKeys(p, ['amount']) && isPos(p.amount)) &&
        isNonNeg(hand.potTotal) &&
        isNonNeg(hand.currentBet) &&
        isNonNeg(hand.turnId) &&
        isNonNeg(hand.remainingMs) &&
        isNonNeg(hand.turnMs) &&
        isObj(hand.players),
      'malformed state.hand',
    );
    for (const [key, p] of Object.entries(hand.players)) {
      const seat = Number(key);
      this.check(
        isSeat(seat) &&
          seats[seat] !== null &&
          sameKeys(p, ['folded', 'allIn', 'streetBet', 'committed', 'cards']) &&
          typeof p.folded === 'boolean' &&
          typeof p.allIn === 'boolean' &&
          isNonNeg(p.streetBet) &&
          isNonNeg(p.committed) &&
          p.committed >= p.streetBet &&
          (p.cards === null || isHole(p.cards)),
        `malformed hand.players[${key}]`,
      );
      this.check(p.allIn === (!p.folded && seats[seat].stack === 0), `hand.players[${key}].allIn disagrees with stack`);
    }
    const streetBets = sum(Object.values(hand.players), (p) => p.streetBet);
    this.check(hand.potTotal === sum(hand.pots, (p) => p.amount) + streetBets, 'potTotal != pots + street bets');
    if (hand.phase !== 'complete')
      this.check(hand.potTotal === sum(Object.values(hand.players), (p) => p.committed), 'potTotal != sum of committed');
    if (live) {
      const p = hand.players[hand.toAct];
      this.check(p && !p.folded && seats[hand.toAct].stack > 0, 'live hand with toAct not an active seat');
      this.check(hand.turnMs === TURN_SECONDS * 1000, `turnMs ${hand.turnMs}: pace:false should leave the bare turn clock`);
      this.check(hand.remainingMs > 0 && hand.remainingMs <= hand.turnMs, 'remainingMs out of range');
      this.check(state.room.status === 'playing', 'live hand while room not playing');
    } else {
      this.check(hand.toAct === null && hand.potTotal === 0 && hand.remainingMs === 0, 'complete hand still has a pot or a turn');
    }
  }

  checkLegal(state, live) {
    const { hand, you, seats } = state;
    const myTurn = live && hand.toAct === this.seat;
    this.check((you.legal !== null) === myTurn, `you.legal ${you.legal ? 'set' : 'null'} but toAct=${hand?.toAct}`);
    if (!you.legal) return;
    const legal = you.legal;
    const me = hand.players[this.seat];
    const stack = seats[this.seat].stack;
    this.check(
      sameKeys(legal, ['check', 'call', 'raise']) &&
        typeof legal.check === 'boolean' &&
        legal.check === (me.streetBet === hand.currentBet) &&
        legal.call === (legal.check ? 0 : Math.min(hand.currentBet - me.streetBet, stack)),
      'legal check/call inconsistent with the hand',
    );
    if (legal.raise !== null)
      this.check(
        sameKeys(legal.raise, ['min', 'max']) &&
          isPos(legal.raise.min) &&
          legal.raise.min <= legal.raise.max &&
          legal.raise.max === me.streetBet + stack &&
          legal.raise.min > hand.currentBet,
        'legal.raise inconsistent',
      );
  }

  checkCards(state, tracked) {
    const hand = state.hand;
    if (!hand) return;
    const players = Object.entries(hand.players);
    const unfolded = players.filter(([, p]) => !p.folded).length;
    const derivedShowdown = hand.phase === 'complete' && unfolded >= 2 && hand.board.length === 5;
    const seen = [...hand.board];
    for (const [key, p] of players) {
      const seat = Number(key);
      if (seat === this.seat) {
        this.check(p.cards !== null, 'own hole cards missing');
        if (tracked?.own) this.check(eq(p.cards, tracked.own), 'own cards differ from the deal event');
      } else if (p.cards !== null) {
        this.check(!p.folded, `card leak: folded seat ${seat}'s cards visible`);
        const allowed = tracked ? tracked.revealed.has(seat) : derivedShowdown;
        this.check(allowed, `card leak: seat ${seat}'s cards visible before reveal/showdown`);
        if (tracked) this.check(eq(p.cards, tracked.revealed.get(seat)), `seat ${seat}'s cards differ from the reveal`);
      } else if (tracked?.revealed.has(seat) && !p.folded) {
        this.fail(`seat ${seat} was revealed but its cards are hidden in state`);
      }
      if (p.cards) seen.push(...p.cards);
    }
    this.check(new Set(seen).size === seen.length, 'duplicate card among visible cards', { seen });
  }

  trackEvent(ev, state) {
    if (ev.e === 'handStart') {
      if (this.lastHandId !== null) {
        this.check(ev.handId > this.lastHandId, `handId went from ${this.lastHandId} to ${ev.handId}`);
        if (this.isHost) this.check(ev.handId === this.lastHandId + 1, `host saw handId skip ${this.lastHandId} -> ${ev.handId}`);
      }
      this.check(!this.hand || this.hand.ended, 'handStart before the previous hand ended');
      this.lastHandId = ev.handId;
      this.hand = {
        id: ev.handId,
        seats: ev.seats,
        sbSeat: ev.sbSeat,
        bbSeat: ev.bbSeat,
        blinds: 0,
        potIn: 0,
        wins: 0,
        winCount: 0,
        lastCollect: null,
        refundSinceCollect: false,
        revealed: new Map(),
        folded: new Set(),
        winners: new Set(),
        own: null,
        board: [],
        toAct: null,
        turnId: 0,
        showdown: false,
        runout: false,
        sidePot: false,
        split: false,
        ended: false,
      };
      return;
    }
    const h = this.hand;
    if (!h) return;
    this.check(!h.ended, `${ev.e} event after handEnd`, { event: ev });
    const inHand = (s) => h.seats.includes(s);
    switch (ev.e) {
      case 'blind': {
        const [seat, kind] = h.blinds === 0 ? [h.sbSeat, 'small'] : [h.bbSeat, 'big'];
        this.check(h.blinds < 2 && ev.seat === seat && ev.kind === kind, 'unexpected blind', { event: ev });
        h.blinds++;
        h.potIn += ev.amount;
        break;
      }
      case 'deal': {
        this.check(eq([...ev.order].sort((a, b) => a - b), h.seats), 'deal order != hand seats', { event: ev });
        if (ev.order.includes(this.seat)) h.own = ev.cards[this.seat];
        break;
      }
      case 'turn':
        this.check(inHand(ev.seat) && !h.folded.has(ev.seat) && ev.turnId > h.turnId, 'bad turn event', { event: ev });
        h.toAct = ev.seat;
        h.turnId = ev.turnId;
        break;
      case 'action':
        this.check(ev.seat === h.toAct, `action by seat ${ev.seat} but toAct was ${h.toAct}`, { event: ev });
        h.toAct = null;
        h.potIn += ev.added;
        if (ev.kind === 'fold') h.folded.add(ev.seat);
        break;
      case 'refund':
        this.check(inHand(ev.seat), 'refund to a seat outside the hand', { event: ev });
        h.potIn -= ev.amount;
        h.refundSinceCollect = true;
        break;
      case 'collect':
        h.lastCollect = ev.pots;
        h.refundSinceCollect = false;
        if (ev.pots.length > 1) h.sidePot = true;
        break;
      case 'reveal':
        this.check(!h.runout && ev.hands.every((x) => inHand(x.seat) && !h.folded.has(x.seat)), 'bad reveal', { event: ev });
        h.runout = true;
        for (const x of ev.hands) h.revealed.set(x.seat, x.cards);
        break;
      case 'board': {
        const next = NEXT_STREET[h.board.length];
        this.check(next && next[0] === ev.street, `board street ${ev.street} after ${h.board.length} cards`, { event: ev });
        h.board.push(...ev.cards);
        break;
      }
      case 'showdown':
        this.check(h.board.length === 5 && !h.showdown, 'showdown before the river or twice', { event: ev });
        h.showdown = true;
        for (const x of ev.hands) {
          this.check(inHand(x.seat) && !h.folded.has(x.seat), 'showdown includes a folded/absent seat', { event: ev });
          if (h.revealed.has(x.seat)) this.check(eq(h.revealed.get(x.seat), x.cards), 'showdown cards differ from reveal');
          h.revealed.set(x.seat, x.cards);
          const pool = new Set([...x.cards, ...h.board]);
          this.check(x.best5.every((c) => pool.has(c)), 'best5 uses a card outside hole+board', { event: ev });
        }
        this.check(
          ev.hands.length === h.seats.filter((s) => !h.folded.has(s)).length,
          'showdown does not cover every unfolded seat',
          { event: ev },
        );
        break;
      case 'win': {
        this.check(sum(ev.winners, (w) => w.amount) === ev.amount, 'win winners do not sum to amount', { event: ev });
        this.check(ev.potIndex === h.winCount, `win potIndex ${ev.potIndex}, expected ${h.winCount}`, { event: ev });
        this.check(ev.winners.every((w) => inHand(w.seat) && !h.folded.has(w.seat)), 'win paid to a folded seat', { event: ev });
        if (ev.uncontested) this.check(!h.showdown && ev.winners.length === 1, 'uncontested win after showdown', { event: ev });
        else this.check(h.showdown, 'contested win without showdown', { event: ev });
        if (!ev.uncontested && h.lastCollect && !h.refundSinceCollect)
          this.check(ev.amount === h.lastCollect[ev.potIndex]?.amount, 'win amount != collected pot', { event: ev, pots: h.lastCollect });
        h.winCount++;
        h.wins += ev.amount;
        if (ev.winners.length > 1) h.split = true;
        for (const w of ev.winners) if (w.amount > 0) h.winners.add(w.seat);
        break;
      }
      case 'bust':
        this.check(inHand(ev.seat) && state.seats[ev.seat].stack === 0, 'bust for a seat with chips', { event: ev });
        if (this.isHost) stats.busts++;
        break;
      case 'handEnd': {
        h.ended = true;
        this.check(h.winCount >= 1, 'hand ended without a win');
        this.check(h.wins === h.potIn, `wins ${h.wins} != chips put in ${h.potIn} (blinds+actions-refunds)`);
        if (h.lastCollect && !h.refundSinceCollect)
          this.check(sum(h.lastCollect, (p) => p.amount) === h.wins, 'wins != last collected pots', { pots: h.lastCollect });
        const stacks = Object.fromEntries(state.seats.filter(Boolean).map((s) => [s.seat, s.stack]));
        this.check(eq(Object.entries(ev.stacks).sort(), Object.entries(stacks).sort()), 'handEnd stacks != state stacks', { event: ev });
        this.check(state.hand.phase === 'complete' && state.hand.handId === h.id, 'handEnd but state hand not complete');
        if (this.isHost) this.recordHand(h);
        break;
      }
    }
  }

  recordHand(h) {
    stats.hands++;
    if (h.showdown) stats.showdowns++;
    else stats.uncontested++;
    if (h.sidePot || h.winCount > 1) stats.sidePotHands++;
    if (h.runout) stats.runouts++;
    if (h.split) stats.splitPots++;
    for (const seat of h.winners) this.table.handsWonBySeat.set(seat, (this.table.handsWonBySeat.get(seat) ?? 0) + 1);
  }

  hostLogic(state) {
    const t = this.table;
    if (t.closing) return;
    const status = state.room.status;
    if (!t.started) {
      if (status === 'playing') t.started = true;
      else if (!t.startSent && state.seats.filter(Boolean).length === t.earlyCount) {
        t.startSent = true;
        this.send({ t: 'start' });
      }
      return;
    }
    if (status !== 'lobby') return;
    this.check(
      state.seats.filter((s) => s && s.stack > 0).length < 2,
      'room fell to lobby while two or more players still hold chips',
    );
    this.closeTable();
  }

  closeTable() {
    const t = this.table;
    t.closing = true;
    if (t.lateState === 'waiting') t.lateState = 'skipped';
    this.send({ t: 'close' });
  }

  async reconnect() {
    const t = this.table;
    const total = stats.reconnects.replace + stats.reconnects.close + stats.reconnects.terminate;
    const kind = RECONNECT_KINDS[total % RECONNECT_KINDS.length];
    stats.reconnects[kind]++;
    t.reconnecting = true;
    const old = this.session;
    old.retiring = true;
    this.hand = null;
    this.awaitingSnapshot = true;
    if (kind === 'replace') {
      old.expectCloseCode = WS_CLOSE_REPLACED;
      t.pendingReplace.add(old);
    } else {
      old.selfClosed = true;
      if (kind === 'close') old.ws.close(1000, 'bot drop');
      else old.ws.terminate();
      await sleep(5);
    }
    await this.open({ t: 'resume', code: t.code, token: this.token });
  }

  maybeAct(state) {
    const legal = state.you.legal;
    if (!legal || this.table.held) return;
    const { handId, turnId } = state.hand;
    if (this.pending && this.pending.handId === handId && this.pending.turnId === turnId) return;
    const { label, ...action } = chooseAction(legal, this.rng);
    stats.actions[label]++;
    if (this.resumedNoActionYet) {
      stats.actionsAfterResume++;
      this.resumedNoActionYet = false;
    }
    this.pending = { handId, turnId };
    this.send({ t: 'action', handId, turnId, ...action });
  }

  onClosed(session, msg) {
    this.check(!session.retiring, 'closed sent to a replaced/dropped socket');
    this.check(this.table.closing, 'closed received but the host never closed the table');
    this.check(
      sameKeys(msg, ['t', 'scoreboard']) && Array.isArray(msg.scoreboard),
      'malformed closed message',
    );
    session.gotClosed = true;
    this.closedMsg = msg;
  }

  onClose(session, code) {
    session.closeCode = code;
    const t = this.table;
    if (session.expectCloseCode !== null) {
      if (code !== session.expectCloseCode)
        this.fail(`replaced socket closed with ${code}, expected ${session.expectCloseCode}`);
      stats.replacedVerified++;
      t.pendingReplace.delete(session);
    } else if (session.selfClosed) {
      // our own drop
    } else if (session.gotClosed) {
      this.check(code === 1000, `socket closed with ${code} after 'closed', expected 1000`);
    } else {
      this.fail(`socket closed unexpectedly with code ${code}`);
    }
    t.checkDone();
  }
}

async function runTable(no, wsUrl) {
  const t = new Table(no, wsUrl);
  currentTable = t;
  stats.tables++;
  for (let i = 0; i < opts.players; i++) t.bots.push(new Bot(t, i));
  t.dropper = t.bots[1];
  if (opts.players >= 3) {
    t.late = t.bots[opts.players - 1];
    t.lateState = 'waiting';
  }
  t.earlyCount = t.late ? opts.players - 1 : opts.players;
  await t.host.open({ t: 'create', name: t.host.name, config });
  for (const bot of t.bots.slice(1, t.earlyCount)) await bot.open({ t: 'join', code: t.code, name: bot.name });
  await t.done;
  t.finalChecks();
  return t;
}

function startWatchdog() {
  return setInterval(() => {
    if (Date.now() - lastUpdateAt < WATCHDOG_MS) return;
    const t = currentTable;
    fail(`stall: no update for ${WATCHDOG_MS / 1000}s`, {
      flags: t && {
        started: t.started,
        startSent: t.startSent,
        closing: t.closing,
        reconnecting: t.reconnecting,
        lateState: t.lateState,
        pendingReplace: t.pendingReplace.size,
      },
      lastMessages: t ? Object.fromEntries(t.bots.map((b) => [b.name, b.lastMsg])) : null,
    });
  }, 1000);
}

async function main() {
  const startedAt = Date.now();
  const server = await startServer({
    port: 0,
    quiet: true,
    roomOptions: { pace: false, autoDeal: true, rng: seededRng(opts.seed ^ 0x5bd1e995) },
  });
  const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  const watchdog = startWatchdog();
  const perTable = [];
  for (let no = 1; stats.hands < opts.hands; no++) {
    const before = stats.hands;
    await runTable(no, wsUrl);
    perTable.push(stats.hands - before);
  }
  clearInterval(watchdog);
  currentTable = null;
  await server.close();

  const totalReconnects = stats.reconnects.replace + stats.reconnects.close + stats.reconnects.terminate;
  if (stats.reconnects.replace > 0 && stats.replacedVerified !== stats.reconnects.replace)
    fail(`replaced sockets: ${stats.reconnects.replace} attempted, ${stats.replacedVerified} closed with ${WS_CLOSE_REPLACED}`);
  if (stats.replacedVerified < 1) fail('the replaced-socket (4001) path was never exercised');
  if (totalReconnects >= 3 && stats.actionsAfterResume === 0) fail('the reconnecting bot never acted after a resume');

  const a = stats.actions;
  const actions = a.fold + a.check + a.call + a.min + a.sized + a.allIn;
  const r = stats.reconnects;
  console.log(
    [
      `bots OK  seed=${opts.seed} players=${opts.players} buyIn=${config.buyIn} blinds=${config.smallBlind}/${config.bigBlind}`,
      `  tables ${stats.tables} (hands/table min ${Math.min(...perTable)} max ${Math.max(...perTable)}; closed mid-hand ${stats.closedMidHand}, late joins ${stats.lateJoins})`,
      `  hands ${stats.hands}  showdowns ${stats.showdowns}  uncontested ${stats.uncontested}  side-pot hands ${stats.sidePotHands}  all-in runouts ${stats.runouts}  split pots ${stats.splitPots}  busts ${stats.busts}`,
      `  actions ${actions} (fold ${a.fold}, check ${a.check}, call ${a.call}, raise min ${a.min} / sized ${a.sized} / all-in ${a.allIn})`,
      `  reconnects ${totalReconnects} (replace ${r.replace} [4001 verified ${stats.replacedVerified}], close ${r.close}, terminate ${r.terminate}; acted after resume ${stats.actionsAfterResume})`,
      `  updates checked ${stats.updates}  elapsed ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    ].join('\n'),
  );

  setTimeout(() => {
    console.error(`FAIL: process did not exit 3s after shutdown; live handles: ${JSON.stringify(process.getActiveResourcesInfo())}`);
    process.exit(1);
  }, 3000).unref();
}

main().catch((err) => fail(`crashed: ${err.stack}`));
