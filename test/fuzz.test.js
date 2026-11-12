import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRng } from '../server/engine/deck.js';
import {
  createTable,
  addPlayer,
  canStartHand,
  startHand,
  legalActions,
  applyAction,
  totalChips,
} from '../server/engine/game.js';

const CONFIGS = [
  { buyIn: 1000, smallBlind: 5, bigBlind: 10 },
  { buyIn: 200, smallBlind: 10, bigBlind: 20 },
  { buyIn: 70, smallBlind: 3, bigBlind: 7 },
  { buyIn: 500, smallBlind: 1, bigBlind: 2 },
  { buyIn: 100, smallBlind: 10, bigBlind: 10 },
];
const TARGET_HANDS = 20000;
const HANDS_PER_TABLE = 150;
const MAX_ACTIONS_PER_HAND = 200;

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

function chooseAction(legal, rng) {
  const r = rng();
  if (legal.raise && r < 0.3) {
    const { min, max } = legal.raise;
    const k = rng();
    const amount = k < 0.35 ? min : k < 0.55 ? max : min + Math.floor(rng() * (max - min + 1));
    return { type: 'raiseTo', amount };
  }
  if (r < (legal.check ? 0.33 : 0.45)) return { type: 'fold' };
  return { type: legal.check ? 'check' : 'call' };
}

function checkInvariants(table) {
  const { buyIn } = table.config;
  assert.equal(totalChips(table), buyIn * table.seatsEverFilled, 'chip conservation');
  for (const s of table.seats) if (s) assert.ok(Number.isInteger(s.stack) && s.stack >= 0, 'stack >= 0');

  const hand = table.hand;
  const live = hand !== null && hand.phase !== 'complete';
  if (hand) {
    const players = Object.values(hand.players);
    for (const p of players) assert.ok(p.streetBet >= 0 && p.committed >= p.streetBet, 'bets >= 0');
    if (live) {
      assert.equal(
        sum(hand.pots, (p) => p.amount) + sum(players, (p) => p.streetBet),
        sum(players, (p) => p.committed),
        'pots + street bets = committed',
      );
      assert.notEqual(hand.toAct, null, 'a live hand always has someone to act');
    }
  }
  for (let seat = 0; seat < table.config.maxSeats; seat++) {
    const legal = legalActions(table, seat);
    assert.equal(legal !== null, live && hand.toAct === seat, `legalActions only for toAct (seat ${seat})`);
    if (!legal) continue;
    const stack = table.seats[seat].stack;
    assert.ok(stack > 0, 'actor has chips');
    assert.ok(legal.call <= stack && legal.call >= 0);
    assert.equal(legal.check, legal.call === 0);
    if (legal.raise) {
      assert.ok(legal.raise.min > hand.currentBet && legal.raise.min <= legal.raise.max);
      assert.equal(legal.raise.max, hand.players[seat].streetBet + stack);
    }
  }
}

function checkHandEvents(table, events, state) {
  for (const ev of events) {
    if (ev.e === 'turn') {
      assert.ok(ev.turnId > state.lastTurnId, 'turnId increases');
      state.lastTurnId = ev.turnId;
    }
    if (ev.e === 'reveal') state.reveals++;
    if (ev.e === 'showdown') state.showdown = true;
    if (ev.e === 'win') {
      assert.equal(sum(ev.winners, (w) => w.amount), ev.amount, 'win shares sum to pot');
      state.won += ev.amount;
      if (ev.uncontested) state.uncontested = true;
    }
  }
  if (events.some((ev) => ev.e === 'handEnd')) {
    const committed = sum(Object.values(table.hand.players), (p) => p.committed);
    assert.equal(state.won, committed, 'every committed chip is awarded');
    assert.ok(state.reveals <= 1, 'reveal at most once');
    if (state.uncontested) assert.ok(!state.showdown && state.reveals === 0, 'no cards shown when uncontested');
    else assert.ok(state.showdown, 'contested hands reach showdown');
    state.ended = true;
  }
}

function playTable(seed) {
  const rng = seededRng(seed);
  const config = CONFIGS[seed % CONFIGS.length];
  const table = createTable(config);
  const initial = 2 + Math.floor(rng() * 5);
  for (let i = 0; i < initial; i++) addPlayer(table, { id: `p${i}`, name: `P${i}` });
  let joined = initial;
  let hands = 0;
  let lastTurnId = 0;

  const maybeJoin = () => {
    if (rng() < 0.01 && table.seats.includes(null)) {
      const seat = addPlayer(table, { id: `p${joined}`, name: `P${joined}` });
      joined++;
      if (table.hand && table.hand.phase !== 'complete') assert.ok(!(seat in table.hand.players));
      checkInvariants(table);
    }
  };

  while (hands < HANDS_PER_TABLE && canStartHand(table)) {
    const state = { lastTurnId, reveals: 0, showdown: false, uncontested: false, won: 0, ended: false };
    const startEvents = startHand(table, { rng });
    hands++;
    const dealt = table.hand.players;
    for (const seat of Object.keys(dealt)) assert.ok(table.seats[seat].stack + dealt[seat].committed > 0);
    checkInvariants(table);
    checkHandEvents(table, startEvents, state);

    let actions = 0;
    while (table.hand.phase !== 'complete') {
      assert.ok(++actions <= MAX_ACTIONS_PER_HAND, 'hand terminates');
      const seat = table.hand.toAct;
      const action = chooseAction(legalActions(table, seat), rng);
      const events = applyAction(table, seat, action);
      checkInvariants(table);
      checkHandEvents(table, events, state);

      const turnIdx = events.findIndex((ev) => ev.e === 'turn');
      if (turnIdx !== -1 && events[turnIdx].seat === seat)
        assert.ok(events.slice(0, turnIdx).some((ev) => ev.e === 'board'), 'same seat asked twice in a row');
      maybeJoin();
    }
    assert.ok(state.ended, 'handEnd emitted');
    lastTurnId = state.lastTurnId;
    maybeJoin();
  }
  return hands;
}

test(`fuzz: ${TARGET_HANDS}+ random legal hands keep every invariant`, () => {
  let total = 0;
  let tables = 0;
  while (total < TARGET_HANDS) total += playTable(++tables);
  assert.ok(total >= TARGET_HANDS);
});
