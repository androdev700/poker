import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ERR, WS_CLOSE_REPLACED } from '../shared/protocol.js';
import { animBudget, NEXT_HAND_PAUSE_MS } from '../shared/timing.js';
import { seededRng } from '../server/engine/deck.js';
import { legalActions, totalChips } from '../server/engine/game.js';
import { AWAY_ACT_MS, EMPTY_ROOM_MS, Room } from '../server/room.js';
import { RoomManager } from '../server/rooms.js';
import { startServer } from '../server/index.js';

const CONFIG = { buyIn: 1000, smallBlind: 5, bigBlind: 10, turnSeconds: 15 };
const TURN_MS = CONFIG.turnSeconds * 1000;

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
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of pending) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    closedWith: null,
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close(code) {
      this.closedWith = code ?? 1005;
      this.readyState = 3;
    },
    last(t = 'update') {
      return this.sent.filter((m) => m.t === t).at(-1);
    },
  };
}

function setup(n, { config = CONFIG, seed = 1, pace = true, autoDeal = true } = {}) {
  const timers = fakeTimers();
  const manager = new RoomManager({ roomOptions: { timers, rng: seededRng(seed), pace, autoDeal } });
  const sockets = [fakeSocket()];
  const { room, player: host } = manager.create('Host', config, sockets[0]);
  const players = [host];
  for (let i = 1; i < n; i++) {
    sockets.push(fakeSocket());
    players.push(room.join(`P${i}`, sockets[i]));
  }
  return { timers, manager, room, players, sockets };
}

const playerAt = (room, seat) => [...room.players.values()].find((p) => p.seat === seat);
const toActPlayer = (room) => playerAt(room, room.table.hand.toAct);
const turnOf = (room) => ({ handId: room.table.hand.id, turnId: room.table.hand.turnId });
const act = (room, type, amount) => room.action(toActPlayer(room).id, { t: 'action', type, amount, ...turnOf(room) });
const checkOrCall = (room) => act(room, legalActions(room.table, room.table.hand.toAct).check ? 'check' : 'call');
const lastAction = (socket) => socket.last().events.find((ev) => ev.e === 'action');

function assertConserved(room) {
  assert.equal(totalChips(room.table), room.config.buyIn * room.table.seatsEverFilled, 'chip conservation');
}

function assertRoomError(fn, code) {
  assert.throws(fn, (err) => err.code === code);
}

test('create, join and start send welcome then updates with the documented shapes', () => {
  const { room, players, sockets } = setup(2);
  const [hostSock, p1Sock] = sockets;
  const welcome = hostSock.sent[0];
  assert.deepEqual(welcome, { t: 'welcome', playerId: players[0].id, token: players[0].token, code: room.code, seat: 0 });
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{4}$/);
  assert.match(players[0].token, /^[0-9a-f]{32}$/);
  assert.equal(hostSock.sent[1].t, 'update');
  assert.deepEqual(hostSock.sent[1].events, []);
  assert.equal(hostSock.sent[1].state.room.status, 'lobby');
  assert.equal(p1Sock.sent[0].t, 'welcome');
  assert.equal(p1Sock.sent[0].seat, 1);

  const hostJoinUpdate = hostSock.last();
  assert.equal(hostJoinUpdate.state.seats[1].name, 'P1');
  assert.equal(hostJoinUpdate.seq, p1Sock.last().seq);

  room.start(players[0].id);
  const u = hostSock.last();
  assert.equal(u.seq, hostJoinUpdate.seq + 1);
  assert.deepEqual(
    u.events.map((ev) => ev.e),
    ['handStart', 'blind', 'blind', 'deal', 'turn'],
  );
  assert.equal(u.state.room.status, 'playing');
  assert.equal(u.state.hand.handId, 1);
  assert.equal(u.state.hand.turnMs, TURN_MS);
  assert.equal(u.state.hand.remainingMs, animBudget(u.events) + TURN_MS);
  assertConserved(room);
});

test('non-host cannot start or close; start needs two players', () => {
  const { room, players } = setup(1);
  assertRoomError(() => room.start(players[0].id), ERR.CANNOT_START);
  const p1 = room.join('Bob', fakeSocket());
  assertRoomError(() => room.start(p1.id), ERR.NOT_HOST);
  assertRoomError(() => room.close(p1.id), ERR.NOT_HOST);
  room.start(players[0].id);
  assertRoomError(() => room.start(players[0].id), ERR.CANNOT_START);
});

