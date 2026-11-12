import { randomBytes } from 'node:crypto';
import { ERR, NAME_MAX, WS_CLOSE_REPLACED } from '../shared/protocol.js';
import { animBudget, NEXT_HAND_PAUSE_MS } from '../shared/timing.js';
import { cryptoRng } from './engine/deck.js';
import {
  EngineError,
  createTable,
  addPlayer,
  removePlayer,
  canStartHand,
  startHand,
  legalActions,
  applyAction,
  abortHand,
} from './engine/game.js';
import { viewFor, redactEvents } from './view.js';

export const AWAY_ACT_MS = 1000;
export const EMPTY_ROOM_MS = 30 * 60 * 1000;
const WS_OPEN = 1;
const ACTION_TYPES = ['fold', 'check', 'call', 'raiseTo'];

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

/** Trims, strips control characters, collapses whitespace and caps at NAME_MAX; null when nothing is left. */
export function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  const capped = Array.from(clean).slice(0, NAME_MAX).join('').trim();
  return capped || null;
}

function send(socket, msg) {
  if (!socket || socket.readyState !== WS_OPEN) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    // A socket that fails mid-send is reaped by its close handler.
  }
}

export class Room {
  constructor({
    code,
    config,
    share = { lan: [], tunnel: null },
    rng = cryptoRng,
    timers = {},
    pace = true,
    autoDeal = false,
    onEmpty = () => {},
  }) {
    this.code = code;
    this.config = {
      buyIn: config.buyIn,
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      turnSeconds: config.turnSeconds,
    };
    this.share = share;
    this.rng = rng;
    this.timers = { setTimeout, clearTimeout, now: Date.now, ...timers };
    this.pace = pace;
    this.autoDeal = autoDeal;
    this.onEmpty = onEmpty;

    this.table = createTable(this.config);
    /** @type {Map<string, {id, token, name, seat, socket, connected, away, handsWon}>} */
    this.players = new Map();
    this.byToken = new Map();
    this.hostId = null;
    this.seq = 0;
    this.closed = false;
    this.closedAt = null;

    this.turnTimer = null;
    this.nextHandTimer = null;
    this.paused = false;
    this.emptyTimer = null;
    this.turnDeadline = null;
    this.turnMs = 0;
  }

  now() {
    return this.timers.now();
  }

