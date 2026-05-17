import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "./game-engine.js";
import type { EngineConfig, PowerAction, PlayerCard } from "./types.js";
import { HAND_SIZE, MIN_TURNS_BEFORE_SHOWDOWN } from "./types.js";

function makeConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    gameId: "test-game",
    playerIds: ["alice", "bob", "charlie"],
    seed: 42,
    ...overrides,
  };
}

type PlayerId = string;
function turnOrder(engine: GameEngine): PlayerId[] {
  return engine.getState().players.map((p) => p.id);
}

// ───────────────────────────────  Game Creation  ───────────────────────────────

describe("GameEngine — createGame", () => {
  it("deals 4 cards per player", () => {
    const engine = new GameEngine(makeConfig());
    const result = engine.createGame();
    for (const player of result.nextState.players) {
      assert.equal(player.hand.length, HAND_SIZE);
    }
  });

  it("creates correct number of players", () => {
    const engine = new GameEngine(makeConfig({ playerIds: ["a", "b"] }));
    const result = engine.createGame();
    assert.equal(result.nextState.players.length, 2);
  });

  it("deck size = 54 - (players * 4)", () => {
    const engine = new GameEngine(makeConfig({ playerIds: ["a", "b", "c", "d"] }));
    const result = engine.createGame();
    assert.equal(result.nextState.deck.length, 54 - 4 * 4);
  });

  it("state is in_progress", () => {
    const engine = new GameEngine(makeConfig());
    const result = engine.createGame();
    assert.equal(result.nextState.state, "in_progress");
  });

  it("current turn is player 0", () => {
    const engine = new GameEngine(makeConfig());
    engine.createGame();
    assert.equal(engine.getState().currentTurn, 0);
  });

  it("valid events for first player include DRAW_CARD", () => {
    const engine = new GameEngine(makeConfig());
    engine.createGame();
    const events = engine.getValidEvents("alice");
    assert.deepEqual(events, ["DRAW_CARD"]);
  });

  it("rejects invalid player count", () => {
    assert.throws(() => new GameEngine(makeConfig({ playerIds: ["a"] })));
    assert.throws(() => new GameEngine(makeConfig({ playerIds: ["a", "b", "c", "d", "e", "f", "g"] })));
  });

  it("same seed produces same deal", () => {
    const e1 = new GameEngine(makeConfig({ seed: 100 }));
    const e2 = new GameEngine(makeConfig({ seed: 100 }));
    e1.createGame();
    e2.createGame();
    const g1 = e1.getState();
    const g2 = e2.getState();
    for (let i = 0; i < g1.players.length; i++) {
      const p1 = g1.players[i];
      const p2 = g2.players[i];
      assert.ok(p1 && p2);
      for (let j = 0; j < HAND_SIZE; j++) {
        const c1: PlayerCard | undefined = p1.hand[j];
        const c2: PlayerCard | undefined = p2.hand[j];
        assert.ok(c1 && c2);
        assert.equal(c1.card.id, c2.card.id);
      }
    }
  });
});

// ───────────────────────────────  Turn Flow  ───────────────────────────────