test('timeout folds when facing a bet and checks when checking is legal', () => {
  const { room, timers, sockets } = setup(2);
  room.start(room.hostId);
  const sb = toActPlayer(room);
  const u = sockets[0].last();
  const budget = animBudget(u.events);

  timers.advance(budget + TURN_MS - 1);
  assert.equal(room.table.hand.toAct, sb.seat, 'not yet');
  timers.advance(1);
  assert.deepEqual(lastAction(sockets[0]), { e: 'action', seat: sb.seat, kind: 'fold', added: 0, to: 5, allIn: false });
  assert.equal(room.table.hand.phase, 'complete');
  assert.equal(sb.away, false, 'connected players are not marked away');
  assert.equal(room.status, 'playing');

  timers.advance(animBudget(sockets[0].last().events) + NEXT_HAND_PAUSE_MS);
  assert.equal(room.table.hand.id, 2);
  checkOrCall(room);
  const bb = toActPlayer(room);
  assert.equal(legalActions(room.table, bb.seat).check, true);
  timers.advance(animBudget(sockets[0].last().events) + TURN_MS);
  assert.deepEqual(lastAction(sockets[0]), { e: 'action', seat: bb.seat, kind: 'check', added: 0, to: 10, allIn: false });
  assert.equal(room.table.hand.phase, 'flop');
  assertConserved(room);
});

test('stale handId/turnId and duplicate actions are rejected', () => {
  const { room } = setup(3);
  room.start(room.hostId);
  const actor = toActPlayer(room);
  const { handId, turnId } = turnOf(room);
  assertRoomError(() => room.action(actor.id, { type: 'call', handId: handId + 1, turnId }), ERR.STALE_ACTION);
  assertRoomError(() => room.action(actor.id, { type: 'call', handId, turnId: turnId - 1 }), ERR.STALE_ACTION);
  const other = [...room.players.values()].find((p) => p !== actor);
  assertRoomError(() => room.action(other.id, { type: 'call', handId, turnId }), ERR.ILLEGAL_ACTION);
  assertRoomError(() => room.action(actor.id, { type: 'check', handId, turnId }), ERR.ILLEGAL_ACTION);
  assertRoomError(() => room.action(actor.id, { type: 'raiseTo', amount: 15, handId, turnId }), ERR.ILLEGAL_ACTION);
  assertRoomError(() => room.action(actor.id, { type: 'raiseTo', amount: '40', handId, turnId }), ERR.BAD_MESSAGE);
  assertRoomError(() => room.action(actor.id, { type: 'raiseTo', amount: 40.5, handId, turnId }), ERR.BAD_MESSAGE);
  assertRoomError(() => room.action(actor.id, { type: 'allin', handId, turnId }), ERR.BAD_MESSAGE);
  assertRoomError(() => room.action(actor.id, { type: 'call', handId: '1', turnId }), ERR.BAD_MESSAGE);

  room.action(actor.id, { type: 'call', handId, turnId });
  assertRoomError(() => room.action(actor.id, { type: 'call', handId, turnId }), ERR.STALE_ACTION);
  assertConserved(room);
});

test('resume swaps the socket, closes the old one with WS_CLOSE_REPLACED and sends a snapshot', () => {
  const { room, players, sockets, manager } = setup(2);
  const fresh = fakeSocket();
  const seqBefore = sockets[0].last().seq;
  assert.equal(manager.get(room.code.toLowerCase()), room);
  room.resume(players[1].token, fresh);
  assert.equal(sockets[1].closedWith, WS_CLOSE_REPLACED);
  assert.equal(players[1].socket, fresh);
  assert.deepEqual(fresh.sent[0], { t: 'welcome', playerId: players[1].id, token: players[1].token, code: room.code, seat: 1 });
  assert.deepEqual(fresh.sent[1].events, []);
  assert.equal(fresh.sent[1].seq, seqBefore + 1);

  room.disconnect(players[1].id, sockets[1]);
  assert.equal(players[1].connected, true, 'the replaced socket closing does not disconnect the seat');
  assert.equal(room.isBound(players[1].id, sockets[1]), false);
  assertRoomError(() => room.resume('nope', fakeSocket()), ERR.BAD_TOKEN);
});

