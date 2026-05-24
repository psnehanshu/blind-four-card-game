import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "../engine/game-engine.js";
import type { Card, Rank } from "../engine/types.js";
import { HAND_SIZE, MIN_TURNS_BEFORE_SHOWDOWN } from "../engine/types.js";
import { nextBotPlayerId, pickBotAction } from "./bot.js";

/** Builds a card with arbitrary id/rank/value. We poke these straight into
 *  hands/deck via the documented `engine.getState()` escape hatch so tests
 *  can construct precise scenarios without hunting for seeds. */
function card(id: string, rank: Rank, value: number): Card {
  return { id, rank, value, suit: "spades" };
}

/** Replace `playerId`'s hand with cards of the given values (rank "5" is
 *  arbitrary; the bot evaluates by `card.value`). */
function setHand(engine: GameEngine, playerId: string, values: number[]): void {
  const player = engine.getState().players.find((p) => p.id === playerId);
  if (!player) throw new Error(`No such player ${playerId}`);
  for (let i = 0; i < HAND_SIZE; i++) {
    const v = values[i];
    if (v === undefined) throw new Error("Need 4 values");
    player.hand[i] = { card: card(`h-${playerId}-${i}`, "5", v), locked: false };
  }
}

/** Push a card to the top of the deck (next pop()). */
function stackDeck(engine: GameEngine, c: Card): void {
  engine.getState().deck.push(c);
}

/** Create a 2-player game with the bot in seat 0 (so it acts first), with
 *  reveals acknowledged for both players. */
function botFirst(seed = 1): GameEngine {
  const engine = new GameEngine({ gameId: "g", playerIds: ["bot", "alice"], seed });
  for (const p of engine.getState().players) {
    engine.processEvent(p.id, "ACKNOWLEDGE_REVEAL", undefined);
  }
  return engine;
}

/** Deterministic rng generator that returns a fixed sequence then loops. */
function fakeRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    if (v === undefined) throw new Error("Empty rng sequence");
    return v;
  };
}

describe("bot — initial reveal + draw", () => {
  it("returns ACKNOWLEDGE_REVEAL while state=initial_reveal", () => {
    const engine = new GameEngine({ gameId: "g", playerIds: ["bot", "alice"], seed: 1 });
    assert.deepEqual(pickBotAction(engine, "bot"), { type: "ACKNOWLEDGE_REVEAL", payload: undefined });
  });

  it("draws from the deck when it's the bot's turn", () => {
    const engine = botFirst();
    assert.deepEqual(pickBotAction(engine, "bot"), { type: "DRAW_CARD", payload: { source: "deck" } });
  });

  it("returns null when it isn't the bot's turn", () => {
    const engine = botFirst();
    // alice is seat 1; not her turn since currentTurn=0
    assert.equal(pickBotAction(engine, "alice"), null);
  });

  it("draws from the discard pile when the top is very low and improves the hand", () => {
    const engine = botFirst();
    setHand(engine, "bot", [8, 9, 10, 11]); // highest=11
    engine.getState().discardPile.push(card("steal", "2", 2));
    assert.deepEqual(pickBotAction(engine, "bot"), { type: "DRAW_CARD", payload: { source: "discard" } });
  });

  it("draws from the deck when the discard top is low but doesn't improve the hand", () => {
    const engine = botFirst();
    setHand(engine, "bot", [1, 1, 1, 1]); // highest=1, can't be beaten by a 2
    engine.getState().discardPile.push(card("notlow", "2", 2));
    assert.deepEqual(pickBotAction(engine, "bot"), { type: "DRAW_CARD", payload: { source: "deck" } });
  });

  it("draws from the deck when the discard top is above the threshold", () => {
    const engine = botFirst();
    setHand(engine, "bot", [8, 9, 10, 11]); // would improve, but 5 > default threshold of 4
    engine.getState().discardPile.push(card("mid", "5", 5));
    assert.deepEqual(pickBotAction(engine, "bot"), { type: "DRAW_CARD", payload: { source: "deck" } });
  });

  it("respects a custom discardDrawThreshold", () => {
    const engine = botFirst();
    setHand(engine, "bot", [8, 9, 10, 11]);
    engine.getState().discardPile.push(card("mid", "5", 5));
    assert.deepEqual(pickBotAction(engine, "bot", { discardDrawThreshold: 5 }), {
      type: "DRAW_CARD",
      payload: { source: "discard" },
    });
  });
});