describe("GameEngine — turn flow", () => {
  function setup(): GameEngine {
    const e = new GameEngine(makeConfig());
    e.createGame();
    return e;
  }

  function drawThenEnd(engine: GameEngine, playerId: string): void {
    engine.processEvent(playerId, "DRAW_CARD", { source: "deck" });
    engine.processEvent(playerId, "DISCARD_DRAWN", undefined);
    if (engine.getValidEvents(playerId).includes("USE_POWER")) {
      // Try each possible power action until one succeeds
      const otherPlayers = turnOrder(engine).filter((p) => p !== playerId);
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: playerId },
        { power: "lock", targetPlayerId: playerId, cardIndex: 0 },
        {
          power: "joker",
          mimicRank: "10",
          action: { power: "peek", target: "own" },
        },
      ];
      const firstOther = otherPlayers[0];
      if (firstOther) {
        attempts.push({
          power: "swap",
          sourcePlayerId: playerId,
          sourceCardIndex: 0,
          targetPlayerId: firstOther,
          targetCardIndex: 0,
        });
      }
      for (const attempt of attempts) {
        const r = engine.processEvent(playerId, "USE_POWER", attempt);
        if (!r.error) break;
      }
    }
    engine.processEvent(playerId, "END_TURN", undefined);
  }

  it("draw → discard drawn → end turn advances to next player", () => {
    const e = setup();
    const players = turnOrder(e);

    const p0 = players[0];
    assert.ok(p0);

    // Alice's first turn
    let r = e.processEvent(p0, "DRAW_CARD", { source: "deck" });
    assert.equal(r.error, undefined);
    r = e.processEvent(p0, "DISCARD_DRAWN", undefined);
    assert.equal(r.error, undefined);
    r = e.processEvent(p0, "END_TURN", undefined);
    assert.equal(r.error, undefined);
    assert.equal(e.getState().currentTurn, 1);

    // Bob's first turn
    const p1 = players[1];
    assert.ok(p1);
    drawThenEnd(e, p1);
    assert.equal(e.getState().currentTurn, 2);
  });

  it("draw → replace card → end turn replaces card in hand", () => {
    const e = setup();
    const players = turnOrder(e);
    const playerId = players[0];
    assert.ok(playerId);
    const state = e.getState();
    const p0 = state.players[0];
    assert.ok(p0);
    const c2 = p0.hand[2];
    assert.ok(c2);
    const oldCard = c2.card;

    e.processEvent(playerId, "DRAW_CARD", { source: "deck" });
    e.processEvent(playerId, "REPLACE_CARD", { handIndex: 2 });
    e.processEvent(playerId, "END_TURN", undefined);

    const p0after = e.getState().players[0];
    assert.ok(p0after);
    const c2after = p0after.hand[2];
    assert.ok(c2after);
    const newCard = c2after.card;
    assert.notEqual(newCard.id, oldCard.id);
    // Discard pile should have old card
    assert.equal(e.getState().discardPile.at(-1)?.id, oldCard.id);
  });

  it("rejects draw twice without discard", () => {
    const e = setup();
    const players = turnOrder(e);
    const pid = players[0];
    assert.ok(pid);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    const r = e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    assert.ok(r.error);
  });

  it("rejects wrong player acting", () => {
    const e = setup();
    const r = e.processEvent("bob", "DRAW_CARD", { source: "deck" });
    assert.ok(r.error);
  });

  it("rejects replace before draw", () => {
    const e = setup();
    const players = turnOrder(e);
    const pid = players[0];
    assert.ok(pid);
    const r = e.processEvent(pid, "REPLACE_CARD", { handIndex: 0 });
    assert.ok(r.error);
  });

  it("rejects replace of locked card", () => {
    // 2-player seed 7 yields draws K → 7 → 8: alice locks K, bob discards a non-power 7,
    // then alice's next draw (8) lets her try to replace her locked card directly.
    const e = new GameEngine(makeConfig({ playerIds: ["alice", "bob"], seed: 7 }));
    e.createGame();
    assert.equal(e.getState().deck.at(-1)?.rank, "K", "test seed must produce K on first draw");

    // Alice draws K, discards, locks her own card 0
    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    const discR = e.processEvent("alice", "DISCARD_DRAWN", undefined);
    assert.ok(discR.validEvents.includes("USE_POWER"), "discarding a K must trigger USE_POWER phase");
    const lockR = e.processEvent("alice", "USE_POWER", {
      power: "lock",
      targetPlayerId: "alice",
      cardIndex: 0,
    });
    assert.equal(lockR.error, undefined);
    e.processEvent("alice", "END_TURN", undefined);

    // Bob's turn — non-power discard, cleanly advances back to alice
    e.processEvent("bob", "DRAW_CARD", { source: "deck" });
    const bobDiscR = e.processEvent("bob", "DISCARD_DRAWN", undefined);
    assert.ok(!bobDiscR.validEvents.includes("USE_POWER"), "bob's draw should be a non-power card");
    e.processEvent("bob", "END_TURN", undefined);

    // Alice draws again and attempts to replace her locked card 0.
    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    const repR = e.processEvent("alice", "REPLACE_CARD", { handIndex: 0 });
    assert.match(repR.error ?? "", /Cannot replace a locked card/);
    // Card must still be locked and unchanged
    assert.equal(e.getState().players[0]?.hand[0]?.locked, true);
  });

  it("discard drawn from discard pile works", () => {
    const e = setup();
    const players = turnOrder(e);
    const pid = players[0];
    assert.ok(pid);
    // First put a card in the discard pile
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);
    e.processEvent(pid, "END_TURN", undefined);

    // Next player draws from discard
    const pid2 = players[1];
    assert.ok(pid2);
    const r = e.processEvent(pid2, "DRAW_CARD", { source: "discard" });
    assert.equal(r.error, undefined);
  });

  it("deck draw is rejected when deck is empty", () => {
    const e = new GameEngine(makeConfig({ playerIds: ["a", "b"], seed: 1 }));
    e.createGame();
    const players = turnOrder(e);
    const p0 = players[0];
    assert.ok(p0);

    // Deck is 54 - 8 = 46 cards. Draw until empty.
    for (let i = 0; i < 46; i++) {
      const currentPid = players[0];
      assert.ok(currentPid);
      const r = e.processEvent(currentPid, "DRAW_CARD", { source: "deck" });
      if (r.error) break;
      e.processEvent(currentPid, "DISCARD_DRAWN", undefined);
      if (e.getValidEvents(currentPid).includes("USE_POWER")) {
        e.processEvent(currentPid, "USE_POWER", {
          power: "peek",
          target: "own",
        });
      }
      e.processEvent(currentPid, "END_TURN", undefined);
    }

    const firstPlayer = players[0];
    assert.ok(firstPlayer);
    const r = e.processEvent(firstPlayer, "DRAW_CARD", { source: "deck" });
    assert.ok(r.error || e.getState().deck.length === 0);
  });

  it("discard pile draw is rejected when discard pile is empty", () => {
    const e = setup();
    const players = turnOrder(e);
    const p0 = players[0];
    assert.ok(p0);
    const r = e.processEvent(p0, "DRAW_CARD", {
      source: "discard",
    });
    assert.ok(r.error);
  });

  it("DISCARD_DRAWN of a non-power card skips USE_POWER and goes straight to showdown_eligible", () => {
    // 2-player seed 0: top draw is 8 (non-power, value 0).
    const e = new GameEngine(makeConfig({ playerIds: ["alice", "bob"], seed: 0 }));
    e.createGame();
    assert.equal(e.getState().deck.at(-1)?.rank, "8", "test seed must produce 8 on first draw");

    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    const discR = e.processEvent("alice", "DISCARD_DRAWN", undefined);
    assert.equal(discR.error, undefined);
    // No USE_POWER, but END_TURN should be available immediately.
    assert.ok(!discR.validEvents.includes("USE_POWER"), "non-power discard must not trigger USE_POWER");
    assert.ok(discR.validEvents.includes("END_TURN"), "non-power discard must allow END_TURN");

    // USE_POWER attempt must be rejected — no pending power.
    const badPower = e.processEvent("alice", "USE_POWER", { power: "peek", target: "own" });
    assert.match(badPower.error ?? "", /No power to resolve|No pending power/);
  });

  it("REPLACE_CARD activates the discarded hand card's power", () => {
    // 2-player seed 0: top draw is 8 (non-power); alice's hand[2] is a Q.
    // Replacing hand[2] should put the Q on the discard pile AND trigger USE_POWER.
    const e = new GameEngine(makeConfig({ playerIds: ["alice", "bob"], seed: 0 }));
    e.createGame();
    assert.equal(e.getState().players[0]?.hand[2]?.card.rank, "Q", "test seed must place Q at alice's hand[2]");

    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    const repR = e.processEvent("alice", "REPLACE_CARD", { handIndex: 2 });
    assert.equal(repR.error, undefined);
    assert.ok(repR.validEvents.includes("USE_POWER"), "replacing a Q must trigger USE_POWER phase");

    // Following through with the Q swap must succeed.
    const swapR = e.processEvent("alice", "USE_POWER", {
      power: "swap",
      sourcePlayerId: "alice",
      sourceCardIndex: 0,
      targetPlayerId: "bob",
      targetCardIndex: 0,
    });
    assert.equal(swapR.error, undefined);
  });
});

// ───────────────────────────────  Powers  ───────────────────────────────