test('a disconnected player times out, goes away and sits out until they reconnect', () => {
  const { room, timers, players, sockets } = setup(2);
  room.start(room.hostId);
  const sb = toActPlayer(room);
  const sbSock = sockets[players.indexOf(sb)];
  const otherSock = sockets[1 - players.indexOf(sb)];
  sbSock.readyState = 3;
  room.disconnect(sb.id, sbSock);
  assert.equal(sb.connected, false);
  assert.equal(otherSock.last().state.seats[sb.seat].connected, false);
  assert.deepEqual(otherSock.last().events, []);

  timers.advance(animBudget(sockets[0].sent.find((m) => m.events?.length).events) + TURN_MS);
  assert.equal(sb.away, true);
  assert.equal(otherSock.last().state.seats[sb.seat].away, true);
  assert.equal(lastAction(otherSock).kind, 'fold');

  timers.advance(60_000);
  assert.equal(room.table.hand.id, 1, 'no hand is dealt with one player present');
  assert.equal(room.status, 'lobby');
  assertRoomError(() => room.start(room.hostId), ERR.CANNOT_START);

  const back = fakeSocket();
  room.resume(sb.token, back);
  assert.equal(sb.away, false);
  timers.advance(NEXT_HAND_PAUSE_MS);
  assert.equal(room.table.hand.id, 2);
  assert.ok(room.table.hand.players[sb.seat]);
  assertConserved(room);
});

test('an offline player is left out of the next hand while the others play on', () => {
  const { room, players, sockets } = setup(3, { autoDeal: false });
  room.start(room.hostId);
  while (room.table.hand.phase !== 'complete') act(room, 'fold');
  room.disconnect(players[2].id, sockets[2]);
  room.start(room.hostId);
  assert.deepEqual(Object.keys(room.table.hand.players).map(Number).sort(), [players[0].seat, players[1].seat].sort());
  while (room.table.hand.phase !== 'complete') act(room, 'fold');

  room.resume(players[2].token, fakeSocket());
  room.start(room.hostId);
  assert.equal(Object.keys(room.table.hand.players).length, 3);
  assertConserved(room);
});

test('leaving before the first hand frees the seat and passes the host on', () => {
  const { room, players, sockets } = setup(3);
  room.leave(players[1].id);
  assert.equal(room.table.seats[players[1].seat], null);
  assert.equal(room.players.size, 2);
  assert.equal(totalChips(room.table), 2000);
  assert.equal(sockets[0].last().state.seats.filter(Boolean).length, 2);
  assert.throws(() => room.resume(players[1].token, fakeSocket()), { code: ERR.BAD_TOKEN });

  room.leave(players[0].id);
  assert.equal(room.hostId, players[2].id);
  room.join('Late', fakeSocket());
  room.start(players[2].id);
  assert.equal(room.table.hand.id, 1);
});

test('leaving after play has started keeps the chips and auto-acts for the seat', () => {
  const { room, timers, sockets } = setup(2);
  room.start(room.hostId);
  const leaver = toActPlayer(room);
  room.leave(leaver.id);
  assert.equal(leaver.away, true);
  assert.equal(room.players.size, 2);
  timers.advance(AWAY_ACT_MS);
  assert.equal(room.table.hand.phase, 'complete');
  assert.equal(totalChips(room.table), 2000);
  assert.ok(sockets.some((s) => s.last()));
});

test('a connected player goes away after two missed turns and comes back with back()', () => {
  const { room, timers, sockets } = setup(2);
  room.start(room.hostId);
  const idle = toActPlayer(room);
  const other = [...room.players.values()].find((p) => p !== idle);
  const runIdleTurn = () => {
    for (let guard = 0; guard < 20 && !idle.away; guard++) {
      if (room.table.hand.phase === 'complete') {
        timers.advance(animBudget(sockets[0].last().events) + NEXT_HAND_PAUSE_MS);
      } else if (toActPlayer(room) === idle) {
        const before = idle.missed;
        timers.advance(animBudget(sockets[0].last().events) + TURN_MS);
        if (idle.missed > before) return;
      } else {
        checkOrCall(room);
      }
    }
  };
  runIdleTurn();
  assert.equal(idle.away, false, 'one missed turn is forgiven');
  runIdleTurn();
  assert.equal(idle.away, true);
  assert.equal(idle.connected, true);

  room.back(idle.id);
  assert.equal(idle.away, false);
  assert.equal(idle.missed, 0);
  assert.equal(other.away, false);
});

