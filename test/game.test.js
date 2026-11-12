import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../shared/cards.js';
import { ERR } from '../shared/protocol.js';
import { seededRng } from '../server/engine/deck.js';
import {
  EngineError,
  createTable,
  addPlayer,
  canStartHand,
  startHand,
  legalActions,
  applyAction,
  totalChips,
  abortHand,
} from '../server/engine/game.js';

const zero = () => 0;

/** Seats 0..n-1; with rng `zero` the first button is seat 0. */
function setup(n, { buyIn = 1000, smallBlind = 5, bigBlind = 10, stacks } = {}) {
  const table = createTable({ buyIn, smallBlind, bigBlind });
  for (let i = 0; i < n; i++) addPlayer(table, { id: `p${i}`, name: `P${i}` });
  if (stacks) stacks.forEach((stack, i) => (table.seats[i].stack = stack));
  return table;
}

/** A deck that deals `holes` (seat -> [c1, c2]) in dealing `order`, then `board`. */
function deckFor(order, holes, board = []) {
  const top = [...order.map((s) => holes[s][0]), ...order.map((s) => holes[s][1]), ...board];
  return [...top, ...makeDeck().filter((c) => !top.includes(c))];
}

const act = (table, type, amount) => applyAction(table, table.hand.toAct, { type, amount });
const only = (events, e) => events.filter((ev) => ev.e === e);
const kinds = (events) => events.map((ev) => ev.e);
const last = (events) => events[events.length - 1];

test('heads-up: button posts the small blind, acts first preflop and last postflop', () => {
  const t = setup(2);
  const ev = startHand(t, { rng: zero });
  assert.deepEqual(ev[0], { e: 'handStart', handId: 1, button: 0, sbSeat: 0, bbSeat: 1, seats: [0, 1] });
  assert.deepEqual(only(ev, 'blind'), [
    { e: 'blind', seat: 0, amount: 5, kind: 'small' },
    { e: 'blind', seat: 1, amount: 10, kind: 'big' },
  ]);
  assert.deepEqual(only(ev, 'deal')[0].order, [1, 0]);
  assert.deepEqual(last(ev), { e: 'turn', seat: 0, turnId: 1 });
  assert.deepEqual(legalActions(t, 0), { check: false, call: 5, raise: { min: 20, max: 1000 } });
  assert.equal(legalActions(t, 1), null);

  let e = act(t, 'call');
  assert.deepEqual(e[0], { e: 'action', seat: 0, kind: 'call', added: 5, to: 10, allIn: false });
  assert.deepEqual(last(e), { e: 'turn', seat: 1, turnId: 2 });
  assert.deepEqual(legalActions(t, 1), { check: true, call: 0, raise: { min: 20, max: 1000 } });

  e = act(t, 'check');
  assert.deepEqual(kinds(e), ['action', 'collect', 'board', 'turn']);
  assert.deepEqual(e[1].pots, [{ amount: 20 }]);
  assert.equal(e[2].street, 'flop');
  assert.equal(e[2].cards.length, 3);
  assert.equal(last(e).seat, 1);

  assert.equal(last(act(t, 'check')).seat, 0);
  e = act(t, 'check');
  assert.deepEqual(kinds(e), ['action', 'board', 'turn']);
  assert.equal(e[1].street, 'turn');
  assert.equal(last(e).seat, 1);
  assert.equal(totalChips(t), 2000);
});

test('three-handed: action starts left of the big blind preflop and left of the button postflop', () => {
  const t = setup(3);
  const ev = startHand(t, { rng: zero });
  assert.deepEqual(ev[0], { e: 'handStart', handId: 1, button: 0, sbSeat: 1, bbSeat: 2, seats: [0, 1, 2] });
  assert.deepEqual(only(ev, 'deal')[0].order, [1, 2, 0]);
  assert.equal(t.hand.toAct, 0);
  act(t, 'call');
  assert.equal(t.hand.toAct, 1);
  assert.deepEqual(act(t, 'call')[0], { e: 'action', seat: 1, kind: 'call', added: 5, to: 10, allIn: false });
  assert.equal(t.hand.toAct, 2);
  act(t, 'check');
  assert.equal(t.hand.phase, 'flop');
  assert.equal(t.hand.toAct, 1);
  act(t, 'check');
  assert.equal(t.hand.toAct, 2);
  act(t, 'check');
  assert.equal(t.hand.toAct, 0);
  act(t, 'check');
  assert.equal(t.hand.phase, 'turn');
  assert.equal(t.hand.toAct, 1);
});

