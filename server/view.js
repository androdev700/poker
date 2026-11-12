import { legalActions } from './engine/game.js';

const sum = (xs, f) => xs.reduce((total, x) => total + f(x), 0);

function seatView(room, seatState, seat) {
  const player = room.players.get(seatState.id);
  return {
    seat,
    name: seatState.name,
    stack: seatState.stack,
    busted: seatState.busted,
    connected: Boolean(player?.connected),
    away: Boolean(player?.away),
    isHost: seatState.id === room.hostId,
  };
}

function handView(room, hand, viewerSeat) {
  const { table } = room;
  const live = hand.phase !== 'complete';
  const players = {};
  for (const [key, p] of Object.entries(hand.players)) {
    const seat = Number(key);
    const visible = seat === viewerSeat || (hand.revealed && !p.folded);
    players[seat] = {
      folded: p.folded,
      allIn: !p.folded && table.seats[seat].stack === 0,
      streetBet: p.streetBet,
      cards: visible ? [p.hole[0], p.hole[1]] : null,
    };
  }
  const timed = live && hand.toAct !== null && room.turnDeadline !== null;
  return {
    handId: hand.id,
    phase: hand.phase,
    button: table.button,
    sbSeat: hand.sbSeat,
    bbSeat: hand.bbSeat,
    board: [...hand.board],
    pots: hand.pots.map((pot) => ({ amount: pot.amount })),
    potTotal: sum(hand.pots, (pot) => pot.amount) + sum(Object.values(hand.players), (p) => p.streetBet),
    currentBet: hand.currentBet,
    toAct: hand.toAct,
    turnId: hand.turnId,
    remainingMs: timed ? Math.max(0, room.turnDeadline - room.now()) : 0,
    turnMs: timed ? room.turnMs : 0,
    players,
  };
}

function legalView(table, seat) {
  const legal = seat === null ? null : legalActions(table, seat);
  if (!legal) return null;
  return {
    check: legal.check,
    call: legal.call,
    raise: legal.raise ? { min: legal.raise.min, max: legal.raise.max } : null,
  };
}

/** @returns {import('../shared/protocol.js').View} */
export function viewFor(room, playerId) {
  const { table, config, share } = room;
  const me = room.players.get(playerId);
  const mySeat = me ? me.seat : null;
  return {
    room: {
      code: room.code,
      status: room.status,
      hostId: room.hostId,
      config: {
        buyIn: config.buyIn,
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
        turnSeconds: config.turnSeconds,
      },
      share: { lan: [...(share?.lan ?? [])], tunnel: share?.tunnel ?? null },
    },
    seats: table.seats.map((s, i) => (s ? seatView(room, s, i) : null)),
    hand: table.hand ? handView(room, table.hand, mySeat) : null,
    you: {
      playerId,
      seat: mySeat ?? -1,
      isHost: playerId === room.hostId,
      legal: legalView(table, mySeat),
    },
  };
}

/** The `deal` event keeps only `seat`'s own cards; every other event is public. */
export function redactEvents(events, seat) {
  return events.map((ev) => {
    if (ev.e !== 'deal') return ev;
    const cards = {};
    if (seat !== null && seat !== undefined && Object.hasOwn(ev.cards, seat)) cards[seat] = [...ev.cards[seat]];
    return { e: ev.e, order: [...ev.order], cards };
  });
}