test('without autoDeal the finished hand stays up until the host deals the next', () => {
  const { room, timers, sockets, players } = setup(3, { autoDeal: false });
  room.start(room.hostId);
  while (room.table.hand.phase !== 'complete') act(room, 'fold');
  timers.advance(60_000);
  assert.equal(room.table.hand.id, 1);
  assert.equal(room.status, 'lobby');
  assert.equal(sockets[0].last().state.hand.phase, 'complete');
  assert.equal(timers.pending(), 0);

  assertRoomError(() => room.start(players[2].id), ERR.NOT_HOST);
  room.start(room.hostId);
  assert.equal(room.table.hand.id, 2);
});

test('next hand starts automatically after the animation budget plus the pause', () => {
  const { room, timers, sockets } = setup(3);
  room.start(room.hostId);
  act(room, 'fold');
  act(room, 'fold');
  assert.equal(room.table.hand.phase, 'complete');
  assert.equal(room.status, 'playing');
  const wait = animBudget(sockets[0].last().events) + NEXT_HAND_PAUSE_MS;
  assert.equal(timers.pending(), 1, 'only the next-hand timer is pending');
  timers.advance(wait - 1);
  assert.equal(room.table.hand.id, 1);
  timers.advance(1);
  assert.equal(room.table.hand.id, 2);
  assert.equal(timers.pending(), 1, 'only the turn timer is pending');
  assertConserved(room);
});

test('the room drops to lobby when only one player has chips, and the host can restart with a new player', () => {
  const { room, timers, sockets, players } = setup(2, { config: { ...CONFIG, buyIn: 100 }, seed: 5 });
  room.start(room.hostId);
  let hands = 0;
  while (room.status === 'playing') {
    while (room.table.hand.phase !== 'complete') {
      const legal = legalActions(room.table, room.table.hand.toAct);
      if (legal.raise) act(room, 'raiseTo', legal.raise.max);
      else checkOrCall(room);
      assertConserved(room);
    }
    timers.advance(60_000);
    hands++;
    assert.ok(hands < 100, 'someone busts eventually');
  }
  assert.equal(room.status, 'lobby');
  assert.equal(timers.pending(), 0);
  const state = sockets[0].last().state;
  assert.equal(state.room.status, 'lobby');
  assert.equal(state.seats.filter((s) => s && s.busted).length, 1);
  assertRoomError(() => room.start(room.hostId), ERR.CANNOT_START);
  const scoreboardWins = players.reduce((n, p) => n + p.handsWon, 0);
  assert.ok(scoreboardWins >= hands);

  room.join('Carol', fakeSocket());
  room.start(room.hostId);
  assert.equal(room.status, 'playing');
  assert.equal(Object.keys(room.table.hand.players).length, 2, 'the busted player is not dealt in');
  assertConserved(room);
});

test('a late joiner sits out the current hand and is dealt into the next', () => {
  const { room, timers, sockets } = setup(2);
  room.start(room.hostId);
  const late = room.join('Late', fakeSocket());
  assert.equal(late.seat, 2);
  assert.equal(room.table.hand.players[late.seat], undefined);
  assert.equal(late.socket.last().state.hand.players[late.seat], undefined);
  assert.deepEqual(late.socket.last().events, []);
  assertConserved(room);
  act(room, 'fold');
  timers.advance(animBudget(sockets[0].last().events) + NEXT_HAND_PAUSE_MS);
  assert.ok(room.table.hand.players[late.seat]);
  assertConserved(room);
});

