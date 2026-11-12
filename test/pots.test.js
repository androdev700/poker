import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uncalledRefund, buildPots, distribute } from '../server/engine/pots.js';

const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);
const committedTotal = (players) => players.reduce((s, p) => s + p.committed, 0);

test('single pot when everyone commits the same', () => {
  const players = [
    { seat: 0, committed: 100, folded: false },
    { seat: 1, committed: 100, folded: false },
    { seat: 2, committed: 100, folded: false },
  ];
  assert.deepEqual(buildPots(players), [{ amount: 300, eligible: [0, 1, 2] }]);
});

test('three-way all-ins at different stacks build main and two side pots', () => {
  const players = [
    { seat: 4, committed: 300, folded: false },
    { seat: 1, committed: 50, folded: false },
    { seat: 2, committed: 150, folded: false },
    { seat: 3, committed: 300, folded: false },
  ];
  const pots = buildPots(players);
  assert.deepEqual(pots, [
    { amount: 200, eligible: [1, 2, 3, 4] },
    { amount: 300, eligible: [2, 3, 4] },
    { amount: 300, eligible: [3, 4] },
  ]);
  assert.equal(sum(pots), committedTotal(players));
});

test('folded contributor chips count but the player is not eligible', () => {
  const players = [
    { seat: 0, committed: 40, folded: true },
    { seat: 1, committed: 100, folded: false },
    { seat: 2, committed: 100, folded: false },
  ];
  assert.deepEqual(buildPots(players), [{ amount: 240, eligible: [1, 2] }]);
});

test('folded chips above the top live level land in the last pot', () => {
  const players = [
    { seat: 0, committed: 500, folded: true },
    { seat: 1, committed: 100, folded: false },
    { seat: 2, committed: 200, folded: false },
  ];
  const pots = buildPots(players);
  assert.deepEqual(pots, [
    { amount: 300, eligible: [1, 2] },
    { amount: 500, eligible: [2] },
  ]);
  assert.equal(sum(pots), committedTotal(players));
});

test('folded commitment levels do not split pots with identical eligibility', () => {
  const players = [
    { seat: 0, committed: 30, folded: true },
    { seat: 1, committed: 70, folded: true },
    { seat: 2, committed: 100, folded: false },
    { seat: 3, committed: 100, folded: false },
  ];
  assert.deepEqual(buildPots(players), [{ amount: 300, eligible: [2, 3] }]);
});

test('a lone live player gets a single pot with everything', () => {
  const players = [
    { seat: 0, committed: 80, folded: true },
    { seat: 1, committed: 20, folded: false },
    { seat: 2, committed: 50, folded: true },
  ];
  assert.deepEqual(buildPots(players), [{ amount: 150, eligible: [1] }]);
});

test('buildPots does not mutate its input', () => {
  const players = [
    { seat: 0, committed: 10, folded: false },
    { seat: 1, committed: 20, folded: false },
  ];
  const copy = structuredClone(players);
  buildPots(players);
  assert.deepEqual(players, copy);
});

test('uncalled refund returns the excess over the second-highest bet', () => {
  const players = [
    { seat: 0, streetBet: 500, folded: false },
    { seat: 1, streetBet: 200, folded: false },
    { seat: 2, streetBet: 100, folded: false },
  ];
  assert.deepEqual(uncalledRefund(players), { seat: 0, amount: 300 });
});

test('uncalled refund is null when the top two bets are equal', () => {
  const players = [
    { seat: 0, streetBet: 200, folded: false },
    { seat: 1, streetBet: 200, folded: false },
    { seat: 2, streetBet: 50, folded: true },
  ];
  assert.equal(uncalledRefund(players), null);
});

test('uncalled refund counts a folded second-highest contributor', () => {
  const players = [
    { seat: 0, streetBet: 600, folded: false },
    { seat: 1, streetBet: 400, folded: true },
    { seat: 2, streetBet: 100, folded: false },
  ];
  assert.deepEqual(uncalledRefund(players), { seat: 0, amount: 200 });
});

test('uncalled refund is null with nothing to refund or a folded top bettor', () => {
  assert.equal(uncalledRefund([]), null);
  assert.equal(uncalledRefund([{ seat: 0, streetBet: 0, folded: false }]), null);
  assert.equal(
    uncalledRefund([
      { seat: 0, streetBet: 300, folded: true },
      { seat: 1, streetBet: 100, folded: false },
    ]),
    null,
  );
});

test('odd chip goes to the first winner left of the button', () => {
  assert.deepEqual(distribute(101, [3, 1], 2, 6), [
    { seat: 3, amount: 51 },
    { seat: 1, amount: 50 },
  ]);
});

test('odd chip order wraps around past the last seat', () => {
  assert.deepEqual(distribute(5, [2, 0], 5, 6), [
    { seat: 0, amount: 3 },
    { seat: 2, amount: 2 },
  ]);
});

test('three-way split with remainder two', () => {
  const result = distribute(11, [0, 3, 5], 3, 6);
  assert.deepEqual(result, [
    { seat: 5, amount: 4 },
    { seat: 0, amount: 4 },
    { seat: 3, amount: 3 },
  ]);
  assert.equal(sum(result), 11);
});

test('totals are conserved across random hands', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 500; i++) {
    const count = 2 + rand(8);
    const players = Array.from({ length: count }, (_, seat) => ({
      seat,
      committed: rand(400),
      folded: rand(3) === 0,
    }));
    const pots = buildPots(players);
    assert.equal(sum(pots), committedTotal(players));
    for (const pot of pots) {
      assert.ok(pot.amount > 0);
      const winners = pot.eligible.length ? pot.eligible.slice(0, 1 + rand(pot.eligible.length)) : [];
      if (winners.length) assert.equal(sum(distribute(pot.amount, winners, rand(count), count)), pot.amount);
    }
  }
});