describe("GameEngine — powers", () => {
  it("Peek (10) — can peek own cards and returns info", () => {
    // seed 17 (3 players) deterministically yields a 10 as the first deck draw
    const e = new GameEngine(makeConfig({ seed: 17 }));
    e.createGame();
    const players = turnOrder(e);
    const pid = players[0];
    assert.ok(pid);

    assert.equal(e.getState().deck.at(-1)?.rank, "10", "test seed must produce 10 on first draw");

    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    const discR = e.processEvent(pid, "DISCARD_DRAWN", undefined);
    assert.ok(discR.validEvents.includes("USE_POWER"), "discarding a 10 must trigger USE_POWER phase");

    const peekR = e.processEvent(pid, "USE_POWER", {
      power: "peek",
      target: "own",
    });
    assert.equal(peekR.error, undefined);
    const { peekResult } = peekR;
    assert.ok(peekResult);
    assert.equal(peekResult.playerId, pid);
    assert.equal(peekResult.cards.length, HAND_SIZE);
  });

  it("Peek (10) — can peek opponent and returns exactly one card", () => {
    // seed 17 (3 players) deterministically yields a 10 as the first deck draw
    const e = new GameEngine(makeConfig({ seed: 17 }));
    e.createGame();
    const players = turnOrder(e);
    const pid = players[0];
    const opponentId = players[1];
    assert.ok(pid && opponentId);

    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    const opponent = e.getState().players.find((p) => p.id === opponentId);
    assert.ok(opponent);
    const expectedCard = opponent.hand[0];
    assert.ok(expectedCard);

    const peekR = e.processEvent(pid, "USE_POWER", {
      power: "peek",
      target: "opponent",
      opponentId,
    });
    assert.equal(peekR.error, undefined);
    const { peekResult } = peekR;
    assert.ok(peekResult);
    assert.equal(peekResult.playerId, opponentId);
    assert.equal(peekResult.cards.length, 1, "opponent peek must reveal exactly one card");
    const revealed = peekResult.cards[0];
    assert.ok(revealed);
    assert.equal(revealed.index, 0, "opponent peek must return the first unlocked card index");
    assert.equal(revealed.card.id, expectedCard.card.id);
    assert.equal(revealed.card.rank, expectedCard.card.rank);
  });

  it("Lock (K) — locks a card and creates a marker", () => {
    // seed 999 (3 players) deterministically yields a K as the first deck draw
    const e = new GameEngine(makeConfig({ seed: 999 }));
    e.createGame();
    const players = turnOrder(e);
    const pid = players[0];
    assert.ok(pid);

    assert.equal(e.getState().deck.at(-1)?.rank, "K", "test seed must produce K on first draw");

    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    const discR = e.processEvent(pid, "DISCARD_DRAWN", undefined);
    assert.ok(discR.validEvents.includes("USE_POWER"), "discarding a K must trigger USE_POWER phase");

    const lockR = e.processEvent(pid, "USE_POWER", {
      power: "lock",
      targetPlayerId: pid,
      cardIndex: 0,
    });
    assert.equal(lockR.error, undefined);
    const p0 = e.getState().players[0];
    assert.ok(p0);
    const c0 = p0.hand[0];
    assert.ok(c0);
    assert.ok(c0.locked);
  });

  it("Lock (K) — marker card is kept out of the discard pile", () => {
    // seed 999 (3 players): top deck draw is K
    const e = new GameEngine(makeConfig({ seed: 999 }));
    e.createGame();
    const players = turnOrder(e);
    const pid = players[0];
    assert.ok(pid);

    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    // After DISCARD_DRAWN the K briefly enters the discard pile.
    const discR = e.processEvent(pid, "DISCARD_DRAWN", undefined);
    assert.ok(discR.validEvents.includes("USE_POWER"));
    const kAfterDiscard = e.getState().discardPile.at(-1);
    assert.ok(kAfterDiscard);
    assert.equal(kAfterDiscard.rank, "K");

    const lockR = e.processEvent(pid, "USE_POWER", {
      power: "lock",
      targetPlayerId: pid,
      cardIndex: 0,
    });
    assert.equal(lockR.error, undefined);

    // After applyLock the K must move from discardPile to lockMarkers.
    const state = e.getState();
    assert.ok(
      !state.discardPile.some((c) => c.id === kAfterDiscard.id),
      "K marker card must not be in the discard pile after lock is applied",
    );
    const visible = e.getVisibleState(pid);
    const marker = visible.lockMarkers.find((m) => m.markerCard.id === kAfterDiscard.id);
    assert.ok(marker, "K marker card must appear in lockMarkers");
    assert.equal(marker.markerCard.rank, "K");
    assert.equal(marker.playerId, pid);
    assert.equal(marker.cardIndex, 0);
  });

  it("Swap (Q) — swaps cards between players", () => {
    // seed 9 (3 players) deterministically yields a Q as the first deck draw
    const e = new GameEngine(makeConfig({ seed: 9 }));
    e.createGame();
    const players = turnOrder(e);
    const pid = players[0];
    const pid2 = players[1];
    assert.ok(pid && pid2);

    assert.equal(e.getState().deck.at(-1)?.rank, "Q", "test seed must produce Q on first draw");

    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    const discR = e.processEvent(pid, "DISCARD_DRAWN", undefined);
    assert.ok(discR.validEvents.includes("USE_POWER"), "discarding a Q must trigger USE_POWER phase");

    const p0 = e.getState().players[0];
    const p1 = e.getState().players[1];
    assert.ok(p0 && p1);
    const cardA = p0.hand[0];
    const cardB = p1.hand[0];
    assert.ok(cardA && cardB);
    const idA = cardA.card.id;
    const idB = cardB.card.id;

    const swapR = e.processEvent(pid, "USE_POWER", {
      power: "swap",
      sourcePlayerId: pid,
      sourceCardIndex: 0,
      targetPlayerId: pid2,
      targetCardIndex: 0,
    });
    assert.equal(swapR.error, undefined);

    const p0after = e.getState().players[0];
    const p1after = e.getState().players[1];
    assert.ok(p0after && p1after);
    const newCardA = p0after.hand[0];
    const newCardB = p1after.hand[0];
    assert.ok(newCardA && newCardB);
    assert.equal(newCardA.card.id, idB);
    assert.equal(newCardB.card.id, idA);
  });

  it("Swap (Q) — rejects swap involving a locked card", () => {
    // 2-player seed 26 yields draw sequence K → 7 → Q for alice/bob/alice:
    //   - alice turn 1 draws K → locks her card 0
    //   - bob turn 1 draws 7 → harmless discard
    //   - alice turn 2 draws Q → attempts swap of her locked card
    const e = new GameEngine(makeConfig({ playerIds: ["alice", "bob"], seed: 26 }));
    e.createGame();
    const deck = e.getState().deck;
    assert.equal(deck.at(-1)?.rank, "K", "test seed must produce K on alice's first draw");
    assert.equal(deck.at(-3)?.rank, "Q", "test seed must produce Q on alice's second draw");

    // Alice locks her own card 0 via K
    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    e.processEvent("alice", "DISCARD_DRAWN", undefined);
    e.processEvent("alice", "USE_POWER", { power: "lock", targetPlayerId: "alice", cardIndex: 0 });
    e.processEvent("alice", "END_TURN", undefined);

    // Bob plays a harmless turn
    e.processEvent("bob", "DRAW_CARD", { source: "deck" });
    e.processEvent("bob", "DISCARD_DRAWN", undefined);
    e.processEvent("bob", "END_TURN", undefined);

    // Capture pre-swap hands to verify nothing moved
    const aliceHandBefore = e.getState().players[0]?.hand.map((pc) => pc.card.id);
    const bobHandBefore = e.getState().players[1]?.hand.map((pc) => pc.card.id);

    // Alice draws Q; reaches USE_POWER phase
    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    const discR = e.processEvent("alice", "DISCARD_DRAWN", undefined);
    assert.ok(discR.validEvents.includes("USE_POWER"), "discarding a Q must trigger USE_POWER phase");

    // Source is locked → validation rejects gracefully
    const swapR = e.processEvent("alice", "USE_POWER", {
      power: "swap",
      sourcePlayerId: "alice",
      sourceCardIndex: 0, // locked
      targetPlayerId: "bob",
      targetCardIndex: 0,
    });
    assert.match(swapR.error ?? "", /Cannot swap locked card/);

    // Hands must be unchanged
    const aliceHandAfter = e.getState().players[0]?.hand.map((pc) => pc.card.id);
    const bobHandAfter = e.getState().players[1]?.hand.map((pc) => pc.card.id);
    assert.deepEqual(aliceHandAfter, aliceHandBefore);
    assert.deepEqual(bobHandAfter, bobHandBefore);
    // Alice's card 0 must still be locked
    assert.equal(e.getState().players[0]?.hand[0]?.locked, true);
  });

  it("Swap (Q) — rejects swap when target card is locked", () => {
    // Same seed as above; this time alice locks bob's card 0, then swaps with it as target.
    const e = new GameEngine(makeConfig({ playerIds: ["alice", "bob"], seed: 26 }));
    e.createGame();

    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    e.processEvent("alice", "DISCARD_DRAWN", undefined);
    e.processEvent("alice", "USE_POWER", { power: "lock", targetPlayerId: "bob", cardIndex: 0 });
    e.processEvent("alice", "END_TURN", undefined);

    e.processEvent("bob", "DRAW_CARD", { source: "deck" });
    e.processEvent("bob", "DISCARD_DRAWN", undefined);
    e.processEvent("bob", "END_TURN", undefined);

    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    e.processEvent("alice", "DISCARD_DRAWN", undefined);

    const swapR = e.processEvent("alice", "USE_POWER", {
      power: "swap",
      sourcePlayerId: "alice",
      sourceCardIndex: 1, // unlocked
      targetPlayerId: "bob",
      targetCardIndex: 0, // locked
    });
    assert.match(swapR.error ?? "", /Cannot swap locked card/);

    // Bob's locked card 0 must still be locked
    assert.equal(e.getState().players[1]?.hand[0]?.locked, true);
  });

  it("Shuffle (J) — shuffles unlocked cards of target player", () => {
    // seed 37 (3 players) deterministically yields a J as the first deck draw
    const e = new GameEngine(makeConfig({ seed: 37 }));
    e.createGame();
    const players = turnOrder(e);
    const pid = players[0];
    const pid2 = players[1];
    assert.ok(pid && pid2);

    assert.equal(e.getState().deck.at(-1)?.rank, "J", "test seed must produce J on first draw");

    const p1 = e.getState().players[1];
    assert.ok(p1);
    const originalHand = [...p1.hand.map((pc) => pc.card.id)];
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    const discR = e.processEvent(pid, "DISCARD_DRAWN", undefined);
    assert.ok(discR.validEvents.includes("USE_POWER"), "discarding a J must trigger USE_POWER phase");

    const shufR = e.processEvent(pid, "USE_POWER", {
      power: "shuffle",
      targetPlayerId: pid2,
    });
    assert.equal(shufR.error, undefined);

    const p1after = e.getState().players[1];
    assert.ok(p1after);
    const newHand = p1after.hand.map((pc) => pc.card.id);
    // Same cards, different order (or same if RNG happens to keep order — very unlikely)
    assert.deepEqual(newHand.sort(), originalHand.sort());
  });

  it("Peek (10) — rejects opponent peek with unknown opponentId", () => {
    const e = new GameEngine(makeConfig({ seed: 17 }));
    e.createGame();
    const pid = turnOrder(e)[0];
    assert.ok(pid);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    const r = e.processEvent(pid, "USE_POWER", {
      power: "peek",
      target: "opponent",
      opponentId: "nobody",
    });
    assert.match(r.error ?? "", /Invalid opponentId/);
  });

  it("Peek (10) — rejects opponent peek when opponent has no unlocked cards", () => {
    const e = new GameEngine(makeConfig({ seed: 17 }));
    e.createGame();
    const pid = turnOrder(e)[0];
    const oppId = turnOrder(e)[1];
    assert.ok(pid && oppId);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    // Force all of opponent's cards to be locked.
    const opponent = e.getState().players.find((p) => p.id === oppId);
    assert.ok(opponent);
    for (const pc of opponent.hand) pc.locked = true;

    const r = e.processEvent(pid, "USE_POWER", {
      power: "peek",
      target: "opponent",
      opponentId: oppId,
    });
    assert.match(r.error ?? "", /No unlocked cards to peek at/);
  });

  it("Shuffle (J) — rejects unknown target player", () => {
    const e = new GameEngine(makeConfig({ seed: 37 }));
    e.createGame();
    const pid = turnOrder(e)[0];
    assert.ok(pid);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    const r = e.processEvent(pid, "USE_POWER", {
      power: "shuffle",
      targetPlayerId: "nobody",
    });
    assert.match(r.error ?? "", /Invalid target player/);
  });

  it("Swap (Q) — rejects unknown source/target players", () => {
    const e = new GameEngine(makeConfig({ seed: 9 }));
    e.createGame();
    const pid = turnOrder(e)[0];
    const pid2 = turnOrder(e)[1];
    assert.ok(pid && pid2);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    const badSource = e.processEvent(pid, "USE_POWER", {
      power: "swap",
      sourcePlayerId: "ghost",
      sourceCardIndex: 0,
      targetPlayerId: pid2,
      targetCardIndex: 0,
    });
    assert.match(badSource.error ?? "", /Invalid player in swap/);

    const badTarget = e.processEvent(pid, "USE_POWER", {
      power: "swap",
      sourcePlayerId: pid,
      sourceCardIndex: 0,
      targetPlayerId: "ghost",
      targetCardIndex: 0,
    });
    assert.match(badTarget.error ?? "", /Invalid player in swap/);
  });

  it("Swap (Q) — rejects out-of-range card indices", () => {
    const e = new GameEngine(makeConfig({ seed: 9 }));
    e.createGame();
    const pid = turnOrder(e)[0];
    const pid2 = turnOrder(e)[1];
    assert.ok(pid && pid2);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    const badSourceIdx = e.processEvent(pid, "USE_POWER", {
      power: "swap",
      sourcePlayerId: pid,
      sourceCardIndex: HAND_SIZE,
      targetPlayerId: pid2,
      targetCardIndex: 0,
    });
    assert.match(badSourceIdx.error ?? "", /Invalid source card index/);

    const badTargetIdx = e.processEvent(pid, "USE_POWER", {
      power: "swap",
      sourcePlayerId: pid,
      sourceCardIndex: 0,
      targetPlayerId: pid2,
      targetCardIndex: -1,
    });
    assert.match(badTargetIdx.error ?? "", /Invalid target card index/);
  });

  it("Lock (K) — rejects unknown target player", () => {
    const e = new GameEngine(makeConfig({ seed: 999 }));
    e.createGame();
    const pid = turnOrder(e)[0];
    assert.ok(pid);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    const r = e.processEvent(pid, "USE_POWER", {
      power: "lock",
      targetPlayerId: "nobody",
      cardIndex: 0,
    });
    assert.match(r.error ?? "", /Invalid target player/);
  });

  it("Lock (K) — rejects out-of-range card index", () => {
    const e = new GameEngine(makeConfig({ seed: 999 }));
    e.createGame();
    const pid = turnOrder(e)[0];
    assert.ok(pid);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    const tooBig = e.processEvent(pid, "USE_POWER", {
      power: "lock",
      targetPlayerId: pid,
      cardIndex: HAND_SIZE,
    });
    assert.match(tooBig.error ?? "", /Invalid card index/);

    const negative = e.processEvent(pid, "USE_POWER", {
      power: "lock",
      targetPlayerId: pid,
      cardIndex: -1,
    });
    assert.match(negative.error ?? "", /Invalid card index/);
  });

  it("Lock (K) — rejects locking an already-locked card", () => {
    // 2-player seed 7: alice draws K, bob draws 7, alice draws 8 — but we need K then K.
    // Easier path: lock card 0 manually, then try to lock it again via 3p seed 999.
    const e = new GameEngine(makeConfig({ seed: 999 }));
    e.createGame();
    const pid = turnOrder(e)[0];
    assert.ok(pid);
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    // Pre-lock card 0 directly to exercise the already-locked branch.
    const player = e.getState().players.find((p) => p.id === pid);
    assert.ok(player);
    const slot0 = player.hand[0];
    assert.ok(slot0);
    slot0.locked = true;

    const r = e.processEvent(pid, "USE_POWER", {
      power: "lock",
      targetPlayerId: pid,
      cardIndex: 0,
    });
    assert.match(r.error ?? "", /Card is already locked/);
  });

  it("Shuffle (J) — locked cards remain in their original positions", () => {
    // 2-player seed 58: alice T1 draws K → locks bob's card 0,
    // bob T1 draws 7 (non-power) → harmless discard,
    // alice T2 draws J → shuffles bob.
    const e = new GameEngine(makeConfig({ playerIds: ["alice", "bob"], seed: 58 }));
    e.createGame();
    const deck = e.getState().deck;
    assert.equal(deck.at(-1)?.rank, "K", "test seed must produce K on alice's first draw");
    assert.equal(deck.at(-3)?.rank, "J", "test seed must produce J on alice's second draw");

    // Alice locks bob's card 0.
    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    e.processEvent("alice", "DISCARD_DRAWN", undefined);
    e.processEvent("alice", "USE_POWER", { power: "lock", targetPlayerId: "bob", cardIndex: 0 });
    e.processEvent("alice", "END_TURN", undefined);

    // Bob plays a harmless turn.
    e.processEvent("bob", "DRAW_CARD", { source: "deck" });
    e.processEvent("bob", "DISCARD_DRAWN", undefined);
    e.processEvent("bob", "END_TURN", undefined);

    const bobBefore = e.getState().players[1];
    assert.ok(bobBefore);
    const lockedCardId = bobBefore.hand[0]?.card.id;
    assert.ok(lockedCardId);
    assert.equal(bobBefore.hand[0]?.locked, true);
    const unlockedIdsBefore = [bobBefore.hand[1]?.card.id, bobBefore.hand[2]?.card.id, bobBefore.hand[3]?.card.id].sort();

    // Alice shuffles bob.
    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    e.processEvent("alice", "DISCARD_DRAWN", undefined);
    const shufR = e.processEvent("alice", "USE_POWER", { power: "shuffle", targetPlayerId: "bob" });
    assert.equal(shufR.error, undefined);

    const bobAfter = e.getState().players[1];
    assert.ok(bobAfter);
    // Locked slot 0 must contain the same card, still locked.
    assert.equal(bobAfter.hand[0]?.card.id, lockedCardId, "locked card must stay in slot 0");
    assert.equal(bobAfter.hand[0]?.locked, true, "locked flag must be preserved");
    // The other three cards must still be the same set (possibly reordered among slots 1–3).
    const unlockedIdsAfter = [bobAfter.hand[1]?.card.id, bobAfter.hand[2]?.card.id, bobAfter.hand[3]?.card.id].sort();
    assert.deepEqual(unlockedIdsAfter, unlockedIdsBefore);
    // None of the unlocked slots should become locked.
    assert.equal(bobAfter.hand[1]?.locked, false);
    assert.equal(bobAfter.hand[2]?.locked, false);
    assert.equal(bobAfter.hand[3]?.locked, false);
  });
});

