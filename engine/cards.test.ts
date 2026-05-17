import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeck, getCardValue, isPowerCard, SUITS, RANKS } from "./cards.js";
import type { Rank } from "./types.js";

// ───────────────────────────────  getCardValue  ───────────────────────────────

describe("cards — getCardValue", () => {
  // Spec table: A=1, 2-6=face, 7=0, 8-10=face, J=11, Q=12, K=13, Joker=20
  const expected: [Rank, number][] = [
    ["A", 1],
    ["2", 2],
    ["3", 3],
    ["4", 4],
    ["5", 5],
    ["6", 6],
    ["7", 0],
    ["8", 8],
    ["9", 9],
    ["10", 10],
    ["J", 11],
    ["Q", 12],
    ["K", 13],
    ["JOKER", 20],
  ];

  for (const [rank, value] of expected) {
    it(`${rank} → ${value}`, () => {
      assert.equal(getCardValue(rank), value);
    });
  }
});

// ───────────────────────────────  isPowerCard  ───────────────────────────────

describe("cards — isPowerCard", () => {
  const powerRanks: Rank[] = ["10", "J", "Q", "K", "JOKER"];
  const nonPowerRanks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9"];

  for (const rank of powerRanks) {
    it(`${rank} is a power card`, () => {
      assert.equal(isPowerCard(rank), true);
    });
  }
  for (const rank of nonPowerRanks) {
    it(`${rank} is not a power card`, () => {
      assert.equal(isPowerCard(rank), false);
    });
  }
});

// ───────────────────────────────  createDeck  ───────────────────────────────

describe("cards — createDeck", () => {
  it("returns exactly 54 cards (52 standard + 2 Jokers)", () => {
    const deck = createDeck();
    assert.equal(deck.length, 54);
  });

  it("contains 4 of each of A, 2–K (13 ranks × 4 suits = 52)", () => {
    const deck = createDeck();
    const standardRanks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    for (const rank of standardRanks) {
      const count = deck.filter((c) => c.rank === rank).length;
      assert.equal(count, 4, `expected 4 cards of rank ${rank}, got ${count}`);
    }
  });

  it("contains exactly 2 Jokers", () => {
    const deck = createDeck();
    const jokers = deck.filter((c) => c.rank === "JOKER");
    assert.equal(jokers.length, 2);
  });

  it("standard cards have a suit; Jokers have no suit", () => {
    const deck = createDeck();
    for (const card of deck) {
      if (card.rank === "JOKER") {
        assert.equal(card.suit, undefined, `Joker ${card.id} should have no suit`);
      } else {
        assert.ok(card.suit, `card ${card.id} (${card.rank}) must have a suit`);
        assert.ok(SUITS.includes(card.suit), `card ${card.id} suit ${card.suit} not in SUITS`);
      }
    }
  });

  it("each (suit, rank) pair appears exactly once for non-Joker cards", () => {
    const deck = createDeck();
    const seen = new Set<string>();
    for (const card of deck) {
      if (card.rank === "JOKER") continue;
      const key = `${card.suit}-${card.rank}`;
      assert.ok(!seen.has(key), `duplicate suit/rank combination: ${key}`);
      seen.add(key);
    }
    // 4 suits × 13 ranks
    assert.equal(seen.size, 52);
  });

  it("card values match getCardValue for every card", () => {
    const deck = createDeck();
    for (const card of deck) {
      assert.equal(card.value, getCardValue(card.rank), `card ${card.id} (${card.rank}) has wrong value`);
    }
  });

  it("every card has a unique id", () => {
    const deck = createDeck();
    const ids = new Set(deck.map((c) => c.id));
    assert.equal(ids.size, deck.length);
  });

  it("ids reset between calls (deterministic across deck creations)", () => {
    const d1 = createDeck();
    const d2 = createDeck();
    assert.deepEqual(
      d1.map((c) => c.id),
      d2.map((c) => c.id),
    );
  });

  it("SUITS contains the 4 expected suits", () => {
    assert.deepEqual([...SUITS].sort(), ["clubs", "diamonds", "hearts", "spades"]);
  });

  it("RANKS contains the 13 standard ranks (no Joker)", () => {
    assert.deepEqual(RANKS, ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]);
  });
});