describe("bot — replace vs discard", () => {
  it("replaces the highest unlocked card when drawn is lower (no mistake forced)", () => {
    const engine = botFirst();
    setHand(engine, "bot", [3, 13, 1, 2]); // K at index 1 is highest
    stackDeck(engine, card("low", "2", 2));
    engine.processEvent("bot", "DRAW_CARD", { source: "deck" });
    // rng() < 0.3 picks mistake — 0.9 keeps the optimal slot
    const action = pickBotAction(engine, "bot", { rng: fakeRng([0.9]) });
    assert.deepEqual(action, { type: "REPLACE_CARD", payload: { handIndex: 1 } });
  });

  it("discards the drawn card when it's not strictly lower than the highest", () => {
    const engine = botFirst();
    setHand(engine, "bot", [3, 7, 1, 2]);
    stackDeck(engine, card("eq", "7", 7));
    engine.processEvent("bot", "DRAW_CARD", { source: "deck" });
    const action = pickBotAction(engine, "bot");
    assert.deepEqual(action, { type: "DISCARD_DRAWN", payload: undefined });
  });

  it("picks a non-optimal slot on the 30% mistake path", () => {
    const engine = botFirst();
    setHand(engine, "bot", [3, 13, 1, 2]); // optimal index = 1
    stackDeck(engine, card("low", "2", 2));
    engine.processEvent("bot", "DRAW_CARD", { source: "deck" });
    // First rng() < 0.3 → mistake branch; second rng() picks index from {0,2,3}.
    // rng=0.5 → floor(0.5 * 3)=1 → unlocked[1] which is index 2 in original hand.
    const action = pickBotAction(engine, "bot", { rng: fakeRng([0.1, 0.5]) });
    assert.deepEqual(action, { type: "REPLACE_CARD", payload: { handIndex: 2 } });
  });

  it("falls back to replacing when forced (drawn from discard, all slots unlocked)", () => {
    const engine = botFirst();
    setHand(engine, "bot", [3, 7, 1, 2]);
    engine.getState().discardPile.push(card("disc", "9", 9));
    engine.processEvent("bot", "DRAW_CARD", { source: "discard" });
    // Drawn=9 isn't lower than highest=7, but discard-draws can't be discarded
    // back, so bot must REPLACE (highest=index 1, no mistake at rng=0.9).
    const action = pickBotAction(engine, "bot", { rng: fakeRng([0.9]) });
    assert.deepEqual(action, { type: "REPLACE_CARD", payload: { handIndex: 1 } });
  });
});

describe("bot — showdown", () => {
  function getToShowdownEligible(): GameEngine {
    // Both players take 2 quick turns each by drawing from deck and
    // discarding back. After alice ends her 2nd turn, it's bot's 3rd turn,
    // at which point both have completed MIN_TURNS_BEFORE_SHOWDOWN.
    const engine = botFirst();
    for (let turn = 0; turn < MIN_TURNS_BEFORE_SHOWDOWN; turn++) {
      for (const pid of ["bot", "alice"]) {
        // Make sure the next draw isn't a power card so the turn ends cleanly.
        stackDeck(engine, card(`fill-${turn}-${pid}`, "5", 5));
        engine.processEvent(pid, "DRAW_CARD", { source: "deck" });
        engine.processEvent(pid, "DISCARD_DRAWN", undefined);
        if (engine.getValidEvents(pid).includes("END_TURN")) {
          engine.processEvent(pid, "END_TURN", undefined);
        }
      }
    }
    // Bot now needs to draw + decide to reach showdown_eligible.
    setHand(engine, "bot", [1, 1, 1, 1]); // value=4, below threshold
    stackDeck(engine, card("hi", "8", 8));
    engine.processEvent("bot", "DRAW_CARD", { source: "deck" });
    engine.processEvent("bot", "DISCARD_DRAWN", undefined);
    return engine;
  }

  it("calls showdown when hand value < threshold", () => {
    const engine = getToShowdownEligible();
    const action = pickBotAction(engine, "bot");
    assert.deepEqual(action, { type: "CALL_SHOWDOWN", payload: undefined });
  });

  it("ends turn when hand value meets/exceeds threshold", () => {
    const engine = getToShowdownEligible();
    setHand(engine, "bot", [10, 1, 1, 1]); // value=13, above threshold
    const action = pickBotAction(engine, "bot");
    assert.deepEqual(action, { type: "END_TURN", payload: undefined });
  });
});

