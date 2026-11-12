import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate5, evaluate7, describe } from '../server/engine/evaluator.js';
import { shuffle, seededRng, cryptoRng } from '../server/engine/deck.js';
import { makeDeck } from '../shared/cards.js';

const h = (s) => s.split(' ');
const e5 = (s) => evaluate5(h(s));
const e7 = (s) => evaluate7(h(s));

test('each category beats the one below it', () => {
  const ladder = [
    ['Ks Qs Js Ts 9s', 'Straight Flush, King high'],
    ['7c 7d 7h 7s 2c', 'Four of a Kind, Sevens'],
    ['3c 3d 3h 2s 2c', 'Full House, Threes over Twos'],
    ['Ah Jh 8h 6h 2h', 'Flush, Ace high'],
    ['9c 8d 7h 6s 5c', 'Straight, Nine high'],
    ['Qc Qd Qh 4s 2c', 'Three of a Kind, Queens'],
    ['Ac Ad 8h 8s Kc', 'Two Pair, Aces and Eights'],
    ['Jc Jd 9h 4s 2c', 'Pair of Jacks'],
    ['Ac Kd Qh Js 9c', 'High Card, Ace'],
  ];
  for (let i = 0; i < ladder.length; i++) {
    assert.equal(describe(e5(ladder[i][0])), ladder[i][1]);
    if (i > 0) assert.ok(e5(ladder[i - 1][0]) > e5(ladder[i][0]), `${ladder[i - 1][1]} > ${ladder[i][1]}`);
  }
});

test('weakest of each category still beats strongest of the category below', () => {
  const pairs = [
    ['5s 4s 3s 2s As', 'Ac Ad Ah As Kc'],
    ['2c 2d 2h 2s 3c', 'Ac Ad Ah Ks Kc'],
    ['2c 2d 2h 3s 3c', 'Ah Kh Qh Jh 9h'],
    ['7h 5h 4h 3h 2h', 'Ac Kd Qh Js Tc'],
    ['5c 4d 3h 2s Ac', 'Ac Ad Ah Ks Qc'],
    ['2c 2d 2h 4s 3c', 'Ac Ad Kh Ks Qc'],
    ['2c 2d 3h 3s 4c', 'Ac Ad Kh Qs Jc'],
    ['2c 2d 5h 4s 3c', 'Ac Kd Qh Js 9c'],
  ];
  for (const [better, worse] of pairs) assert.ok(e5(better) > e5(worse), `${better} > ${worse}`);
});

test('wheel straight is five high and loses to a six-high straight', () => {
  assert.equal(describe(e5('Ac 2d 3h 4s 5c')), 'Straight, Five high');
  assert.ok(e5('2c 3d 4h 5s 6c') > e5('Ac 2d 3h 4s 5c'));
  assert.equal(describe(e5('Ah 2h 3h 4h 5h')), 'Straight Flush, Five high');
  assert.ok(e5('2h 3h 4h 5h 6h') > e5('Ah 2h 3h 4h 5h'));
  assert.equal(describe(e5('Ts Js Qs Ks As')), 'Royal Flush');
});

test('ace does not wrap around', () => {
  assert.equal(describe(e5('Qc Kd Ah 2s 3c')), 'High Card, Ace');
});

test('wheel best5 is ordered five down to ace', () => {
  assert.deepEqual(e7('Ac 2d 3h 4s 5c Kd 9h').best5, h('5c 4s 3h 2d Ac'));
});

test('six- and seven-card flush picks the top five', () => {
  const six = e7('Ah 2h 9h Kh 4h 7h');
  assert.equal(six.name, 'Flush, Ace high');
  assert.deepEqual(six.best5, h('Ah Kh 9h 7h 4h'));
  const seven = e7('3s 2s Js 8s Qs 5s Ts');
  assert.deepEqual(seven.best5, h('Qs Js Ts 8s 5s'));
  assert.equal(seven.score, e5('Qs Js Ts 8s 5s'));
});

test('two sets of trips make the higher full house', () => {
  const r = e7('9c 9d 9h 4s 4c 4d Kh');
  assert.equal(r.name, 'Full House, Nines over Fours');
  assert.deepEqual(r.best5.map((c) => c[0]), h('9 9 9 4 4'));
});

