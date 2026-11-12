import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRng } from '../server/engine/deck.js';
import { legalActions } from '../server/engine/game.js';
import { Room } from '../server/room.js';
import { viewFor, redactEvents } from '../server/view.js';

const CONFIG = { buyIn: 1000, smallBlind: 5, bigBlind: 10, turnSeconds: 30 };

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      pending.set(nextId, { at: now + ms, fn });
      return nextId++;
    },
    clearTimeout: (id) => pending.delete(id),
    pending: () => pending.size,
  };
}

function liveRoom(n = 3, seed = 7) {
  const room = new Room({ code: 'TEST', config: CONFIG, rng: seededRng(seed), timers: fakeTimers() });
  const players = [];
  for (let i = 0; i < n; i++) players.push(room.join(`P${i}`, { readyState: 1, send() {}, close() {} }));
  room.start(players[0].id);
  return { room, players };
}

const quoted = (card) => `"${card}"`;
const holeOf = (room, seat) => room.table.hand.players[seat].hole;

function act(room, type) {
  const hand = room.table.hand;
  const player = [...room.players.values()].find((p) => p.seat === hand.toAct);
  room.action(player.id, { type, handId: hand.id, turnId: hand.turnId });
}

const checkOrCall = (room) => act(room, legalActions(room.table, room.table.hand.toAct).check ? 'check' : 'call');

test('a live view holds only the viewer’s own hole cards and nothing from the deck', () => {
  const { room, players } = liveRoom(3);
  const hand = room.table.hand;
  assert.equal(hand.phase, 'preflop');
  for (const viewer of players) {
    const json = JSON.stringify(viewFor(room, viewer.id));
    for (const other of players) {
      for (const card of holeOf(room, other.seat)) {
        assert.equal(json.includes(quoted(card)), other === viewer, `${viewer.name} sees ${other.name}'s ${card}?`);
      }
    }
    for (const card of hand.deck) assert.ok(!json.includes(quoted(card)), `deck card ${card} leaked`);
    assert.ok(!json.includes('"deck"'));
    assert.ok(!json.includes('"hole"'));
    assert.ok(!json.includes(viewer.token), 'token never in the view');
  }
});

test('the view has the documented shape', () => {
  const { room, players } = liveRoom(3);
  const view = viewFor(room, players[1].id);
  assert.deepEqual(Object.keys(view).sort(), ['hand', 'room', 'seats', 'you']);
  assert.equal(view.room.code, 'TEST');
  assert.equal(view.room.status, 'playing');
  assert.equal(view.room.hostId, players[0].id);
  assert.deepEqual(view.room.config, CONFIG);
  assert.deepEqual(view.room.share, { lan: [], tunnel: null });
  assert.equal(view.seats.length, 6);
  assert.deepEqual(view.seats[0], {
    seat: 0,
    name: 'P0',
    stack: room.table.seats[0].stack,
    busted: false,
    connected: true,
    away: false,
    isHost: true,
  });
  assert.equal(view.seats[3], null);
  const h = view.hand;
  assert.equal(h.handId, 1);
  assert.equal(h.potTotal, 15);
  assert.equal(h.currentBet, 10);
  assert.equal(h.turnMs, 30_000);
  assert.ok(h.remainingMs > 30_000, 'deadline includes the deal animation budget');
  assert.deepEqual(Object.keys(h.players).sort(), ['0', '1', '2']);
  assert.deepEqual(Object.keys(h.players[0]).sort(), ['allIn', 'cards', 'folded', 'streetBet']);
  assert.equal(view.you.playerId, players[1].id);
  assert.equal(view.you.seat, 1);
  assert.equal(view.you.isHost, false);
});

test('share is read at view time', () => {
  const share = { lan: ['http://10.0.0.2:3000'], tunnel: null };
  const room = new Room({ code: 'SHAR', config: CONFIG, share, timers: fakeTimers() });
  const p = room.join('Host');
  share.tunnel = 'https://example.test';
  assert.deepEqual(viewFor(room, p.id).room.share, { lan: ['http://10.0.0.2:3000'], tunnel: 'https://example.test' });
});