  get status() {
    if (this.closed) return 'closed';
    if (this.#handLive() || this.nextHandTimer !== null) return 'playing';
    return 'lobby';
  }

  /** @returns the new player; with a socket, it is bound and sent `welcome` before the broadcast. */
  join(name, socket = null) {
    this.#assertOpen();
    const clean = normalizeName(name);
    if (!clean) throw new RoomError(ERR.BAD_NAME, `Enter a name of 1 to ${NAME_MAX} characters`);
    if (!this.table.seats.includes(null)) throw new RoomError(ERR.ROOM_FULL, 'This table is full');

    const id = randomBytes(8).toString('hex');
    const token = randomBytes(16).toString('hex');
    const uniqueName = this.#dedupeName(clean);
    const seat = addPlayer(this.table, { id, name: uniqueName });
    const player = { id, token, name: uniqueName, seat, socket: null, connected: false, away: false, missed: 0, handsWon: 0 };
    this.players.set(id, player);
    this.byToken.set(token, player);
    this.hostId ??= id;
    if (socket) this.#attach(player, socket);
    this.#broadcast([]);
    return player;
  }

  hasToken(token) {
    return typeof token === 'string' && this.byToken.has(token);
  }

  resume(token, socket) {
    this.#assertOpen();
    const player = typeof token === 'string' ? this.byToken.get(token) : undefined;
    if (!player) throw new RoomError(ERR.BAD_TOKEN, 'That seat could not be found; join again');
    const old = player.socket;
    const wasAway = player.away;
    this.#attach(player, socket);
    if (old && old !== socket) {
      try {
        old.close(WS_CLOSE_REPLACED, 'Opened in another tab');
      } catch {
        // already closing
      }
    }
    if (wasAway && this.#handLive() && this.table.hand.toAct === player.seat) {
      this.#clearTurnTimer();
      this.#scheduleTurn([]);
    }
    this.#broadcast([]);
    return player;
  }

  disconnect(playerId, socket) {
    const player = this.players.get(playerId);
    if (!player || player.socket !== socket) return;
    player.socket = null;
    player.connected = false;
    if (this.closed) return;
    this.#broadcast([]);
    if (!this.#anyConnected()) {
      this.#clearEmptyTimer();
      this.emptyTimer = this.timers.setTimeout(() => {
        this.emptyTimer = null;
        this.forceClose();
        this.onEmpty();
      }, EMPTY_ROOM_MS);
    }
  }

  leave(playerId) {
    const player = this.players.get(playerId);
    if (!player || this.closed) return;
    const { socket } = player;
    player.socket = null;
    player.connected = false;
    if (this.table.hand !== null) {
      player.away = true;
      if (this.#handLive() && this.table.hand.toAct === player.seat) {
        this.#clearTurnTimer();
        this.#scheduleTurn([]);
      }
      this.#broadcast([]);
      return socket;
    }
    removePlayer(this.table, player.seat);
    this.players.delete(player.id);
    this.byToken.delete(player.token);
    if (this.players.size === 0) {
      this.forceClose();
      this.onEmpty();
      return socket;
    }
    if (this.hostId === player.id) this.hostId = this.players.keys().next().value;
    this.#broadcast([]);
    return socket;
  }

  back(playerId) {
    this.#assertOpen();
    const player = this.players.get(playerId);
    if (!player) return;
    player.missed = 0;
    if (!player.away) return;
    player.away = false;
    if (this.#handLive() && this.table.hand.toAct === player.seat) {
      this.#clearTurnTimer();
      this.#scheduleTurn([]);
    }
    this.#resumeIfPaused();
    this.#broadcast([]);
  }

  isBound(playerId, socket) {
    return this.players.get(playerId)?.socket === socket;
  }

  start(playerId) {
    this.#assertOpen();
    if (playerId !== this.hostId) throw new RoomError(ERR.NOT_HOST, 'Only the host can deal');
    if (this.status !== 'lobby' || !this.#canDeal())
      throw new RoomError(ERR.CANNOT_START, 'At least two players who are online and have chips are needed to deal');
    this.#startHand();
  }

  action(playerId, msg) {
    this.#assertOpen();
    const player = this.players.get(playerId);
    if (!player) throw new RoomError(ERR.BAD_TOKEN, 'Unknown player');
    const { type, handId, turnId, amount } = msg ?? {};
    if (!ACTION_TYPES.includes(type) || !Number.isInteger(handId) || !Number.isInteger(turnId))
      throw new RoomError(ERR.BAD_MESSAGE, 'Malformed action');
    if (type === 'raiseTo' && !Number.isInteger(amount))
      throw new RoomError(ERR.BAD_MESSAGE, 'Raise amount must be a whole number');

    const hand = this.table.hand;
    if (!this.#handLive() || hand.id !== handId || hand.turnId !== turnId)
      throw new RoomError(ERR.STALE_ACTION, 'That turn is already over');
    if (hand.toAct !== player.seat) throw new RoomError(ERR.ILLEGAL_ACTION, 'Not your turn');

    let events;
    try {
      events = applyAction(this.table, player.seat, type === 'raiseTo' ? { type, amount } : { type });
    } catch (err) {
      if (err instanceof EngineError) throw new RoomError(ERR.ILLEGAL_ACTION, err.message);
      throw err;
    }
    player.missed = 0;
    player.away = false;
    this.#afterEvents(events);
  }

  close(playerId) {
    this.#assertOpen();
    if (playerId !== this.hostId) throw new RoomError(ERR.NOT_HOST, 'Only the host can close the table');
    this.forceClose();
  }

  forceClose() {
    if (this.closed) return;
    abortHand(this.table);
    this.#clearTurnTimer();
    this.#clearNextHandTimer();
    this.#clearEmptyTimer();
    this.closed = true;
    this.closedAt = this.now();
    const msg = { t: 'closed', scoreboard: this.scoreboard() };
    for (const player of this.players.values()) {
      const { socket } = player;
      player.socket = null;
      player.connected = false;
      if (!socket) continue;
      send(socket, msg);
      try {
        socket.close(1000, 'Table closed');
      } catch {
        // already closing
      }
    }
  }

  scoreboard() {
    const { buyIn } = this.config;
    return [...this.players.values()]
      .map((p) => {
        const stack = this.table.seats[p.seat].stack;
        return { name: p.name, stack, net: stack - buyIn, handsWon: p.handsWon };
      })
      .sort((a, b) => b.stack - a.stack);
  }

  #assertOpen() {
    if (this.closed) throw new RoomError(ERR.ROOM_CLOSED, 'This table has been closed');
  }

  #anyConnected() {
    return [...this.players.values()].some((p) => p.connected);
  }

  #handLive() {
    return this.table.hand !== null && this.table.hand.phase !== 'complete';
  }