test('close mid-hand returns bets, conserves chips and broadcasts the scoreboard; no timers remain', () => {
  const { room, timers, players, sockets } = setup(3);
  room.start(room.hostId);
  act(room, 'raiseTo', 40);
  act(room, 'call');
  assert.ok(timers.pending() > 0);
  room.close(room.hostId);
  assert.equal(room.status, 'closed');
  assert.equal(timers.pending(), 0);
  assertConserved(room);
  for (const s of room.table.seats.filter(Boolean)) assert.equal(s.stack, 1000);

  for (const sock of sockets) {
    const closed = sock.sent.at(-1);
    assert.equal(closed.t, 'closed');
    assert.equal(closed.scoreboard.length, 3);
    assert.equal(
      closed.scoreboard.reduce((sum, r) => sum + r.stack, 0),
      CONFIG.buyIn * players.length,
    );
    assert.deepEqual(Object.keys(closed.scoreboard[0]).sort(), ['handsWon', 'name', 'net', 'stack']);
    assert.equal(sock.closedWith, 1000);
  }
  assertRoomError(() => room.join('Again', fakeSocket()), ERR.ROOM_CLOSED);
  assertRoomError(() => room.action(players[0].id, { type: 'fold', handId: 1, turnId: 1 }), ERR.ROOM_CLOSED);
  assertRoomError(() => room.close(room.hostId), ERR.ROOM_CLOSED);
});

test('scoreboard is sorted by stack with net and handsWon', () => {
  const { room, timers, sockets } = setup(3);
  room.start(room.hostId);
  act(room, 'fold');
  act(room, 'fold');
  const winner = playerAt(room, sockets[0].last().events.find((ev) => ev.e === 'win').winners[0].seat);
  timers.advance(10_000);
  room.close(room.hostId);
  const board = sockets[0].sent.at(-1).scoreboard;
  assert.deepEqual(board[0], { name: winner.name, stack: 1005, net: 5, handsWon: 1 });
  assert.deepEqual(board.map((r) => r.stack), [...board.map((r) => r.stack)].sort((a, b) => b - a));
  assert.equal(board.reduce((s, r) => s + r.net, 0), 0);
});

test('full room is rejected and names are trimmed, capped and de-duplicated', () => {
  const { room, manager } = setup(1);
  assert.equal(room.join('  Host  ').name, 'Host 2');
  assert.equal(room.join('host').name, 'host 3');
  assert.equal(room.join('ABCDEFGHIJKLMNOPQRSTUVWXYZ').name, 'ABCDEFGHIJKLMNOP');
  assert.equal(room.join('ABCDEFGHIJKLMNOPQ').name, 'ABCDEFGHIJKLMN 2');
  assertRoomError(() => room.join('   '), ERR.BAD_NAME);
  assertRoomError(() => room.join(42), ERR.BAD_NAME);
  room.join('Sixth');
  assertRoomError(() => room.join('Seventh'), ERR.ROOM_FULL);

  assertRoomError(() => manager.create('', CONFIG), ERR.BAD_NAME);
  assertRoomError(() => manager.create('X', { ...CONFIG, turnSeconds: 7 }), ERR.BAD_CONFIG);
  assertRoomError(() => manager.create('X', { ...CONFIG, buyIn: 50 }), ERR.BAD_CONFIG);
  assert.equal(manager.get('zzzz'), undefined);
});

test('disconnecting every socket closes the room after 30 minutes', () => {
  const { room, timers, manager, players, sockets } = setup(2);
  room.start(room.hostId);
  players.forEach((p, i) => room.disconnect(p.id, sockets[i]));
  timers.advance(EMPTY_ROOM_MS - 1);
  assert.equal(room.closed, false);
  assertConserved(room);
  timers.advance(1);
  assert.equal(room.closed, true);
  assert.equal(manager.get(room.code), undefined);
  assert.equal(timers.pending(), 0);
  assertConserved(room);
});

test('pace:false runs hands with no animation delay', () => {
  const { room, timers, sockets } = setup(2, { pace: false });
  room.start(room.hostId);
  assert.equal(sockets[0].last().state.hand.turnMs, TURN_MS);
  act(room, 'fold');
  timers.advance(0);
  assert.equal(room.table.hand.id, 2);
});

function client(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    inbox,
    opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(pred, ms = 3000) {
      const found = inbox.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
  };
}