// ───────────────────────────────  Showdown  ───────────────────────────────

describe("GameEngine — showdown", () => {
  it("cannot call showdown before 2 turns per player", () => {
    const e = new GameEngine(makeConfig({ playerIds: ["a", "b"], seed: 42 }));
    e.createGame();
    const players = turnOrder(e);
    const pid = players[0];
    assert.ok(pid);

    // Complete 1 turn for player 0
    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);
    // Now at showdown_eligible — try to call showdown (should fail, only 1 turn)
    const callR = e.processEvent(pid, "CALL_SHOWDOWN", undefined);
    assert.ok(callR.error); // Not eligible yet
  });

  it("can call showdown and complete the game", () => {
    const e = new GameEngine(makeConfig({ playerIds: ["a", "b"], seed: 42 }));
    e.createGame();

    // Helper: play one full turn for a player (draw → discard → resolve power → end)
    function playTurn(pid: string): void {
      e.processEvent(pid, "DRAW_CARD", { source: "deck" });
      e.processEvent(pid, "DISCARD_DRAWN", undefined);
      if (e.getValidEvents(pid).includes("USE_POWER")) {
        const otherPlayers = turnOrder(e).filter((p) => p !== pid);
        const attempts: PowerAction[] = [
          { power: "peek", target: "own" },
          { power: "shuffle", targetPlayerId: pid },
          { power: "lock", targetPlayerId: pid, cardIndex: 0 },
          {
            power: "joker",
            mimicRank: "10",
            action: { power: "peek", target: "own" },
          },
        ];
        const firstOther = otherPlayers[0];
        if (firstOther) {
          attempts.push({
            power: "swap",
            sourcePlayerId: pid,
            sourceCardIndex: 0,
            targetPlayerId: firstOther,
            targetCardIndex: 0,
          });
        }
        for (const attempt of attempts) {
          const r = e.processEvent(pid, "USE_POWER", attempt);
          if (!r.error) break;
        }
      }
      e.processEvent(pid, "END_TURN", undefined);
    }

    // Complete MIN_TURNS_BEFORE_SHOWDOWN turns for each player
    const players = turnOrder(e);
    for (let turn = 0; turn < MIN_TURNS_BEFORE_SHOWDOWN; turn++) {
      for (const pid of players) {
        assert.ok(pid);
        playTurn(pid);
      }
    }

    // Now on player 0's 3rd turn — draw and discard
    const pid0 = players[0];
    assert.ok(pid0);
    e.processEvent(pid0, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid0, "DISCARD_DRAWN", undefined);
    if (e.getValidEvents(pid0).includes("USE_POWER")) {
      const otherPlayers = turnOrder(e).filter((p) => p !== pid0);
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: pid0 },
        { power: "lock", targetPlayerId: pid0, cardIndex: 0 },
        {
          power: "joker",
          mimicRank: "10",
          action: { power: "peek", target: "own" },
        },
      ];
      const firstOther = otherPlayers[0];
      if (firstOther) {
        attempts.push({
          power: "swap",
          sourcePlayerId: pid0,
          sourceCardIndex: 0,
          targetPlayerId: firstOther,
          targetCardIndex: 0,
        });
      }
      for (const attempt of attempts) {
        const r = e.processEvent(pid0, "USE_POWER", attempt);
        if (!r.error) break;
      }
    }

    // Should be able to call showdown now
    const callR = e.processEvent(pid0, "CALL_SHOWDOWN", undefined);
    assert.equal(callR.error, undefined);
    assert.equal(e.getState().state, "showdown");
    assert.equal(e.getState().callerId, pid0);

    // Other players get 1 final turn
    for (let i = 1; i < players.length; i++) {
      const otherPid = players[i];
      assert.ok(otherPid);
      playTurn(otherPid);
    }

    assert.equal(e.getState().state, "finished");
  });

  it("caller cannot act after calling showdown — not their turn", () => {
    // 3 players so the caller is bypassed in showdown turn order: alice → bob → charlie.
    const e = new GameEngine(makeConfig({ playerIds: ["alice", "bob", "charlie"], seed: 42 }));
    e.createGame();
    const players = turnOrder(e);

    function playTurn(pid: string): void {
      e.processEvent(pid, "DRAW_CARD", { source: "deck" });
      e.processEvent(pid, "DISCARD_DRAWN", undefined);
      if (e.getValidEvents(pid).includes("USE_POWER")) {
        const others = players.filter((p) => p !== pid);
        const firstOther = others[0];
        const attempts: PowerAction[] = [
          { power: "peek", target: "own" },
          { power: "shuffle", targetPlayerId: pid },
          { power: "lock", targetPlayerId: pid, cardIndex: 0 },
          { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
        ];
        if (firstOther) {
          attempts.push({
            power: "swap",
            sourcePlayerId: pid,
            sourceCardIndex: 0,
            targetPlayerId: firstOther,
            targetCardIndex: 0,
          });
        }
        for (const a of attempts) {
          if (!e.processEvent(pid, "USE_POWER", a).error) break;
        }
      }
      e.processEvent(pid, "END_TURN", undefined);
    }

    for (let i = 0; i < MIN_TURNS_BEFORE_SHOWDOWN; i++) {
      for (const pid of players) playTurn(pid);
    }

    // Alice's calling turn.
    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    e.processEvent("alice", "DISCARD_DRAWN", undefined);
    if (e.getValidEvents("alice").includes("USE_POWER")) {
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: "alice" },
        { power: "lock", targetPlayerId: "alice", cardIndex: 0 },
        { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
        { power: "swap", sourcePlayerId: "alice", sourceCardIndex: 0, targetPlayerId: "bob", targetCardIndex: 0 },
      ];
      for (const a of attempts) {
        if (!e.processEvent("alice", "USE_POWER", a).error) break;
      }
    }
    assert.equal(e.processEvent("alice", "CALL_SHOWDOWN", undefined).error, undefined);
    assert.equal(e.getState().state, "showdown");

    // The caller is no longer the current turn — every action attempt fails with "Not your turn".
    const draw = e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    assert.match(draw.error ?? "", /Not your turn/);
    const endR = e.processEvent("alice", "END_TURN", undefined);
    assert.match(endR.error ?? "", /Not your turn/);
    const callAgain = e.processEvent("alice", "CALL_SHOWDOWN", undefined);
    assert.match(callAgain.error ?? "", /Not your turn/);

    // Force currentTurn back to the caller to exercise the "Caller gets no more turns" guard directly.
    const state = e.getState();
    const callerIdx = state.players.findIndex((p) => p.id === "alice");
    state.currentTurn = callerIdx;
    const forcedEnd = e.processEvent("alice", "END_TURN", undefined);
    assert.match(forcedEnd.error ?? "", /Caller gets no more turns|Cannot end turn now/);
  });
});