test('big blind gets its option after limps and may raise, reopening the action', () => {
  const t = setup(3);
  startHand(t, { rng: zero });
  act(t, 'call');
  const e = act(t, 'call');
  assert.ok(!kinds(e).includes('collect') && !kinds(e).includes('board'), 'round must not close before BB acts');
  assert.equal(t.hand.toAct, 2);
  assert.deepEqual(legalActions(t, 2), { check: true, call: 0, raise: { min: 20, max: 1000 } });

  const r = act(t, 'raiseTo', 40);
  assert.deepEqual(r[0], { e: 'action', seat: 2, kind: 'raise', added: 30, to: 40, allIn: false });
  assert.equal(t.hand.toAct, 0);
  assert.deepEqual(legalActions(t, 0), { check: false, call: 30, raise: { min: 70, max: 1000 } });
  act(t, 'call');
  act(t, 'call');
  assert.equal(t.hand.phase, 'flop');
});

test('short small blind posts what it has and is skipped while all-in', () => {
  const t = setup(3, { stacks: [1000, 3, 1000] });
  const ev = startHand(t, { rng: zero });
  assert.deepEqual(only(ev, 'blind'), [
    { e: 'blind', seat: 1, amount: 3, kind: 'small' },
    { e: 'blind', seat: 2, amount: 10, kind: 'big' },
  ]);
  assert.equal(t.hand.currentBet, 10);
  assert.equal(t.hand.lastRaiseSize, 10);
  assert.equal(t.hand.players[1].actedAtBet, null);
  assert.deepEqual(legalActions(t, 0), { check: false, call: 10, raise: { min: 20, max: 1000 } });
  act(t, 'call');
  assert.equal(t.hand.toAct, 2, 'all-in small blind is not asked to act');
  const e = act(t, 'check');
  assert.deepEqual(only(e, 'refund'), []);
  assert.deepEqual(only(e, 'collect')[0].pots, [{ amount: 9 }, { amount: 14 }]);
  assert.equal(t.hand.phase, 'flop');
  assert.equal(t.hand.toAct, 2);
});

test('short big blind posts all-in; currentBet stays the full big blind', () => {
  const t = setup(3, { stacks: [1000, 1000, 4] });
  const ev = startHand(t, { rng: zero });
  assert.deepEqual(only(ev, 'blind')[1], { e: 'blind', seat: 2, amount: 4, kind: 'big' });
  assert.equal(t.hand.currentBet, 10);
  assert.deepEqual(legalActions(t, 0), { check: false, call: 10, raise: { min: 20, max: 1000 } });
  act(t, 'call');
  const e = act(t, 'call');
  assert.deepEqual(e[0], { e: 'action', seat: 1, kind: 'call', added: 5, to: 10, allIn: false });
  assert.deepEqual(only(e, 'collect')[0].pots, [{ amount: 12 }, { amount: 12 }]);
  assert.equal(t.hand.phase, 'flop');
  assert.equal(t.hand.toAct, 1);
});

test('min-raise follows the last full raise size, preflop and postflop', () => {
  const t = setup(2);
  startHand(t, { rng: zero });
  act(t, 'raiseTo', 30);
  assert.deepEqual(legalActions(t, 1), { check: false, call: 20, raise: { min: 50, max: 1000 } });
  act(t, 'call');

  assert.equal(t.hand.phase, 'flop');
  assert.deepEqual(legalActions(t, 1), { check: true, call: 0, raise: { min: 10, max: 970 } });
  const bet = act(t, 'raiseTo', 30);
  assert.deepEqual(bet[0], { e: 'action', seat: 1, kind: 'bet', added: 30, to: 30, allIn: false });
  assert.deepEqual(legalActions(t, 0), { check: false, call: 30, raise: { min: 60, max: 970 } });
  const raise = act(t, 'raiseTo', 100);
  assert.deepEqual(raise[0], { e: 'action', seat: 0, kind: 'raise', added: 100, to: 100, allIn: false });
  assert.deepEqual(legalActions(t, 1), { check: false, call: 70, raise: { min: 170, max: 970 } });
});