describe("bot — power actions", () => {
  function triggerPower(rank: Rank, value: number): GameEngine {
    const engine = botFirst();
    setHand(engine, "bot", [1, 1, 1, 1]); // low values so bot discards the drawn power card
    stackDeck(engine, card(`pow-${rank}`, rank, value));
    engine.processEvent("bot", "DRAW_CARD", { source: "deck" });
    engine.processEvent("bot", "DISCARD_DRAWN", undefined);
    assert.ok(engine.getValidEvents("bot").includes("USE_POWER"), `expected power phase for ${rank}`);
    return engine;
  }

  it("uses Peek (10) — engine accepts the produced action", () => {
    const engine = triggerPower("10", 10);
    const action = pickBotAction(engine, "bot");
    assert.equal(action?.type, "USE_POWER");
    if (action?.type !== "USE_POWER") throw new Error("expected USE_POWER");
    const result = engine.processEvent("bot", "USE_POWER", action.payload);
    assert.equal(result.error, undefined);
  });

  it("uses Shuffle (J) — engine accepts the produced action", () => {
    const engine = triggerPower("J", 11);
    const action = pickBotAction(engine, "bot");
    if (action?.type !== "USE_POWER") throw new Error("expected USE_POWER");
    const result = engine.processEvent("bot", "USE_POWER", action.payload);
    assert.equal(result.error, undefined);
  });

  it("uses Swap (Q) — engine accepts the produced action", () => {
    const engine = triggerPower("Q", 12);
    const action = pickBotAction(engine, "bot");
    if (action?.type !== "USE_POWER") throw new Error("expected USE_POWER");
    const result = engine.processEvent("bot", "USE_POWER", action.payload);
    assert.equal(result.error, undefined);
  });

  it("uses Lock (K) — engine accepts the produced action", () => {
    const engine = triggerPower("K", 13);
    const action = pickBotAction(engine, "bot");
    if (action?.type !== "USE_POWER") throw new Error("expected USE_POWER");
    const result = engine.processEvent("bot", "USE_POWER", action.payload);
    assert.equal(result.error, undefined);
  });

  it("Lock (K) prefers the bot's own low cards (value ≤ 3)", () => {
    // triggerPower sets bot's hand to [1, 1, 1, 1] — all low. Bot must
    // target itself, not alice.
    const engine = triggerPower("K", 13);
    const action = pickBotAction(engine, "bot");
    if (action?.type !== "USE_POWER" || action.payload.power !== "lock") {
      throw new Error("expected lock action");
    }
    assert.equal(action.payload.targetPlayerId, "bot");
  });

  it("Lock (K) skips own cards above the threshold", () => {
    const engine = triggerPower("K", 13);
    setHand(engine, "bot", [10, 11, 12, 4]); // none ≤ 3
    setHand(engine, "alice", [1, 1, 1, 1]);
    // No own low cards → falls back to random. Drive rng so the picked
    // candidate is deterministic; we only assert the action validates.
    const action = pickBotAction(engine, "bot", { rng: fakeRng([0]) });
    if (action?.type !== "USE_POWER" || action.payload.power !== "lock") {
      throw new Error("expected lock action");
    }
    const result = engine.processEvent("bot", "USE_POWER", action.payload);
    assert.equal(result.error, undefined);
  });

  it("Lock (K) skips already-locked own low cards", () => {
    const engine = triggerPower("K", 13);
    // Set hand: index 0 is low but already locked; index 2 is the only
    // unlocked low slot.
    setHand(engine, "bot", [1, 10, 2, 11]);
    const botPlayer = engine.getState().players.find((p) => p.id === "bot");
    if (!botPlayer) throw new Error("no bot");
    const slot0 = botPlayer.hand[0];
    if (!slot0) throw new Error("no slot 0");
    slot0.locked = true;
    const action = pickBotAction(engine, "bot");
    if (action?.type !== "USE_POWER" || action.payload.power !== "lock") {
      throw new Error("expected lock action");
    }
    assert.equal(action.payload.targetPlayerId, "bot");
    assert.equal(action.payload.cardIndex, 2);
  });

  it("uses Joker — engine accepts the produced (mimicked) action for every mimicRank", () => {
    // Joker mimic is chosen by rng(); cycle through all four mimic values.
    const mimics = [0, 0.3, 0.6, 0.9]; // → indices 0, 1, 2, 3 into ["10","J","Q","K"]
    for (const mimicSeed of mimics) {
      const engine = triggerPower("JOKER", 20);
      const action = pickBotAction(engine, "bot", { rng: fakeRng([mimicSeed, 0.1, 0.1, 0.1, 0.1]) });
      if (action?.type !== "USE_POWER") throw new Error("expected USE_POWER");
      const result = engine.processEvent("bot", "USE_POWER", action.payload);
      assert.equal(result.error, undefined, `mimic seed ${mimicSeed}`);
    }
  });
});

describe("bot — nextBotPlayerId", () => {
  it("returns a bot that still needs to ack during initial_reveal", () => {
    const engine = new GameEngine({ gameId: "g", playerIds: ["alice", "bot"], seed: 1 });
    assert.equal(nextBotPlayerId(engine, new Set(["bot"])), "bot");
  });

  it("returns null when no bot needs to ack", () => {
    const engine = new GameEngine({ gameId: "g", playerIds: ["alice", "bot"], seed: 1 });
    engine.processEvent("bot", "ACKNOWLEDGE_REVEAL", undefined);
    assert.equal(nextBotPlayerId(engine, new Set(["bot"])), null);
  });

  it("returns the current-turn bot during play", () => {
    const engine = botFirst();
    assert.equal(nextBotPlayerId(engine, new Set(["bot"])), "bot");
  });

  it("returns null when it's a human's turn", () => {
    const engine = botFirst();
    // Push a benign card and end bot's turn so alice (human) is up.
    setHand(engine, "bot", [1, 1, 1, 1]);
    stackDeck(engine, card("benign", "5", 5));
    engine.processEvent("bot", "DRAW_CARD", { source: "deck" });
    engine.processEvent("bot", "DISCARD_DRAWN", undefined);
    engine.processEvent("bot", "END_TURN", undefined);
    assert.equal(nextBotPlayerId(engine, new Set(["bot"])), null);
  });
});