// ───────────────────────────────  Event Log / Replay  ───────────────────────────────

describe("GameEngine — event log & replay", () => {
  function runSomeTurns(engine: GameEngine): void {
    const players = turnOrder(engine);
    const pid = players[0];
    assert.ok(pid);
    engine.processEvent(pid, "DRAW_CARD", { source: "deck" });
    engine.processEvent(pid, "DISCARD_DRAWN", undefined);
    if (engine.getValidEvents(pid).includes("USE_POWER")) {
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: pid },
        { power: "lock", targetPlayerId: pid, cardIndex: 0 },
        {
          power: "joker",
          mimicRank: "10",
          action: { power: "peek", target: "own" },
        },
      ];
      for (const attempt of attempts) {
        const r = engine.processEvent(pid, "USE_POWER", attempt);
        if (!r.error) break;
      }
    }
    engine.processEvent(pid, "END_TURN", undefined);
  }

  it("replaying event log produces identical state", () => {
    const e1 = new GameEngine(makeConfig({ seed: 123 }));
    e1.createGame();
    runSomeTurns(e1);

    const log = e1.getEventLog();
    const e2 = GameEngine.fromEventLog(log, makeConfig({ seed: 123 }));

    const s1 = e1.getState();
    const s2 = e2.getState();
    assert.equal(s1.currentTurn, s2.currentTurn);
    assert.equal(s1.state, s2.state);
    assert.equal(s1.deck.length, s2.deck.length);
    assert.equal(s1.discardPile.length, s2.discardPile.length);
    for (let i = 0; i < s1.players.length; i++) {
      const p1 = s1.players[i];
      const p2 = s2.players[i];
      assert.ok(p1 && p2);
      for (let j = 0; j < HAND_SIZE; j++) {
        const h1: PlayerCard | undefined = p1.hand[j];
        const h2: PlayerCard | undefined = p2.hand[j];
        assert.ok(h1 && h2);
        assert.equal(h1.card.id, h2.card.id);
        assert.equal(h1.locked, h2.locked);
      }
    }
  });
});