  #dedupeName(name) {
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = Array.from(name).slice(0, NAME_MAX - suffix.length).join('').trimEnd() + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  #attach(player, socket) {
    player.socket = socket;
    player.connected = true;
    player.away = false;
    player.missed = 0;
    this.#clearEmptyTimer();
    send(socket, { t: 'welcome', playerId: player.id, token: player.token, code: this.code, seat: player.seat });
    this.#resumeIfPaused();
  }

  /** Offline and away players sit the next hand out; they are dealt back in once they return. */
  #canDeal() {
    for (const p of this.players.values()) this.table.seats[p.seat].sittingOut = !p.connected || p.away;
    return canStartHand(this.table);
  }

  /** Paused means waiting for players to return, not a table that has run out of opponents. */
  #enoughChips() {
    return this.table.seats.filter((s) => s && s.stack > 0).length >= 2;
  }

  #resumeIfPaused() {
    if (!this.paused || this.closed || !this.#canDeal()) return;
    this.paused = false;
    this.nextHandTimer = this.timers.setTimeout(() => this.#onNextHand(), this.pace ? NEXT_HAND_PAUSE_MS : 0);
  }

  #playerAt(seat) {
    return this.players.get(this.table.seats[seat].id);
  }

  #budget(events) {
    return this.pace ? animBudget(events) : 0;
  }

  #startHand() {
    this.#clearTurnTimer();
    this.#clearNextHandTimer();
    this.#afterEvents(startHand(this.table, { rng: this.rng }));
  }

  #afterEvents(events) {
    this.#clearTurnTimer();
    this.#clearNextHandTimer();
    this.#countWins(events);
    const hand = this.table.hand;
    if (hand.phase === 'complete') {
      // Without autoDeal the table rests on the finished hand until the host deals the next one.
      if (this.autoDeal) {
        if (this.#canDeal()) {
          const delay = this.#budget(events) + (this.pace ? NEXT_HAND_PAUSE_MS : 0);
          this.nextHandTimer = this.timers.setTimeout(() => this.#onNextHand(), delay);
        } else {
          this.paused = this.#enoughChips();
        }
      }
    } else if (hand.toAct !== null) {
      this.#scheduleTurn(events);
    }
    this.#broadcast(events);
  }

  #countWins(events) {
    const winners = new Set();
    for (const ev of events) {
      if (ev.e !== 'win') continue;
      for (const w of ev.winners) if (w.amount > 0) winners.add(w.seat);
    }
    for (const seat of winners) this.#playerAt(seat).handsWon++;
  }

  #scheduleTurn(events) {
    const player = this.#playerAt(this.table.hand.toAct);
    const span = player.away ? AWAY_ACT_MS : this.config.turnSeconds * 1000;
    const total = this.#budget(events) + span;
    this.turnMs = span;
    this.turnDeadline = this.now() + total;
    this.turnTimer = this.timers.setTimeout(() => this.#onTurnTimeout(), total);
  }

  #onTurnTimeout() {
    this.turnTimer = null;
    if (this.closed || !this.#handLive()) return;
    const seat = this.table.hand.toAct;
    const player = this.#playerAt(seat);
    player.missed++;
    // Two missed turns in a row: stop making the table wait a full clock for someone who walked off.
    if (!player.connected || player.missed >= 2) player.away = true;
    const legal = legalActions(this.table, seat);
    this.#afterEvents(applyAction(this.table, seat, { type: legal.check ? 'check' : 'fold' }));
  }

  #onNextHand() {
    this.nextHandTimer = null;
    if (this.closed) return;
    if (this.#canDeal()) this.#startHand();
    else {
      this.paused = this.#enoughChips();
      this.#broadcast([]);
    }
  }

  #broadcast(events) {
    const seq = ++this.seq;
    for (const player of this.players.values()) {
      if (!player.socket) continue;
      send(player.socket, {
        t: 'update',
        seq,
        events: redactEvents(events, player.seat),
        state: viewFor(this, player.id),
      });
    }
  }

  #clearTurnTimer() {
    if (this.turnTimer !== null) this.timers.clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnDeadline = null;
    this.turnMs = 0;
  }

  #clearNextHandTimer() {
    if (this.nextHandTimer !== null) this.timers.clearTimeout(this.nextHandTimer);
    this.nextHandTimer = null;
  }

  #clearEmptyTimer() {
    if (this.emptyTimer !== null) this.timers.clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }
}
