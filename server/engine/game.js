import { makeDeck } from '../../shared/cards.js';
import { ERR, MAX_SEATS } from '../../shared/protocol.js';
import { shuffle } from './deck.js';
import { evaluate7 } from './evaluator.js';
import { uncalledRefund, buildPots, distribute } from './pots.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

const STREETS = { preflop: ['flop', 3], flop: ['turn', 1], turn: ['river', 1] };

export function createTable(config) {
  const maxSeats = config.maxSeats ?? MAX_SEATS;
  return {
    config: { buyIn: config.buyIn, smallBlind: config.smallBlind, bigBlind: config.bigBlind, maxSeats },
    seats: new Array(maxSeats).fill(null),
    button: null,
    handNumber: 0,
    seatsEverFilled: 0,
    hand: null,
  };
}

export function removePlayer(table, seat) {
  if (table.hand !== null) throw new EngineError(ERR.ILLEGAL_ACTION, 'Cannot remove a player once play has started');
  if (!table.seats[seat]) return;
  table.seats[seat] = null;
  table.seatsEverFilled--;
}

export function addPlayer(table, { id, name }) {
  const seat = table.seats.indexOf(null);
  if (seat === -1) throw new EngineError(ERR.ROOM_FULL, 'Table is full');
  table.seats[seat] = { id, name, stack: table.config.buyIn, busted: false };
  table.seatsEverFilled++;
  return seat;
}

const isLive = (hand) => hand !== null && hand.phase !== 'complete';

const canPlay = (s) => s !== null && s.stack > 0 && !s.sittingOut;

export function canStartHand(table) {
  return !isLive(table.hand) && table.seats.filter(canPlay).length >= 2;
}

export function totalChips(table) {
  let total = table.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
  if (isLive(table.hand)) for (const p of Object.values(table.hand.players)) total += p.committed;
  return total;
}

function clockwise(table, from, pred) {
  const n = table.config.maxSeats;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (pred(seat)) return seat;
  }
  return null;
}