// ───────────────────────────────  Visibility  ───────────────────────────────

describe("GameEngine — visibility", () => {
  it("getVisibleState hides opponent cards during play", () => {
    const e = new GameEngine(makeConfig());
    e.createGame();
    const vs = e.getVisibleState("alice");

    // There should be no myHand during in_progress
    assert.equal(vs.myHand, undefined);

    // Opponent should have handSize but no card details
    const bob = vs.players.find((p) => p.id === "bob");
    if (!bob) throw new Error("Bob not found");
    assert.equal(bob.handSize, HAND_SIZE);
  });

  it("discard pile is visible to all", () => {
    const e = new GameEngine(makeConfig());
    e.createGame();
    const players = turnOrder(e);
    const pid = players[0];
    assert.ok(pid);

    e.processEvent(pid, "DRAW_CARD", { source: "deck" });
    e.processEvent(pid, "DISCARD_DRAWN", undefined);

    const vs = e.getVisibleState("bob");
    assert.ok(vs.discardPile.length > 0);
  });

  it("myHand is populated at finished state for every player", () => {
    // Reach finished: each player plays MIN_TURNS_BEFORE_SHOWDOWN turns,
    // then alice calls showdown and the remaining players take their final turn.
    const e = new GameEngine(makeConfig({ playerIds: ["alice", "bob"], seed: 42 }));
    e.createGame();

    const resolveAnyPower = (pid: string): void => {
      if (!e.getValidEvents(pid).includes("USE_POWER")) return;
      const others = turnOrder(e).filter((p) => p !== pid);
      const firstOther = others[0];
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: pid },
        { power: "lock", targetPlayerId: pid, cardIndex: 0 },
        { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
      ];
      if (firstOther) {
        attempts.push({
          power: "swap",
          sourcePlayerId: pid,
          sourceCardIndex: 0,
          targetPlayerId: firstOther,
          targetCardIndex: 0,
        });
      }
      for (const a of attempts) {
        if (!e.processEvent(pid, "USE_POWER", a).error) return;
      }
      throw new Error(`no power attempt succeeded for ${pid}`);
    };

    const runTurn = (pid: string): void => {
      e.processEvent(pid, "DRAW_CARD", { source: "deck" });
      e.processEvent(pid, "DISCARD_DRAWN", undefined);
      resolveAnyPower(pid);
      e.processEvent(pid, "END_TURN", undefined);
    };

    for (let i = 0; i < MIN_TURNS_BEFORE_SHOWDOWN; i++) {
      runTurn("alice");
      runTurn("bob");
    }
    // Alice's showdown-calling turn.
    e.processEvent("alice", "DRAW_CARD", { source: "deck" });
    e.processEvent("alice", "DISCARD_DRAWN", undefined);
    resolveAnyPower("alice");
    e.processEvent("alice", "CALL_SHOWDOWN", undefined);
    runTurn("bob");
    assert.equal(e.getState().state, "finished");

    // Each player's view should reveal their own hand.
    for (const pid of ["alice", "bob"]) {
      const vs = e.getVisibleState(pid);
      assert.ok(vs.myHand, `${pid}'s myHand should be populated at finished`);
      assert.equal(vs.myHand.length, HAND_SIZE);
      const actual = e.getState().players.find((p) => p.id === pid);
      assert.ok(actual);
      for (let i = 0; i < HAND_SIZE; i++) {
        assert.equal(vs.myHand[i]?.index, i);
        assert.equal(vs.myHand[i]?.card.card.id, actual.hand[i]?.card.id);
      }
    }
  });
});