test('real sockets: create, join, start, play a hand, then shut down cleanly', async () => {
  const server = await startServer({ port: 0, quiet: true, roomOptions: { pace: false, autoDeal: true } });
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const a = client(url);
  const b = client(url);
  await Promise.all([a.opened, b.opened]);

  a.send({ t: 'nope' });
  assert.equal((await a.waitFor((m) => m.t === 'error')).code, ERR.BAD_MESSAGE);
  a.ws.send('{not json');
  a.send({ t: 'start' });
  await a.waitFor((m) => m.t === 'error' && m.message === 'Join a table first');
  b.send({ t: 'join', code: 'ZZZZ', name: 'Bob' });
  assert.equal((await b.waitFor((m) => m.t === 'error')).code, ERR.NO_ROOM);

  a.send({ t: 'create', name: 'Alice', config: CONFIG });
  const welcomeA = await a.waitFor((m) => m.t === 'welcome');
  b.send({ t: 'join', code: welcomeA.code.toLowerCase(), name: 'Bob' });
  const welcomeB = await b.waitFor((m) => m.t === 'welcome');
  assert.equal(welcomeB.seat, 1);
  await a.waitFor((m) => m.t === 'update' && m.state.seats[1]?.name === 'Bob');

  b.send({ t: 'start' });
  assert.equal((await b.waitFor((m) => m.t === 'error' && m.code === ERR.NOT_HOST)).code, ERR.NOT_HOST);
  a.send({ t: 'start' });

  const done = Promise.all([a, b].map((c) => c.waitFor((m) => m.t === 'update' && m.events.some((e) => e.e === 'handEnd'))));
  for (const c of [a, b]) {
    c.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t !== 'update' || !msg.state.you.legal || msg.state.hand.handId !== 1) return;
      const { handId, turnId } = msg.state.hand;
      c.send({ t: 'action', type: msg.state.you.legal.check ? 'check' : 'call', handId, turnId });
    });
  }
  const [endA] = await done;
  const handEnd = endA.events.find((e) => e.e === 'handEnd');
  assert.equal(handEnd.stacks[0] + handEnd.stacks[1], 2000);

  for (const c of [a, b]) {
    for (const m of c.inbox) {
      if (m.t !== 'update') continue;
      const deal = m.events.find((e) => e.e === 'deal');
      if (deal) assert.equal(Object.keys(deal.cards).length, 1);
    }
  }

  const closedA = a.waitFor((m) => m.t === 'closed');
  const sockClosed = Promise.all([a, b].map((c) => new Promise((r) => c.ws.once('close', r))));
  await server.close();
  const { scoreboard } = await closedA;
  assert.equal(scoreboard.reduce((s, r) => s + r.stack, 0), 2000);
  await sockClosed;
});

test('real sockets: rate limit, one binding per socket, resume replaces the old tab', async () => {
  const server = await startServer({ port: 0, quiet: true, roomOptions: { pace: false, autoDeal: true } });
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const a = client(url);
  const spam = client(url);
  await Promise.all([a.opened, spam.opened]);

  for (let i = 0; i < 40; i++) spam.send({ t: 'bogus' });
  await spam.waitFor((m) => m.code === ERR.RATE_LIMIT);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(spam.inbox.filter((m) => m.code === ERR.RATE_LIMIT).length, 1);
  assert.equal(spam.inbox.filter((m) => m.code === ERR.BAD_MESSAGE).length, 30);

  a.send({ t: 'create', name: 'Alice', config: CONFIG });
  const welcome = await a.waitFor((m) => m.t === 'welcome');
  a.send({ t: 'join', code: welcome.code, name: 'Again' });
  assert.equal((await a.waitFor((m) => m.t === 'error')).code, ERR.BAD_MESSAGE);

  const tab2 = client(url);
  await tab2.opened;
  const replaced = new Promise((r) => a.ws.once('close', (code) => r(code)));
  tab2.send({ t: 'resume', code: welcome.code, token: 'f'.repeat(32) });
  assert.equal((await tab2.waitFor((m) => m.t === 'error')).code, ERR.BAD_TOKEN);
  tab2.send({ t: 'resume', code: welcome.code, token: welcome.token });
  assert.equal((await tab2.waitFor((m) => m.t === 'welcome')).playerId, welcome.playerId);
  await tab2.waitFor((m) => m.t === 'update' && m.state.you.playerId === welcome.playerId);
  assert.equal(await replaced, WS_CLOSE_REPLACED);

  await server.close();
});