test('an incomplete all-in raise does not reopen the action for a player who already acted', () => {
  const t = setup(3, { stacks: [1000, 1000, 160] });
  startHand(t, { rng: zero });
  act(t, 'call');
  act(t, 'call');
  act(t, 'check');
  assert.equal(t.hand.toAct, 1);
  act(t, 'raiseTo', 100);
  assert.deepEqual(legalActions(t, 2), { check: false, call: 100, raise: { min: 150, max: 150 } });
  const shove = act(t, 'raiseTo', 150);
  assert.deepEqual(shove[0], { e: 'action', seat: 2, kind: 'raise', added: 150, to: 150, allIn: true });
  assert.equal(t.hand.lastRaiseSize, 100);
  assert.deepEqual(legalActions(t, 0), { check: false, call: 150, raise: { min: 250, max: 990 } });
  act(t, 'call');
  assert.deepEqual(legalActions(t, 1), { check: false, call: 50, raise: null });
  const before = structuredClone(t);
  assert.throws(() => act(t, 'raiseTo', 250), EngineError);
  assert.deepEqual(t, before);
});

test('two short all-ins that add up to a full raise do reopen the action', () => {
  const t = setup(4, { stacks: [1000, 1000, 160, 220] });
  startHand(t, { rng: zero });
  act(t, 'call');
  act(t, 'call');
  act(t, 'call');
  act(t, 'check');
  assert.equal(t.hand.phase, 'flop');
  assert.equal(t.hand.toAct, 1);
  act(t, 'raiseTo', 100);
  act(t, 'raiseTo', 150);
  assert.deepEqual(legalActions(t, 3), { check: false, call: 150, raise: { min: 210, max: 210 } });
  act(t, 'raiseTo', 210);
  assert.equal(t.hand.lastRaiseSize, 100);
  act(t, 'call');
  assert.equal(t.hand.toAct, 1);
  assert.deepEqual(legalActions(t, 1), { check: false, call: 110, raise: { min: 310, max: 990 } });
});

test('no raise is offered when every opponent is all-in, or when only an all-in call is possible', () => {
  let t = setup(2);
  startHand(t, { rng: zero });
  act(t, 'raiseTo', 1000);
  assert.deepEqual(legalActions(t, 1), { check: false, call: 990, raise: null });

  t = setup(3, { stacks: [1000, 1000, 400] });
  startHand(t, { rng: zero });
  act(t, 'raiseTo', 800);
  act(t, 'fold');
  assert.deepEqual(legalActions(t, 2), { check: false, call: 390, raise: null });
});

test('fold-out wins uncontested: uncalled part refunded, no cards shown', () => {
  const t = setup(3);
  startHand(t, { rng: zero });
  act(t, 'raiseTo', 30);
  act(t, 'fold');
  const e = act(t, 'fold');
  assert.deepEqual(e, [
    { e: 'action', seat: 2, kind: 'fold', added: 0, to: 10, allIn: false },
    { e: 'refund', seat: 0, amount: 20 },
    { e: 'collect', pots: [{ amount: 25 }] },
    { e: 'win', potIndex: 0, amount: 25, winners: [{ seat: 0, amount: 25 }], uncontested: true },
    { e: 'handEnd', stacks: { 0: 1015, 1: 995, 2: 990 } },
  ]);
  assert.equal(t.hand.phase, 'complete');
  assert.equal(t.hand.toAct, null);
  assert.equal(t.hand.revealed, false);
  assert.equal(totalChips(t), 3000);
  assert.ok(canStartHand(t));
});

test('a small blind that already covers a short all-in big blind is not asked to act', () => {
  const t = setup(2, { stacks: [1000, 4] });
  const e = startHand(t, { rng: zero });
  assert.equal(e.some((ev) => ev.e === 'turn'), false);
  assert.deepEqual(e.find((ev) => ev.e === 'refund'), { e: 'refund', seat: 0, amount: 1 });
  assert.equal(e.filter((ev) => ev.e === 'reveal').length, 1);
  assert.equal(e.filter((ev) => ev.e === 'board').length, 3);
  assert.equal(t.hand.phase, 'complete');
  assert.equal(totalChips(t), 1004);
  const { stacks } = last(e);
  assert.ok(stacks[1] === 8 || stacks[1] === 0 || stacks[1] === 4);
});