// ───────────────────────────────  Edge Cases  ───────────────────────────────

describe("GameEngine — edge cases", () => {
  it("6-player game works", () => {
    const e = new GameEngine(
      makeConfig({
        playerIds: ["a", "b", "c", "d", "e", "f"],
      }),
    );
    e.createGame();
    // All players should have 4 cards and deck should have 54 - 24 = 30 cards
    assert.equal(e.getState().deck.length, 30);
    assert.equal(e.getState().players.length, 6);
  });

  it("END_TURN not valid in draw phase", () => {
    const e = new GameEngine(makeConfig());
    e.createGame();
    assert.ok(!e.getValidEvents("alice").includes("END_TURN"));
  });

  it("USE_POWER not valid without pending power", () => {
    const e = new GameEngine(makeConfig());
    e.createGame();
    const players = turnOrder(e);
    const p0 = players[0];
    assert.ok(p0);
    const r = e.processEvent(p0, "USE_POWER", {
      power: "peek",
      target: "own",
    });
    assert.ok(r.error);
  });
});

// ───────────────────────────────  Joker Power  ───────────────────────────────

describe("GameEngine — Joker power", () => {
  function setupJoker(): { engine: GameEngine; playerId: string } {
    // Seed 2 for 3 players gives Alice a Joker on her first draw
    const engine = new GameEngine(makeConfig({ seed: 2 }));
    engine.createGame();
    const players = turnOrder(engine);
    const playerId = players[0];
    assert.ok(playerId);

    // Alice draws Joker and discards it
    engine.processEvent(playerId, "DRAW_CARD", { source: "deck" });
    const discR = engine.processEvent(playerId, "DISCARD_DRAWN", undefined);

    if (!discR.validEvents.includes("USE_POWER")) {
      throw new Error("Failed to get Joker power in setup");
    }

    return { engine, playerId };
  }

  it("Mimic Peek (own) — works correctly", () => {
    const { engine, playerId } = setupJoker();

    const result = engine.processEvent(playerId, "USE_POWER", {
      power: "joker",
      mimicRank: "10",
      action: { power: "peek", target: "own" },
    });

    assert.equal(result.error, undefined);
    assert.ok(result.peekResult);
    assert.equal(result.peekResult.playerId, playerId);
    assert.equal(result.peekResult.cards.length, HAND_SIZE);
  });

  it("Mimic Swap — works correctly", () => {
    const { engine, playerId } = setupJoker();
    const players = turnOrder(engine);
    const targetId = players[1];
    assert.ok(targetId);

    const p0 = engine.getState().players[0];
    const p1 = engine.getState().players[1];
    assert.ok(p0 && p1);
    const c0 = p0.hand[0];
    const c1 = p1.hand[0];
    assert.ok(c0 && c1);
    const idA = c0.card.id;
    const idB = c1.card.id;

    const result = engine.processEvent(playerId, "USE_POWER", {
      power: "joker",
      mimicRank: "Q",
      action: {
        power: "swap",
        sourcePlayerId: playerId,
        sourceCardIndex: 0,
        targetPlayerId: targetId,
        targetCardIndex: 0,
      },
    });

    assert.equal(result.error, undefined);
    const p0after = engine.getState().players[0];
    const p1after = engine.getState().players[1];
    assert.ok(p0after && p1after);
    const c0after = p0after.hand[0];
    const c1after = p1after.hand[0];
    assert.ok(c0after && c1after);
    assert.equal(c0after.card.id, idB);
    assert.equal(c1after.card.id, idA);
  });

  it("Mimic Shuffle — works correctly", () => {
    const { engine, playerId } = setupJoker();
    const players = turnOrder(engine);
    const targetId = players[1];
    assert.ok(targetId);

    const p1 = engine.getState().players[1];
    assert.ok(p1);
    const originalHand = p1.hand.map((pc) => pc.card.id).sort();

    const result = engine.processEvent(playerId, "USE_POWER", {
      power: "joker",
      mimicRank: "J",
      action: {
        power: "shuffle",
        targetPlayerId: targetId,
      },
    });

    assert.equal(result.error, undefined);
    const p1after = engine.getState().players[1];
    assert.ok(p1after);
    const newHand = p1after.hand.map((pc) => pc.card.id).sort();
    assert.deepEqual(newHand, originalHand);
  });

  it("Mimic Lock — works correctly", () => {
    const { engine, playerId } = setupJoker();

    const result = engine.processEvent(playerId, "USE_POWER", {
      power: "joker",
      mimicRank: "K",
      action: {
        power: "lock",
        targetPlayerId: playerId,
        cardIndex: 0,
      },
    });

    assert.equal(result.error, undefined);
    const p0 = engine.getState().players[0];
    assert.ok(p0);
    const c0 = p0.hand[0];
    assert.ok(c0);
    assert.ok(c0.locked);
    const visibleState = engine.getVisibleState(playerId);
    const marker0 = visibleState.lockMarkers[0];
    assert.ok(marker0);
    assert.equal(marker0.markerCard.rank, "JOKER");
    // The mimicking Joker must move out of the discard pile into lockMarkers.
    assert.ok(
      !engine.getState().discardPile.some((c) => c.id === marker0.markerCard.id),
      "Joker mimic-K marker must not be in the discard pile after lock is applied",
    );
  });

  it("rejects non-joker action when power is Joker", () => {
    const { engine, playerId } = setupJoker();

    const invalidAction: PowerAction = {
      power: "peek",
      target: "own",
    };

    const result = engine.processEvent(playerId, "USE_POWER", invalidAction);

    assert.ok(result.error);
    assert.match(result.error, /Expected power action "joker"/);
  });

  it("rejects joker action without inner action", () => {
    const { engine, playerId } = setupJoker();

    // @ts-expect-error - missing inner action
    const invalidJokerAction: PowerAction = {
      power: "joker",
      mimicRank: "10",
    };

    const result = engine.processEvent(playerId, "USE_POWER", invalidJokerAction);
    assert.ok(result.error);
    assert.match(result.error, /missing inner action/);
  });
});

