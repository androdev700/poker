// Nominal animation durations. The client paces animations with these and the server adds the same
// budget to turn clocks and the gap between hands, so animation time never eats a player's clock.

export const DEAL_CARD_MS = 140;
export const NEXT_HAND_PAUSE_MS = 2500;

const FIXED_MS = {
  handStart: 500,
  blind: 250,
  turn: 0,
  action: 350,
  refund: 300,
  collect: 500,
  reveal: 900,
  showdown: 1800,
  win: 1600,
  bust: 600,
  handEnd: 0,
};

export function eventMs(ev) {
  if (ev.e === 'deal') return ev.order.length * 2 * DEAL_CARD_MS + 300;
  if (ev.e === 'board') return ev.cards.length * 220 + 500;
  return FIXED_MS[ev.e] ?? 0;
}

export function animBudget(events) {
  let total = 0;
  for (const ev of events) total += eventMs(ev);
  return total;
}