test('three pairs use the best two plus the highest remaining kicker', () => {
  const r = e7('Kc Kd 7h 7s 5c 5d 2h');
  assert.equal(r.name, 'Two Pair, Kings and Sevens');
  assert.deepEqual(r.best5.map((c) => c[0]), h('K K 7 7 5'));
  assert.ok(e7('Kc Kd 7h 7s 5c 5d 6h').score > r.score);
  assert.equal(e7('Kc Kd 7h 7s 5c 5d 6h').best5[4][0], '6');
});

test('kickers decide within a category', () => {
  assert.ok(e5('Ac Ad Kh 7s 2c') > e5('Ac Ad Qh Js Tc'));
  assert.ok(e5('Ac Ad Kh 8s 2c') > e5('Ac Ad Kh 7s 6c'));
  assert.ok(e5('Ac Ad Kh 8s 3c') > e5('As Ah Kd 8c 2d'));
  assert.ok(e5('Ac Ad 8h 8s Kc') > e5('Ac Ad 8h 8s Qc'));
  assert.ok(e5('Kc Kd 3h 3s 2c') > e5('Qc Qd Jh Js Ac'));
  assert.ok(e5('7c 7d 7h As 2c') > e5('7c 7d 7h Ks Qc'));
  assert.ok(e5('7c 7d 7h 7s Ac') > e5('7c 7d 7h 7s Kc'));
  assert.ok(e5('3c 3d 3h 2s 2c') > e5('2c 2d 2h As Ac'));
  assert.ok(e5('Ah Kh Qh Jh 9h') > e5('Ah Kh Qh Jh 8h'));
  assert.ok(e5('Ac Kd Qh Js 9c') > e5('Ac Kd Qh Js 8c'));
});

test('board plays: two players tie', () => {
  const board = h('Ac Ad Ah As Kc');
  const p1 = evaluate7([...board, '2c', '3d']);
  const p2 = evaluate7([...board, '4h', '5s']);
  assert.equal(p1.score, p2.score);
  assert.equal(p1.name, 'Four of a Kind, Aces');

  const straightBoard = h('Tc Jd Qh Ks Ac');
  assert.equal(evaluate7([...straightBoard, '2c', '3d']).score, evaluate7([...straightBoard, '9h', '9s']).score);
});

test('suits never break ties', () => {
  assert.equal(e5('Ac Kd Qh Js 9c'), e5('As Kh Qd Jc 9s'));
  assert.equal(e5('Ah Kh Qh Jh 9h'), e5('As Ks Qs Js 9s'));
  assert.equal(e5('Jc Jd 9h 4s 2c'), e5('Jh Js 9c 4d 2s'));
  assert.equal(e5('9c 8d 7h 6s 5c'), e5('9d 8c 7s 6h 5d'));
});

test('describe covers every category', () => {
  assert.equal(describe(e5('5d 6d 7d 8d 9d')), 'Straight Flush, Nine high');
  assert.equal(describe(e5('Ac Ad Ah As Kc')), 'Four of a Kind, Aces');
  assert.equal(describe(e5('Kc Kd Kh Ts Tc')), 'Full House, Kings over Tens');
  assert.equal(describe(e5('6c 6d 6h 3s 3c')), 'Full House, Sixes over Threes');
  assert.equal(describe(e5('7c 7d 7h As 2c')), 'Three of a Kind, Sevens');
});

test('evaluate7 accepts 5, 6 and 7 cards and rejects other lengths', () => {
  assert.equal(e7('Ac Kd Qh Js 9c').score, e5('Ac Kd Qh Js 9c'));
  assert.throws(() => evaluate7(h('Ac Kd Qh Js')), RangeError);
  assert.throws(() => evaluate7(h('Ac Kd Qh Js 9c 8c 7c 6c')), RangeError);
});

test('shuffle returns a permutation without mutating its input', () => {
  const deck = makeDeck();
  const before = deck.slice();
  const out = shuffle(deck, cryptoRng);
  assert.deepEqual(deck, before);
  assert.notEqual(out, deck);
  assert.equal(out.length, 52);
  assert.deepEqual(out.slice().sort(), before.slice().sort());
});

test('shuffle is deterministic under seededRng', () => {
  const a = shuffle(makeDeck(), seededRng(42));
  const b = shuffle(makeDeck(), seededRng(42));
  const c = shuffle(makeDeck(), seededRng(43));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.notDeepEqual(a, makeDeck());
});

test('rngs return floats in [0, 1)', () => {
  const seeded = seededRng(7);
  for (let i = 0; i < 1000; i++) {
    for (const x of [seeded(), cryptoRng()]) assert.ok(x >= 0 && x < 1);
  }
});
