import { rankOf, suitOf } from '../../shared/cards.js';

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

const BASE = 15;
const SLOTS = 5;

function pack(category, tiebreaks) {
  let score = category;
  for (let i = 0; i < SLOTS; i++) score = score * BASE + (tiebreaks[i] ?? 0);
  return score;
}

function unpack(score) {
  const tiebreaks = new Array(SLOTS);
  for (let i = SLOTS - 1; i >= 0; i--) {
    tiebreaks[i] = score % BASE;
    score = Math.floor(score / BASE);
  }
  return { category: score, tiebreaks };
}

/** Returns the straight's high card, or 0. Expects 5 distinct ranks sorted descending. */
function straightHigh(ranks) {
  if (ranks[0] - ranks[4] === 4) return ranks[0];
  if (ranks[0] === 14 && ranks[1] === 5) return 5;
  return 0;
}

function analyse(cards) {
  if (cards.length !== 5) throw new RangeError(`evaluate5 needs 5 cards, got ${cards.length}`);

  const counts = new Map();
  for (const c of cards) counts.set(rankOf(c), (counts.get(rankOf(c)) ?? 0) + 1);
  const groups = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const high = groups.length === 5 ? straightHigh(groups.map((g) => g.rank)) : 0;
  const shape = groups.map((g) => g.count).join('');
  const groupRanks = groups.map((g) => g.rank);

  let category;
  let tiebreaks = groupRanks;
  if (high && flush) {
    category = CATEGORY.STRAIGHT_FLUSH;
    tiebreaks = [high];
  } else if (shape === '41') category = CATEGORY.QUADS;
  else if (shape === '32') category = CATEGORY.FULL_HOUSE;
  else if (flush) category = CATEGORY.FLUSH;
  else if (high) {
    category = CATEGORY.STRAIGHT;
    tiebreaks = [high];
  } else if (shape === '311') category = CATEGORY.TRIPS;
  else if (shape === '221') category = CATEGORY.TWO_PAIR;
  else if (shape === '2111') category = CATEGORY.PAIR;
  else category = CATEGORY.HIGH_CARD;

  return { score: pack(category, tiebreaks), groupRanks, wheel: high === 5 };
}

export function evaluate5(cards) {
  return analyse(cards).score;
}

function orderBest5(cards, { groupRanks, wheel }) {
  const position = (card) => {
    const r = rankOf(card);
    return wheel && r === 14 ? SLOTS : groupRanks.indexOf(r);
  };
  return cards.slice().sort((a, b) => position(a) - position(b) || rankOf(b) - rankOf(a));
}

export function evaluate7(cards) {
  const n = cards.length;
  if (n < 5 || n > 7) throw new RangeError(`evaluate7 needs 5-7 cards, got ${n}`);

  let best = null;
  let bestCards = null;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const hand = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const result = analyse(hand);
            if (!best || result.score > best.score) {
              best = result;
              bestCards = hand;
            }
          }

  return { score: best.score, best5: orderBest5(bestCards, best), name: describe(best.score) };
}

const RANK_NAMES = {
  2: ['Two', 'Twos'],
  3: ['Three', 'Threes'],
  4: ['Four', 'Fours'],
  5: ['Five', 'Fives'],
  6: ['Six', 'Sixes'],
  7: ['Seven', 'Sevens'],
  8: ['Eight', 'Eights'],
  9: ['Nine', 'Nines'],
  10: ['Ten', 'Tens'],
  11: ['Jack', 'Jacks'],
  12: ['Queen', 'Queens'],
  13: ['King', 'Kings'],
  14: ['Ace', 'Aces'],
};
const one = (r) => RANK_NAMES[r][0];
const many = (r) => RANK_NAMES[r][1];

export function describe(score) {
  const { category, tiebreaks: [t0, t1] } = unpack(score);
  switch (category) {
    case CATEGORY.STRAIGHT_FLUSH:
      return t0 === 14 ? 'Royal Flush' : `Straight Flush, ${one(t0)} high`;
    case CATEGORY.QUADS:
      return `Four of a Kind, ${many(t0)}`;
    case CATEGORY.FULL_HOUSE:
      return `Full House, ${many(t0)} over ${many(t1)}`;
    case CATEGORY.FLUSH:
      return `Flush, ${one(t0)} high`;
    case CATEGORY.STRAIGHT:
      return `Straight, ${one(t0)} high`;
    case CATEGORY.TRIPS:
      return `Three of a Kind, ${many(t0)}`;
    case CATEGORY.TWO_PAIR:
      return `Two Pair, ${many(t0)} and ${many(t1)}`;
    case CATEGORY.PAIR:
      return `Pair of ${many(t0)}`;
    case CATEGORY.HIGH_CARD:
      return `High Card, ${one(t0)}`;
    default:
      throw new RangeError(`Invalid score ${score}`);
  }
}