test('all-in preflop runs out the board with a single reveal', () => {
  const t = setup(2);
  const holes = { 0: ['Kh', 'Kd'], 1: ['Ah', 'Ad'] };
  startHand(t, { rng: zero, deck: deckFor([1, 0], holes, ['2c', '7d', '9s', 'Jh', '3c']) });
  act(t, 'raiseTo', 1000);
  const e = act(t, 'call');
  assert.deepEqual(kinds(e), [
    'action', 'collect', 'reveal', 'board', 'board', 'board', 'showdown', 'win', 'bust', 'handEnd',
  ]);
  assert.deepEqual(e[0], { e: 'action', seat: 1, kind: 'call', added: 990, to: 1000, allIn: true });
  assert.deepEqual(e[1].pots, [{ amount: 2000 }]);
  assert.deepEqual(e[2], { e: 'reveal', hands: [{ seat: 1, cards: ['Ah', 'Ad'] }, { seat: 0, cards: ['Kh', 'Kd'] }] });
  assert.deepEqual(only(e, 'board'), [
    { e: 'board', street: 'flop', cards: ['2c', '7d', '9s'] },
    { e: 'board', street: 'turn', cards: ['Jh'] },
    { e: 'board', street: 'river', cards: ['3c'] },
  ]);
  assert.deepEqual(only(e, 'showdown')[0].hands.map((h) => [h.seat, h.name]), [
    [1, 'Pair of Aces'],
    [0, 'Pair of Kings'],
  ]);
  assert.deepEqual(only(e, 'win'), [
    { e: 'win', potIndex: 0, amount: 2000, winners: [{ seat: 1, amount: 2000 }], uncontested: false },
  ]);
  assert.deepEqual(only(e, 'bust'), [{ e: 'bust', seat: 0 }]);
  assert.deepEqual(last(e).stacks, { 0: 0, 1: 2000 });
  assert.equal(t.seats[0].busted, true);
  assert.equal(t.hand.revealed, true);
  assert.deepEqual(t.hand.board, ['2c', '7d', '9s', 'Jh', '3c']);
  assert.equal(canStartHand(t), false);
});

test('all-in on the flop reveals once and deals only turn and river', () => {
  const t = setup(2);
  const holes = { 0: ['Kh', 'Kd'], 1: ['Ah', 'Ad'] };
  startHand(t, { rng: zero, deck: deckFor([1, 0], holes, ['2c', '7d', '9s', 'Jh', 'Kc']) });
  act(t, 'call');
  const flop = act(t, 'check');
  assert.equal(only(flop, 'reveal').length, 0);
  assert.deepEqual(act(t, 'raiseTo', 990)[0], { e: 'action', seat: 1, kind: 'bet', added: 990, to: 990, allIn: true });
  const e = act(t, 'call');
  assert.equal(only(e, 'reveal').length, 1);
  assert.deepEqual(only(e, 'board').map((b) => [b.street, b.cards]), [
    ['turn', ['Jh']],
    ['river', ['Kc']],
  ]);
  assert.deepEqual(only(e, 'win')[0].winners, [{ seat: 0, amount: 2000 }]);
  assert.deepEqual(only(e, 'bust'), [{ e: 'bust', seat: 1 }]);
});

test('heads-up blinds put both players all-in: straight to showdown with no turn', () => {
  const t = setup(2, { stacks: [5, 8] });
  const holes = { 0: ['Ah', 'Ad'], 1: ['Kh', 'Kd'] };
  const ev = startHand(t, { rng: zero, deck: deckFor([1, 0], holes, ['2c', '7d', '9s', 'Jh', '3c']) });
  assert.deepEqual(kinds(ev), [
    'handStart', 'blind', 'blind', 'deal', 'refund', 'collect', 'reveal', 'board', 'board', 'board', 'showdown', 'win',
    'handEnd',
  ]);
  assert.deepEqual(only(ev, 'refund'), [{ e: 'refund', seat: 1, amount: 3 }]);
  assert.deepEqual(only(ev, 'win')[0].winners, [{ seat: 0, amount: 10 }]);
  assert.deepEqual(last(ev).stacks, { 0: 10, 1: 3 });
  assert.equal(t.hand.phase, 'complete');
  assert.equal(totalChips(t), 13);
});

