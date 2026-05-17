import type { Card, Rank, Suit } from "./types.js";

export const SUITS: Suit[] = ["hearts", "diamonds", "clubs", "spades"];

export const RANKS: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export const POWER_RANKS = new Set<Rank>(["10", "J", "Q", "K", "JOKER"]);

export function getCardValue(rank: Rank): number {
  switch (rank) {
    case "A":
      return 1;
    case "2":
      return 2;
    case "3":
      return 3;
    case "4":
      return 4;
    case "5":
      return 5;
    case "6":
      return 6;
    case "7":
      return 0;
    case "8":
      return 8;
    case "9":
      return 9;
    case "10":
      return 10;
    case "J":
      return 11;
    case "Q":
      return 12;
    case "K":
      return 13;
    case "JOKER":
      return 20;
  }
}

export function isPowerCard(rank: Rank): boolean {
  return POWER_RANKS.has(rank);
}

let cardIdCounter = 0;

export function createDeck(): Card[] {
  cardIdCounter = 0;
  const cards: Card[] = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({
        id: `card-${cardIdCounter++}`,
        suit,
        rank,
        value: getCardValue(rank),
      });
    }
  }

  // 2 Jokers
  for (let i = 0; i < 2; i++) {
    cards.push({
      id: `card-${cardIdCounter++}`,
      rank: "JOKER",
      value: getCardValue("JOKER"),
    });
  }

  return cards;
}