test('you.legal is present only for the player to act', () => {
  const { room, players } = liveRoom(3);
  const toAct = room.table.hand.toAct;
  for (const p of players) {
    const legal = viewFor(room, p.id).you.legal;
    if (p.seat === toAct) assert.deepEqual(legal, { check: false, call: 10, raise: { min: 20, max: 1000 } });
    else assert.equal(legal, null);
  }
});

test('after showdown non-folded hands are visible to all, folded hands are not', () => {
  const { room, players } = liveRoom(3);
  const folder = room.table.hand.toAct;
  act(room, 'fold');
  while (room.table.hand.phase !== 'complete') checkOrCall(room);
  assert.equal(room.table.hand.revealed, true);
  for (const viewer of players) {
    const view = viewFor(room, viewer.id);
    const json = JSON.stringify(view);
    for (const p of players) {
      const shown = p.seat !== folder || viewer.seat === folder;
      assert.deepEqual(view.hand.players[p.seat].cards, shown ? holeOf(room, p.seat) : null);
      for (const card of holeOf(room, p.seat)) assert.equal(json.includes(quoted(card)), shown);
    }
    assert.equal(view.you.legal, null);
    assert.equal(view.hand.remainingMs, 0);
  }
});

test('an uncontested win reveals nothing', () => {
  const { room, players } = liveRoom(3);
  act(room, 'fold');
  act(room, 'fold');
  assert.equal(room.table.hand.phase, 'complete');
  for (const viewer of players) {
    const view = viewFor(room, viewer.id);
    for (const p of players) {
      assert.deepEqual(view.hand.players[p.seat].cards, p === viewer ? holeOf(room, p.seat) : null);
    }
  }
});

test('a spectator who was not dealt in sees no hole cards', () => {
  const { room, players } = liveRoom(3);
  const late = room.join('Late');
  const view = viewFor(room, late.id);
  const json = JSON.stringify(view);
  for (const p of players) for (const card of holeOf(room, p.seat)) assert.ok(!json.includes(quoted(card)));
  assert.equal(view.you.legal, null);
  assert.equal(view.hand.players[late.seat], undefined);
  assert.equal(view.seats[late.seat].name, 'Late');
});

test('a busted player sees no hole cards', () => {
  const { room, players } = liveRoom(3);
  room.table.seats[players[2].seat].busted = true;
  delete room.table.hand.players[players[2].seat];
  const json = JSON.stringify(viewFor(room, players[2].id));
  for (const p of players.slice(0, 2)) for (const card of holeOf(room, p.seat)) assert.ok(!json.includes(quoted(card)));
});

test('redactEvents keeps only the recipient’s seat in deal events', () => {
  const deal = { e: 'deal', order: [1, 2, 0], cards: { 0: ['As', 'Kd'], 1: ['2c', '3c'], 2: ['Th', 'Ts'] } };
  const events = [{ e: 'handStart', handId: 1, button: 0, sbSeat: 1, bbSeat: 2, seats: [0, 1, 2] }, deal];

  const forOne = redactEvents(events, 1);
  assert.deepEqual(forOne[1], { e: 'deal', order: [1, 2, 0], cards: { 1: ['2c', '3c'] } });
  assert.equal(forOne[0], events[0]);
  assert.deepEqual(redactEvents(events, 4)[1].cards, {});
  assert.deepEqual(redactEvents(events, null)[1].cards, {});
  assert.deepEqual(deal.cards[0], ['As', 'Kd'], 'input not mutated');

  const json = JSON.stringify(redactEvents(events, 0));
  for (const card of ['2c', '3c', 'Th', 'Ts']) assert.ok(!json.includes(quoted(card)));
});

test('redactEvents on a real hand start', () => {
  const room = new Room({ code: 'REDA', config: CONFIG, rng: seededRng(3), timers: fakeTimers() });
  const sockets = [];
  const ps = [];
  for (let i = 0; i < 3; i++) {
    const socket = { readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} };
    sockets.push(socket);
    ps.push(room.join(`P${i}`, socket));
  }
  room.start(ps[0].id);
  ps.forEach((p, i) => {
    const update = sockets[i].sent.at(-1);
    const deal = update.events.find((ev) => ev.e === 'deal');
    assert.deepEqual(Object.keys(deal.cards), [String(p.seat)]);
    assert.deepEqual(deal.cards[p.seat], holeOf(room, p.seat));
  });
});