test('heads-up small blind all-in from its post: the big blind is not asked to act alone', () => {
  const t = setup(2, { stacks: [3, 1000] });
  const ev = startHand(t, { rng: zero });
  assert.equal(only(ev, 'turn').length, 0);
  assert.deepEqual(only(ev, 'refund'), [{ e: 'refund', seat: 1, amount: 7 }]);
  assert.equal(only(ev, 'reveal').length, 1);
  assert.equal(t.hand.phase, 'complete');
  assert.equal(totalChips(t), 1003);
});

test('an uncalled refund leaves the bettor with chips, not all-in', () => {
  const t = setup(2, { stacks: [1000, 300] });
  const holes = { 0: ['Kh', 'Kd'], 1: ['Ah', 'Ad'] };
  startHand(t, { rng: zero, deck: deckFor([1, 0], holes, ['2c', '7d', '9s', 'Jh', '3c']) });
  assert.equal(act(t, 'raiseTo', 1000)[0].allIn, true);
  const e = act(t, 'call');
  assert.deepEqual(e[0], { e: 'action', seat: 1, kind: 'call', added: 290, to: 300, allIn: true });
  assert.deepEqual(e[1], { e: 'refund', seat: 0, amount: 700 });
  assert.deepEqual(only(e, 'win')[0].winners, [{ seat: 1, amount: 600 }]);
  assert.deepEqual(only(e, 'bust'), []);
  assert.equal(t.seats[0].stack, 700);
  assert.equal(t.seats[0].busted, false);
  assert.ok(canStartHand(t));
});

test('side pots are awarded to different winners', () => {
  const t = setup(3, { stacks: [1000, 200, 500] });
  const holes = { 0: ['Qh', 'Qd'], 1: ['Ah', 'Ad'], 2: ['Kh', 'Kd'] };
  startHand(t, { rng: zero, deck: deckFor([1, 2, 0], holes, ['2c', '7d', '9s', 'Jc', '3s']) });
  act(t, 'raiseTo', 500);
  act(t, 'call');
  const e = act(t, 'call');
  assert.deepEqual(only(e, 'collect')[0].pots, [{ amount: 600 }, { amount: 600 }]);
  assert.deepEqual(only(e, 'win'), [
    { e: 'win', potIndex: 0, amount: 600, winners: [{ seat: 1, amount: 600 }], uncontested: false },
    { e: 'win', potIndex: 1, amount: 600, winners: [{ seat: 2, amount: 600 }], uncontested: false },
  ]);
  assert.deepEqual(last(e).stacks, { 0: 500, 1: 600, 2: 600 });
});

test('split pot gives the odd chip to the first winner left of the button', () => {
  const t = setup(3);
  const holes = { 0: ['2c', '3d'], 1: ['6h', '7h'], 2: ['4c', '5d'] };
  startHand(t, { rng: zero, deck: deckFor([1, 2, 0], holes, ['Ts', 'Js', 'Qs', 'Ks', 'As']) });
  act(t, 'call');
  act(t, 'fold');
  act(t, 'check');
  let e;
  for (let i = 0; i < 6; i++) e = act(t, 'check');
  const showdown = only(e, 'showdown')[0];
  assert.deepEqual(showdown.hands.map((h) => [h.seat, h.name]), [
    [2, 'Royal Flush'],
    [0, 'Royal Flush'],
  ]);
  assert.deepEqual(only(e, 'win'), [
    {
      e: 'win',
      potIndex: 0,
      amount: 25,
      winners: [
        { seat: 2, amount: 13 },
        { seat: 0, amount: 12 },
      ],
      uncontested: false,
    },
  ]);
  assert.equal(only(e, 'reveal').length, 0);
});

