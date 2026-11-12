export function uncalledRefund(players) {
  if (players.length < 2) return null;
  const sorted = [...players].sort((a, b) => b.streetBet - a.streetBet);
  const [top, second] = sorted;
  const amount = top.streetBet - second.streetBet;
  if (amount <= 0 || top.folded) return null;
  return { seat: top.seat, amount };
}

export function buildPots(players) {
  const total = players.reduce((sum, p) => sum + p.committed, 0);
  const live = players.filter((p) => !p.folded);
  if (live.length === 0) return total > 0 ? [{ amount: total, eligible: [] }] : [];

  const levels = [...new Set(live.map((p) => p.committed))].sort((a, b) => a - b);
  const raw = [];
  let prev = 0;
  for (const level of levels) {
    const amount = players.reduce(
      (sum, p) => sum + Math.min(p.committed, level) - Math.min(p.committed, prev),
      0,
    );
    const eligible = live
      .filter((p) => p.committed >= level)
      .map((p) => p.seat)
      .sort((a, b) => a - b);
    raw.push({ amount, eligible });
    prev = level;
  }

  const assigned = raw.reduce((sum, p) => sum + p.amount, 0);
  raw[raw.length - 1].amount += total - assigned;

  const merged = [];
  for (const pot of raw) {
    const last = merged[merged.length - 1];
    if (last && sameSeats(last.eligible, pot.eligible)) last.amount += pot.amount;
    else merged.push({ amount: pot.amount, eligible: pot.eligible });
  }
  return merged.filter((p) => p.amount > 0);
}

function sameSeats(a, b) {
  return a.length === b.length && a.every((seat, i) => seat === b[i]);
}

export function distribute(amount, winners, button, maxSeats) {
  if (winners.length === 0) return [];
  const distance = (seat) => (seat - button - 1 + maxSeats) % maxSeats;
  const ordered = [...winners].sort((a, b) => distance(a) - distance(b));
  const share = Math.floor(amount / ordered.length);
  const remainder = amount % ordered.length;
  return ordered.map((seat, i) => ({ seat, amount: share + (i < remainder ? 1 : 0) }));
}
