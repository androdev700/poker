// A card is a two-character string: rank + suit, e.g. "As", "Td", "2c".
export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** @returns {number} 2..14 */
export function rankOf(card) {
  return RANKS.indexOf(card[0]) + 2;
}

export function suitOf(card) {
  return card[1];
}