test('button skips a busted seat and the 3 -> 2 transition uses heads-up rules', () => {
  const t = setup(3);
  const holes = { 0: ['2c', '3d'], 1: ['Kh', 'Kd'], 2: ['Ah', 'Ad'] };
  startHand(t, { rng: zero, deck: deckFor([1, 2, 0], holes, ['2s', '7d', '9s', 'Jc', '4h']) });
  act(t, 'fold');
  act(t, 'raiseTo', 1000);
  const e = act(t, 'call');
  assert.deepEqual(only(e, 'bust'), [{ e: 'bust', seat: 1 }]);
  assert.deepEqual(last(e).stacks, { 0: 1000, 1: 0, 2: 2000 });

  const ev = startHand(t, { rng: zero });
  assert.deepEqual(ev[0], { e: 'handStart', handId: 2, button: 2, sbSeat: 2, bbSeat: 0, seats: [0, 2] });
  assert.deepEqual(only(ev, 'deal')[0].order, [0, 2]);
  assert.equal(t.hand.toAct, 2);
  assert.ok(!(1 in t.hand.players));
  act(t, 'call');
  act(t, 'check');
  assert.equal(t.hand.toAct, 0, 'big blind acts first postflop heads-up');
  assert.equal(totalChips(t), 3000);
});

test('a player who joins mid-hand is not dealt in until the next hand', () => {
  const t = setup(2);
  startHand(t, { rng: zero });
  const seat = addPlayer(t, { id: 'late', name: 'Late' });
  assert.equal(seat, 2);
  assert.ok(!(seat in t.hand.players));
  assert.equal(legalActions(t, seat), null);
  assert.equal(totalChips(t), 3000);
  assert.equal(t.seatsEverFilled, 3);
  assert.throws(() => applyAction(t, seat, { type: 'fold' }), EngineError);
  const e = act(t, 'fold');
  assert.deepEqual(last(e).stacks, { 0: 995, 1: 1005, 2: 1000 });

  const ev = startHand(t, { rng: zero });
  assert.deepEqual(ev[0], { e: 'handStart', handId: 2, button: 1, sbSeat: 2, bbSeat: 0, seats: [0, 1, 2] });
  assert.equal(t.hand.toAct, 1);
});

test('illegal actions throw EngineError and leave state untouched', () => {
  const isIllegal = (err) => err instanceof EngineError && err.code === ERR.ILLEGAL_ACTION;
  const t = setup(3);
  assert.throws(() => applyAction(t, 0, { type: 'fold' }), isIllegal, 'no hand yet');
  startHand(t, { rng: zero });

  const attempts = [
    [1, { type: 'call' }],
    [0, { type: 'check' }],
    [0, { type: 'raiseTo', amount: 15 }],
    [0, { type: 'raiseTo', amount: 1001 }],
    [0, { type: 'raiseTo', amount: 20.5 }],
    [0, { type: 'raiseTo', amount: '30' }],
    [0, { type: 'raiseTo' }],
    [0, { type: 'allin' }],
    [0, undefined],
  ];
  for (const [seat, action] of attempts) {
    const before = structuredClone(t);
    assert.throws(() => applyAction(t, seat, action), isIllegal, JSON.stringify(action));
    assert.deepEqual(t, before);
  }

  act(t, 'call');
  act(t, 'call');
  const before = structuredClone(t);
  assert.throws(() => act(t, 'call'), isIllegal, 'nothing to call at the BB option');
  assert.deepEqual(t, before);

  const h = setup(2);
  startHand(h, { rng: zero });
  act(h, 'raiseTo', 1000);
  const snap = structuredClone(h);
  assert.throws(() => act(h, 'raiseTo', 1000), isIllegal, 'raise not allowed against an all-in');
  assert.deepEqual(h, snap);

  assert.throws(() => startHand(h, { rng: zero }), (err) => err.code === ERR.CANNOT_START);
  const full = setup(6);
  assert.throws(() => addPlayer(full, { id: 'x', name: 'X' }), (err) => err.code === ERR.ROOM_FULL);
});

test('abortHand returns committed chips and completes the hand', () => {
  const t = setup(3);
  startHand(t, { rng: zero });
  act(t, 'raiseTo', 100);
  act(t, 'call');
  assert.deepEqual(abortHand(t), [{ e: 'handEnd', stacks: { 0: 1000, 1: 1000, 2: 1000 } }]);
  assert.equal(t.hand.phase, 'complete');
  assert.equal(t.hand.toAct, null);
  assert.equal(legalActions(t, 2), null);
  assert.equal(totalChips(t), 3000);
  assert.ok(canStartHand(t));
  assert.deepEqual(abortHand(t), []);
});