// ───────────────────────────────  Winners  ───────────────────────────────

describe("GameEngine — winners", () => {
  /** Plays one full turn for `pid`, resolving any power that triggers. */
  function playTurn(engine: GameEngine, pid: string): void {
    engine.processEvent(pid, "DRAW_CARD", { source: "deck" });
    engine.processEvent(pid, "DISCARD_DRAWN", undefined);
    if (engine.getValidEvents(pid).includes("USE_POWER")) {
      const others = turnOrder(engine).filter((p) => p !== pid);
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: pid },
        { power: "lock", targetPlayerId: pid, cardIndex: 0 },
        { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
      ];
      const firstOther = others[0];
      if (firstOther) {
        attempts.push({
          power: "swap",
          sourcePlayerId: pid,
          sourceCardIndex: 0,
          targetPlayerId: firstOther,
          targetCardIndex: 0,
        });
      }
      for (const a of attempts) {
        const r = engine.processEvent(pid, "USE_POWER", a);
        if (!r.error) break;
      }
    }
    engine.processEvent(pid, "END_TURN", undefined);
  }

  /** Plays the caller's showdown-calling turn (draw → discard → resolve power → CALL_SHOWDOWN). */
  function callShowdown(engine: GameEngine, callerId: string): void {
    engine.processEvent(callerId, "DRAW_CARD", { source: "deck" });
    engine.processEvent(callerId, "DISCARD_DRAWN", undefined);
    if (engine.getValidEvents(callerId).includes("USE_POWER")) {
      const others = turnOrder(engine).filter((p) => p !== callerId);
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: callerId },
        { power: "lock", targetPlayerId: callerId, cardIndex: 0 },
        { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
      ];
      const firstOther = others[0];
      if (firstOther) {
        attempts.push({
          power: "swap",
          sourcePlayerId: callerId,
          sourceCardIndex: 0,
          targetPlayerId: firstOther,
          targetCardIndex: 0,
        });
      }
      for (const a of attempts) {
        const r = engine.processEvent(callerId, "USE_POWER", a);
        if (!r.error) break;
      }
    }
    const callR = engine.processEvent(callerId, "CALL_SHOWDOWN", undefined);
    assert.equal(callR.error, undefined);
  }

  /** Reaches finished state with player 0 as caller. */
  function playToFinished(playerIds: string[], seed: number): GameEngine {
    const e = new GameEngine(makeConfig({ playerIds, seed }));
    e.createGame();
    for (let i = 0; i < MIN_TURNS_BEFORE_SHOWDOWN; i++) {
      for (const pid of playerIds) playTurn(e, pid);
    }
    const callerId = playerIds[0];
    assert.ok(callerId);
    callShowdown(e, callerId);
    for (const pid of playerIds.slice(1)) playTurn(e, pid);
    assert.equal(e.getState().state, "finished");
    return e;
  }

  /** Overwrites a player's hand-card values to set up a known total. */
  function setHandValues(engine: GameEngine, playerIdx: number, values: number[]): void {
    const player = engine.getState().players[playerIdx];
    assert.ok(player);
    for (let i = 0; i < HAND_SIZE; i++) {
      const pc = player.hand[i];
      assert.ok(pc);
      const v = values[i];
      assert.ok(v !== undefined);
      pc.card = { ...pc.card, value: v };
    }
  }

  it("returns empty array when game is not finished", () => {
    const e = new GameEngine(makeConfig());
    e.createGame();
    assert.deepEqual(e.winners, []);
  });

  it("caller wins when their total is strictly lowest", () => {
    const e = playToFinished(["alice", "bob"], 42);
    setHandValues(e, 0, [1, 1, 1, 1]); // alice (caller): 4
    setHandValues(e, 1, [5, 5, 5, 5]); // bob: 20
    assert.deepEqual(
      e.winners.map((p) => p.id),
      ["alice"],
    );
  });

  it("caller loses on a tie — tied non-caller wins", () => {
    const e = playToFinished(["alice", "bob"], 42);
    setHandValues(e, 0, [5, 5, 5, 5]); // alice (caller): 20
    setHandValues(e, 1, [5, 5, 5, 5]); // bob: 20 (tied)
    assert.deepEqual(
      e.winners.map((p) => p.id),
      ["bob"],
    );
  });

  it("non-caller with strictly lower total wins outright", () => {
    const e = playToFinished(["alice", "bob"], 42);
    setHandValues(e, 0, [10, 10, 10, 10]); // alice (caller): 40
    setHandValues(e, 1, [1, 1, 1, 1]); // bob: 4
    assert.deepEqual(
      e.winners.map((p) => p.id),
      ["bob"],
    );
  });

  it("multiple non-callers tied for lowest both win; caller excluded", () => {
    const e = playToFinished(["alice", "bob", "charlie"], 42);
    setHandValues(e, 0, [10, 10, 10, 10]); // alice (caller): 40
    setHandValues(e, 1, [1, 1, 1, 1]); // bob: 4
    setHandValues(e, 2, [1, 1, 1, 1]); // charlie: 4
    assert.deepEqual(e.winners.map((p) => p.id).sort(), ["bob", "charlie"]);
  });

  it("caller wins solo when tied with caller alone (single-player tie group is caller)", () => {
    // Edge case: only the caller has the lowest total; no tie group, so caller is not excluded.
    const e = playToFinished(["alice", "bob"], 42);
    setHandValues(e, 0, [2, 2, 2, 2]); // alice (caller): 8
    setHandValues(e, 1, [3, 3, 3, 3]); // bob: 12
    assert.deepEqual(
      e.winners.map((p) => p.id),
      ["alice"],
    );
  });
});