function handSeats(hand) {
  return Object.keys(hand.players)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Hand seats in clockwise order starting left of the button. */
function fromButton(table) {
  const seats = handSeats(table.hand);
  const n = table.config.maxSeats;
  const dist = (s) => (s - table.button - 1 + n) % n;
  return seats.sort((a, b) => dist(a) - dist(b));
}

function canAct(table, seat) {
  const p = table.hand.players[seat];
  return !p.folded && table.seats[seat].stack > 0;
}

function countCanAct(table) {
  return handSeats(table.hand).filter((s) => canAct(table, s)).length;
}

function needsToAct(table, seat) {
  const hand = table.hand;
  const p = hand.players[seat];
  if (!p || !canAct(table, seat)) return false;
  const others = countCanAct(table) >= 2;
  // currentBet stays a full big blind even when the big blind posted short, so "below currentBet"
  // alone would ask a lone player to call a bet nobody actually made.
  const outbid = handSeats(hand).some((s) => !hand.players[s].folded && hand.players[s].streetBet > p.streetBet);
  if (p.streetBet < hand.currentBet) return others || outbid;
  return p.actedAtBet === null && others;
}

function computeLegal(table, seat) {
  const hand = table.hand;
  const p = hand.players[seat];
  const stack = table.seats[seat].stack;
  const check = p.streetBet === hand.currentBet;
  const call = check ? 0 : Math.min(hand.currentBet - p.streetBet, stack);
  const max = p.streetBet + stack;
  const opponentHasChips = handSeats(hand).some((s) => s !== seat && canAct(table, s));
  const reopened = p.actedAtBet === null || hand.currentBet - p.actedAtBet >= hand.lastRaiseSize;
  const raise =
    opponentHasChips && reopened && max > hand.currentBet
      ? { min: Math.min(hand.currentBet + hand.lastRaiseSize, max), max }
      : null;
  return { check, call, raise };
}

export function legalActions(table, seat) {
  const hand = table.hand;
  if (!isLive(hand) || hand.toAct !== seat) return null;
  return computeLegal(table, seat);
}

function moveChips(table, seat, amount) {
  const p = table.hand.players[seat];
  table.seats[seat].stack -= amount;
  p.streetBet += amount;
  p.committed += amount;
}

function refund(table, events, seat, amount) {
  moveChips(table, seat, -amount);
  events.push({ e: 'refund', seat, amount });
}

function potInput(hand) {
  return handSeats(hand).map((seat) => {
    const p = hand.players[seat];
    return { seat, streetBet: p.streetBet, committed: p.committed, folded: p.folded };
  });
}

function refundUncalled(table, events) {
  const r = uncalledRefund(potInput(table.hand));
  if (r) refund(table, events, r.seat, r.amount);
}

function collect(table, events) {
  const hand = table.hand;
  const players = Object.values(hand.players);
  const streetTotal = players.reduce((sum, p) => sum + p.streetBet, 0);
  for (const p of players) {
    p.streetBet = 0;
    p.actedAtBet = null;
  }
  hand.pots = buildPots(potInput(hand));
  hand.currentBet = 0;
  hand.lastRaiseSize = table.config.bigBlind;
  if (streetTotal > 0) events.push({ e: 'collect', pots: hand.pots.map((p) => ({ amount: p.amount })) });
}

function setTurn(table, events, seat) {
  const hand = table.hand;
  hand.turnId++;
  hand.toAct = seat;
  events.push({ e: 'turn', seat, turnId: hand.turnId });
}

function dealStreet(table, events) {
  const hand = table.hand;
  const [street, count] = STREETS[hand.phase];
  const cards = hand.deck.splice(0, count);
  hand.board.push(...cards);
  hand.phase = street;
  events.push({ e: 'board', street, cards });
}

function stacksOf(table) {
  const stacks = {};
  table.seats.forEach((s, i) => {
    if (s) stacks[i] = s.stack;
  });
  return stacks;
}

function finish(table, events) {
  const hand = table.hand;
  hand.phase = 'complete';
  hand.toAct = null;
  hand.pots = [];
  for (const seat of handSeats(hand)) {
    if (table.seats[seat].stack === 0) {
      table.seats[seat].busted = true;
      events.push({ e: 'bust', seat });
    }
  }
  events.push({ e: 'handEnd', stacks: stacksOf(table) });
}

function finishUncontested(table, events, winner) {
  const hand = table.hand;
  refundUncalled(table, events);
  // A short all-in big blind left alone (everyone folded to a full-size currentBet it never made)
  // can only win from each opponent what it matched; the folded excess goes back.
  const cap = hand.players[winner].committed;
  for (const seat of handSeats(hand)) {
    const excess = hand.players[seat].committed - cap;
    if (seat !== winner && excess > 0) refund(table, events, seat, excess);
  }
  collect(table, events);
  const amount = Object.values(hand.players).reduce((sum, p) => sum + p.committed, 0);
  table.seats[winner].stack += amount;
  events.push({ e: 'win', potIndex: 0, amount, winners: [{ seat: winner, amount }], uncontested: true });
  finish(table, events);
}

function showdown(table, events) {
  const hand = table.hand;
  hand.revealed = true;
  const live = fromButton(table).filter((s) => !hand.players[s].folded);
  const results = {};
  for (const seat of live) results[seat] = evaluate7([...hand.players[seat].hole, ...hand.board]);
  events.push({
    e: 'showdown',
    hands: live.map((seat) => ({
      seat,
      cards: [...hand.players[seat].hole],
      name: results[seat].name,
      best5: results[seat].best5,
    })),
  });
  buildPots(potInput(hand)).forEach((pot, potIndex) => {
    const best = Math.max(...pot.eligible.map((s) => results[s].score));
    const winners = pot.eligible.filter((s) => results[s].score === best);
    const shares = distribute(pot.amount, winners, table.button, table.config.maxSeats);
    for (const { seat, amount } of shares) table.seats[seat].stack += amount;
    events.push({ e: 'win', potIndex, amount: pot.amount, winners: shares, uncontested: false });
  });
  finish(table, events);
}

function advance(table, events, from) {
  const hand = table.hand;
  const live = handSeats(hand).filter((s) => !hand.players[s].folded);
  if (live.length === 1) return finishUncontested(table, events, live[0]);

  let next = clockwise(table, from, (s) => needsToAct(table, s));
  while (next === null) {
    refundUncalled(table, events);
    collect(table, events);
    if (hand.phase === 'river') return showdown(table, events);
    if (countCanAct(table) <= 1) {
      if (!hand.revealed) {
        hand.revealed = true;
        const hands = fromButton(table)
          .filter((s) => !hand.players[s].folded)
          .map((seat) => ({ seat, cards: [...hand.players[seat].hole] }));
        events.push({ e: 'reveal', hands });
      }
      while (hand.phase !== 'river') dealStreet(table, events);
      return showdown(table, events);
    }
    dealStreet(table, events);
    next = clockwise(table, table.button, (s) => needsToAct(table, s));
  }
  setTurn(table, events, next);
}

export function startHand(table, { rng, deck } = {}) {
  if (!canStartHand(table)) throw new EngineError(ERR.CANNOT_START, 'Cannot start a hand now');
  const { config } = table;
  const hasChips = (s) => canPlay(table.seats[s]);
  const inHand = table.seats.map((_, i) => i).filter(hasChips);

  table.button =
    table.button === null ? inHand[Math.floor(rng() * inHand.length)] : clockwise(table, table.button, hasChips);
  const next = (from) => clockwise(table, from, hasChips);
  const sbSeat = inHand.length === 2 ? table.button : next(table.button);
  const bbSeat = next(sbSeat);

  const players = {};
  for (const seat of inHand) players[seat] = { hole: [], folded: false, streetBet: 0, committed: 0, actedAtBet: null };
  table.handNumber++;
  table.hand = {
    id: table.handNumber,
    phase: 'preflop',
    deck: deck ? deck.slice() : shuffle(makeDeck(), rng),
    board: [],
    sbSeat,
    bbSeat,
    currentBet: config.bigBlind,
    lastRaiseSize: config.bigBlind,
    toAct: null,
    turnId: table.hand ? table.hand.turnId : 0,
    revealed: false,
    pots: [],
    players,
  };
  const hand = table.hand;

  const events = [{ e: 'handStart', handId: hand.id, button: table.button, sbSeat, bbSeat, seats: inHand }];
  for (const [seat, blind, kind] of [
    [sbSeat, config.smallBlind, 'small'],
    [bbSeat, config.bigBlind, 'big'],
  ]) {
    const amount = Math.min(blind, table.seats[seat].stack);
    moveChips(table, seat, amount);
    events.push({ e: 'blind', seat, amount, kind });
  }

  const order = fromButton(table);
  for (let round = 0; round < 2; round++) for (const seat of order) players[seat].hole.push(hand.deck.shift());
  const cards = {};
  for (const seat of order) cards[seat] = [...players[seat].hole];
  events.push({ e: 'deal', order, cards });

  advance(table, events, bbSeat);
  return events;
}

export function applyAction(table, seat, action) {
  const hand = table.hand;
  if (!isLive(hand)) throw new EngineError(ERR.ILLEGAL_ACTION, 'No hand in progress');
  if (hand.toAct !== seat) throw new EngineError(ERR.ILLEGAL_ACTION, 'Not your turn');
  const legal = computeLegal(table, seat);
  const type = action?.type;
  const amount = action?.amount;

  if (type === 'check' && !legal.check) throw new EngineError(ERR.ILLEGAL_ACTION, 'Cannot check facing a bet');
  if (type === 'call' && legal.check) throw new EngineError(ERR.ILLEGAL_ACTION, 'Nothing to call');
  if (type === 'raiseTo') {
    if (!legal.raise) throw new EngineError(ERR.ILLEGAL_ACTION, 'Raising is not allowed');
    if (!Number.isInteger(amount) || amount < legal.raise.min || amount > legal.raise.max)
      throw new EngineError(
        ERR.ILLEGAL_ACTION,
        `Raise must be a whole number from ${legal.raise.min} to ${legal.raise.max}`,
      );
  }
  if (!['fold', 'check', 'call', 'raiseTo'].includes(type))
    throw new EngineError(ERR.ILLEGAL_ACTION, 'Unknown action');

  const p = hand.players[seat];
  const betBefore = hand.currentBet;
  const streetBetBefore = p.streetBet;
  let kind = type;
  if (type === 'fold') p.folded = true;
  else if (type === 'call') moveChips(table, seat, legal.call);
  else if (type === 'raiseTo') {
    moveChips(table, seat, amount - p.streetBet);
    if (amount - hand.currentBet >= hand.lastRaiseSize) hand.lastRaiseSize = amount - hand.currentBet;
    hand.currentBet = amount;
    kind = betBefore === 0 ? 'bet' : 'raise';
  }
  if (type !== 'fold') p.actedAtBet = hand.currentBet;

  const events = [
    {
      e: 'action',
      seat,
      kind,
      added: p.streetBet - streetBetBefore,
      to: p.streetBet,
      allIn: !p.folded && table.seats[seat].stack === 0,
    },
  ];
  hand.toAct = null;
  advance(table, events, seat);
  return events;
}

export function abortHand(table) {
  const hand = table.hand;
  if (!isLive(hand)) return [];
  for (const seat of handSeats(hand)) {
    const p = hand.players[seat];
    table.seats[seat].stack += p.committed;
    p.committed = 0;
    p.streetBet = 0;
  }
  hand.phase = 'complete';
  hand.toAct = null;
  hand.pots = [];
  return [{ e: 'handEnd', stacks: stacksOf(table) }];
}