const SEAT = (v) => Number.isInteger(v) && v >= 0 && v < 6;
const INT = (v) => Number.isInteger(v) && v >= 0;
const BOOL = (v) => typeof v === 'boolean';
const CARD = (v) => typeof v === 'string' && /^[2-9TJQKA][cdhs]$/.test(v);
const CARDS = (n) => (v) => Array.isArray(v) && v.length === n && v.every(CARD);
const ONE_OF = (...xs) => (v) => xs.includes(v);
const ARRAY_OF = (f) => (v) => Array.isArray(v) && v.every(f);
const SHAPE = (spec) => (v) =>
  v !== null &&
  typeof v === 'object' &&
  Object.keys(v).sort().join() === Object.keys(spec).sort().join() &&
  Object.entries(spec).every(([k, f]) => f(v[k]));
const SEAT_MAP = (f) => (v) =>
  v !== null && typeof v === 'object' && Object.entries(v).every(([k, x]) => SEAT(Number(k)) && f(x));

const EVENT_SHAPES = {
  handStart: { handId: INT, button: SEAT, sbSeat: SEAT, bbSeat: SEAT, seats: ARRAY_OF(SEAT) },
  blind: { seat: SEAT, amount: INT, kind: ONE_OF('small', 'big') },
  deal: { order: ARRAY_OF(SEAT), cards: SEAT_MAP(CARDS(2)) },
  turn: { seat: SEAT, turnId: INT },
  action: {
    seat: SEAT,
    kind: ONE_OF('fold', 'check', 'call', 'bet', 'raise'),
    added: INT,
    to: INT,
    allIn: BOOL,
  },
  refund: { seat: SEAT, amount: INT },
  collect: { pots: ARRAY_OF(SHAPE({ amount: INT })) },
  reveal: { hands: ARRAY_OF(SHAPE({ seat: SEAT, cards: CARDS(2) })) },
  board: { street: ONE_OF('flop', 'turn', 'river'), cards: (v) => CARDS(v.length)(v) && [1, 3].includes(v.length) },
  showdown: {
    hands: ARRAY_OF(SHAPE({ seat: SEAT, cards: CARDS(2), name: (v) => typeof v === 'string', best5: CARDS(5) })),
  },
  win: {
    potIndex: INT,
    amount: INT,
    winners: ARRAY_OF(SHAPE({ seat: SEAT, amount: INT })),
    uncontested: BOOL,
  },
  bust: { seat: SEAT },
  handEnd: { stacks: SEAT_MAP(INT) },
};

test('every emitted event matches the protocol typedefs and the state stays JSON-able', () => {
  const rng = seededRng(7);
  const seen = new Set();
  const check = (events) => {
    for (const ev of events) {
      const spec = EVENT_SHAPES[ev.e];
      assert.ok(spec, `unknown event ${ev.e}`);
      assert.ok(SHAPE({ e: () => true, ...spec })(ev), `bad ${ev.e} event: ${JSON.stringify(ev)}`);
      seen.add(ev.e);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(events)), events);
  };
  for (let n = 0; n < 40; n++) {
    const t = setup(2 + (n % 5), { buyIn: 100, smallBlind: 5, bigBlind: 10 });
    while (canStartHand(t) && t.handNumber < 30) {
      check(startHand(t, { rng }));
      while (t.hand.phase !== 'complete') {
        const legal = legalActions(t, t.hand.toAct);
        const r = rng();
        const action =
          legal.raise && r < 0.3
            ? { type: 'raiseTo', amount: r < 0.1 ? legal.raise.max : legal.raise.min }
            : r < 0.45
              ? { type: 'fold' }
              : { type: legal.check ? 'check' : 'call' };
        check(applyAction(t, t.hand.toAct, action));
        assert.deepEqual(JSON.parse(JSON.stringify(t)), t);
      }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(EVENT_SHAPES).sort());
});

test('the same seed replays the same hands', () => {
  const run = () => {
    const t = setup(4);
    const rng = seededRng(42);
    const log = [];
    for (let h = 0; h < 5; h++) {
      log.push(...startHand(t, { rng }));
      while (t.hand.phase !== 'complete') log.push(...act(t, legalActions(t, t.hand.toAct).check ? 'check' : 'call'));
    }
    return log;
  };
  assert.deepEqual(run(), run());
});
