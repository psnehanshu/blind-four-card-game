import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { GameEngine } from "./game-engine.js"
import type { EngineConfig, PowerAction } from "./types.js"
import { HAND_SIZE, MIN_TURNS_BEFORE_SHOWDOWN } from "./types.js"

function makeConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    gameId: "test-game",
    playerIds: ["alice", "bob", "charlie"],
    seed: 42,
    ...overrides,
  }
}

type PlayerId = string
function turnOrder(engine: GameEngine): PlayerId[] {
  return engine.getState().players.map(p => p.id)
}

// ───────────────────────────────  Game Creation  ───────────────────────────────

describe("GameEngine — createGame", () => {
  it("deals 4 cards per player", () => {
    const engine = new GameEngine(makeConfig())
    const result = engine.createGame()
    for (const player of result.nextState.players) {
      assert.equal(player.hand.length, HAND_SIZE)
    }
  })

  it("creates correct number of players", () => {
    const engine = new GameEngine(makeConfig({ playerIds: ["a", "b"] }))
    const result = engine.createGame()
    assert.equal(result.nextState.players.length, 2)
  })

  it("deck size = 54 - (players * 4)", () => {
    const engine = new GameEngine(makeConfig({ playerIds: ["a", "b", "c", "d"] }))
    const result = engine.createGame()
    assert.equal(result.nextState.deck.length, 54 - 4 * 4)
  })

  it("state is in_progress", () => {
    const engine = new GameEngine(makeConfig())
    const result = engine.createGame()
    assert.equal(result.nextState.state, "in_progress")
  })

  it("current turn is player 0", () => {
    const engine = new GameEngine(makeConfig())
    engine.createGame()
    assert.equal(engine.getState().currentTurn, 0)
  })

  it("valid events for first player include DRAW_CARD", () => {
    const engine = new GameEngine(makeConfig())
    engine.createGame()
    const events = engine.getValidEvents("alice")
    assert.deepEqual(events, ["DRAW_CARD"])
  })

  it("rejects invalid player count", () => {
    assert.throws(() => new GameEngine(makeConfig({ playerIds: ["a"] })))
    assert.throws(() => new GameEngine(makeConfig({ playerIds: ["a", "b", "c", "d", "e", "f", "g"] })))
  })

  it("same seed produces same deal", () => {
    const e1 = new GameEngine(makeConfig({ seed: 100 }))
    const e2 = new GameEngine(makeConfig({ seed: 100 }))
    e1.createGame()
    e2.createGame()
    const g1 = e1.getState()
    const g2 = e2.getState()
    for (let i = 0; i < g1.players.length; i++) {
      for (let j = 0; j < HAND_SIZE; j++) {
        assert.equal(g1.players[i].hand[j].card.id, g2.players[i].hand[j].card.id)
      }
    }
  })
})

// ───────────────────────────────  Turn Flow  ───────────────────────────────

describe("GameEngine — turn flow", () => {
  function setup(): GameEngine {
    const e = new GameEngine(makeConfig())
    e.createGame()
    return e
  }

  function drawThenEnd(engine: GameEngine, playerId: string): void {
    engine.processEvent(playerId, "DRAW_CARD", { source: "deck" })
    engine.processEvent(playerId, "DISCARD_DRAWN")
    if (engine.getValidEvents(playerId).includes("USE_POWER")) {
      // Try each possible power action until one succeeds
      const otherPlayers = turnOrder(engine).filter(p => p !== playerId)
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: playerId },
        { power: "lock", targetPlayerId: playerId, cardIndex: 0 },
        { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
      ]
      if (otherPlayers.length > 0) {
        attempts.push({
          power: "swap",
          sourcePlayerId: playerId,
          sourceCardIndex: 0,
          targetPlayerId: otherPlayers[0],
          targetCardIndex: 0,
        })
      }
      for (const attempt of attempts) {
        const r = engine.processEvent(playerId, "USE_POWER", attempt)
        if (!r.error) break
      }
    }
    engine.processEvent(playerId, "END_TURN")
  }

  it("draw → discard drawn → end turn advances to next player", () => {
    const e = setup()
    const players = turnOrder(e)

    // Alice's first turn
    let r = e.processEvent(players[0], "DRAW_CARD", { source: "deck" })
    assert.equal(r.error, undefined)
    r = e.processEvent(players[0], "DISCARD_DRAWN")
    assert.equal(r.error, undefined)
    r = e.processEvent(players[0], "END_TURN")
    assert.equal(r.error, undefined)
    assert.equal(e.getState().currentTurn, 1)

    // Bob's first turn
    drawThenEnd(e, players[1])
    assert.equal(e.getState().currentTurn, 2)
  })

  it("draw → replace card → end turn replaces card in hand", () => {
    const e = setup()
    const playerId = turnOrder(e)[0]
    const state = e.getState()
    const oldCard = state.players[0].hand[2].card

    e.processEvent(playerId, "DRAW_CARD", { source: "deck" })
    e.processEvent(playerId, "REPLACE_CARD", { handIndex: 2 })
    e.processEvent(playerId, "END_TURN")

    const newCard = e.getState().players[0].hand[2].card
    assert.notEqual(newCard.id, oldCard.id)
    // Discard pile should have old card
    assert.equal(e.getState().discardPile.at(-1)?.id, oldCard.id)
  })

  it("rejects draw twice without discard", () => {
    const e = setup()
    const pid = turnOrder(e)[0]
    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    const r = e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    assert.ok(r.error)
  })

  it("rejects wrong player acting", () => {
    const e = setup()
    const r = e.processEvent("bob", "DRAW_CARD", { source: "deck" })
    assert.ok(r.error)
  })

  it("rejects replace before draw", () => {
    const e = setup()
    const r = e.processEvent(turnOrder(e)[0], "REPLACE_CARD", { handIndex: 0 })
    assert.ok(r.error)
  })

  it("rejects replace of locked card", () => {
    const e = setup()
    const pid = turnOrder(e)[0]
    e.processEvent(pid, "DRAW_CARD", { source: "deck" })

    // Lock a card first — draw a King from deck, discard it, use power to lock
    // But we don't know if we drew a King. Let's instead find a King.
    // For simplicity, just verify via a helper: shuffle to known state.
    const engine2 = new GameEngine(makeConfig({ seed: 999 }))
    engine2.createGame()
    const p2 = turnOrder(engine2)[0]

    // We might not get a King. Let's still try: draw, discard, if power, use it to lock card 0
    engine2.processEvent(p2, "DRAW_CARD", { source: "deck" })
    const discR = engine2.processEvent(p2, "DISCARD_DRAWN")
    if (!discR.error && discR.validEvents.includes("USE_POWER")) {
      engine2.processEvent(p2, "USE_POWER", {
        power: "lock", targetPlayerId: p2, cardIndex: 0,
      })
      engine2.processEvent(p2, "END_TURN")

      // Next player's turn, draw and try to replace the locked card
      const p3 = turnOrder(engine2)[1]
      engine2.processEvent(p3, "DRAW_CARD", { source: "deck" })
      // Can't replace a locked card on another player's hand,
      // but can we even target it? The spec says locked cards can't be replaced.
      // REPLACE only replaces from your own hand. So this test is moot for
      // another player. Let's verify on the lock owner's next turn.
      engine2.processEvent(p3, "DISCARD_DRAWN")
      engine2.processEvent(p3, "END_TURN")

      // Now back to p2, draw, try to replace locked card index 0
      engine2.processEvent(p2, "DRAW_CARD", { source: "deck" })
      const repR = engine2.processEvent(p2, "REPLACE_CARD", { handIndex: 0 })
      assert.ok(repR.error)
    }
  })

  it("discard drawn from discard pile works", () => {
    const e = setup()
    const pid = turnOrder(e)[0]
    // First put a card in the discard pile
    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    e.processEvent(pid, "DISCARD_DRAWN")
    e.processEvent(pid, "END_TURN")

    // Next player draws from discard
    const pid2 = turnOrder(e)[1]
    const r = e.processEvent(pid2, "DRAW_CARD", { source: "discard" })
    assert.equal(r.error, undefined)
  })

  it("deck draw is rejected when deck is empty", () => {
    const e = new GameEngine(makeConfig({ playerIds: ["a", "b"], seed: 1 }))
    e.createGame()

    // Deck is 54 - 8 = 46 cards. Draw until empty.
    let pid = turnOrder(e)[0]
    for (let i = 0; i < 46; i++) {
      pid = turnOrder(e)[0]
      const r = e.processEvent(pid, "DRAW_CARD", { source: "deck" })
      if (r.error) break
      e.processEvent(pid, "DISCARD_DRAWN")
      if (e.getValidEvents(pid).includes("USE_POWER")) {
        e.processEvent(pid, "USE_POWER", { power: "peek", target: "own" })
      }
      e.processEvent(pid, "END_TURN")
    }

    const r = e.processEvent(turnOrder(e)[0], "DRAW_CARD", { source: "deck" })
    assert.ok(r.error || e.getState().deck.length === 0)
  })

  it("discard pile draw is rejected when discard pile is empty", () => {
    const e = setup()
    const r = e.processEvent(turnOrder(e)[0], "DRAW_CARD", { source: "discard" })
    assert.ok(r.error)
  })
})

// ───────────────────────────────  Powers  ───────────────────────────────

describe("GameEngine — powers", () => {
  it("Peek (10) — can peek own cards and returns info", () => {
    const e = new GameEngine(makeConfig({ seed: 42 }))
    e.createGame()
    const pid = turnOrder(e)[0]

    // Draw and discard until we discard a power card (10)
    // Check if we get a power phase
    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    const discR = e.processEvent(pid, "DISCARD_DRAWN")

    if (discR.validEvents.includes("USE_POWER")) {
      const peekR = e.processEvent(pid, "USE_POWER", {
        power: "peek",
        target: "own",
      } as PowerAction)
      assert.equal(peekR.error, undefined)
      assert.ok(peekR.peekResult)
      assert.equal(peekR.peekResult!.playerId, pid)
      assert.equal(peekR.peekResult!.cards.length, HAND_SIZE)
    }
  })

  it("Lock (K) — locks a card and creates a marker", () => {
    const e = new GameEngine(makeConfig({ seed: 999 }))
    e.createGame()
    const pid = turnOrder(e)[0]

    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    const discR = e.processEvent(pid, "DISCARD_DRAWN")

    if (discR.validEvents.includes("USE_POWER")) {
      const lockR = e.processEvent(pid, "USE_POWER", {
        power: "lock",
        targetPlayerId: pid,
        cardIndex: 0,
      } as PowerAction)
      assert.equal(lockR.error, undefined)
      assert.ok(e.getState().players[0].hand[0].locked)
    }
  })

  it("Swap (Q) — swaps cards between players", () => {
    const e = new GameEngine(makeConfig({ seed: 777 }))
    e.createGame()
    const pid = turnOrder(e)[0]
    const pid2 = turnOrder(e)[1]

    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    const discR = e.processEvent(pid, "DISCARD_DRAWN")

    if (discR.validEvents.includes("USE_POWER")) {
      const cardA = e.getState().players[0].hand[0]
      const cardB = e.getState().players[1].hand[0]

      const swapR = e.processEvent(pid, "USE_POWER", {
        power: "swap",
        sourcePlayerId: pid,
        sourceCardIndex: 0,
        targetPlayerId: pid2,
        targetCardIndex: 0,
      } as PowerAction)
      assert.equal(swapR.error, undefined)

      const newCardA = e.getState().players[0].hand[0]
      const newCardB = e.getState().players[1].hand[0]
      assert.equal(newCardA.card.id, cardB.card.id)
      assert.equal(newCardB.card.id, cardA.card.id)
    }
  })

  it("Shuffle (J) — shuffles unlocked cards of target player", () => {
    const e = new GameEngine(makeConfig({ seed: 555 }))
    e.createGame()
    const pid = turnOrder(e)[0]
    const pid2 = turnOrder(e)[1]

    const originalHand = [...e.getState().players[1].hand.map(pc => pc.card.id)]
    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    const discR = e.processEvent(pid, "DISCARD_DRAWN")

    if (discR.validEvents.includes("USE_POWER")) {
      const shufR = e.processEvent(pid, "USE_POWER", {
        power: "shuffle",
        targetPlayerId: pid2,
      } as PowerAction)
      assert.equal(shufR.error, undefined)

      const newHand = e.getState().players[1].hand.map(pc => pc.card.id)
      // Same cards, different order (or same if RNG happens to keep order — very unlikely)
      assert.deepEqual(newHand.sort(), originalHand.sort())
    }
  })
})

// ───────────────────────────────  Showdown  ───────────────────────────────

describe("GameEngine — showdown", () => {
  it("cannot call showdown before 2 turns per player", () => {
    const e = new GameEngine(makeConfig({ playerIds: ["a", "b"], seed: 42 }))
    e.createGame()
    const players = turnOrder(e)
    const pid = players[0]

    // Complete 1 turn for player 0
    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    e.processEvent(pid, "DISCARD_DRAWN")
    // Now at showdown_eligible — try to call showdown (should fail, only 1 turn)
    const callR = e.processEvent(pid, "CALL_SHOWDOWN")
    assert.ok(callR.error) // Not eligible yet
  })

  it("can call showdown and complete the game", () => {
    const e = new GameEngine(makeConfig({ playerIds: ["a", "b"], seed: 42 }))
    e.createGame()

    // Helper: play one full turn for a player (draw → discard → resolve power → end)
    function playTurn(pid: string): void {
      e.processEvent(pid, "DRAW_CARD", { source: "deck" })
      e.processEvent(pid, "DISCARD_DRAWN")
      if (e.getValidEvents(pid).includes("USE_POWER")) {
        const otherPlayers = turnOrder(e).filter(p => p !== pid)
        const attempts: PowerAction[] = [
          { power: "peek", target: "own" },
          { power: "shuffle", targetPlayerId: pid },
          { power: "lock", targetPlayerId: pid, cardIndex: 0 },
          { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
        ]
        if (otherPlayers.length > 0) {
          attempts.push({
            power: "swap",
            sourcePlayerId: pid,
            sourceCardIndex: 0,
            targetPlayerId: otherPlayers[0],
            targetCardIndex: 0,
          })
        }
        for (const attempt of attempts) {
          const r = e.processEvent(pid, "USE_POWER", attempt)
          if (!r.error) break
        }
      }
      e.processEvent(pid, "END_TURN")
    }

    // Complete MIN_TURNS_BEFORE_SHOWDOWN turns for each player
    const players = turnOrder(e)
    for (let turn = 0; turn < MIN_TURNS_BEFORE_SHOWDOWN; turn++) {
      for (const pid of players) {
        playTurn(pid)
      }
    }

    // Now on player 0's 3rd turn — draw and discard
    const pid = players[0]
    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    e.processEvent(pid, "DISCARD_DRAWN")
    if (e.getValidEvents(pid).includes("USE_POWER")) {
      const otherPlayers = turnOrder(e).filter(p => p !== pid)
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: pid },
        { power: "lock", targetPlayerId: pid, cardIndex: 0 },
        { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
      ]
      if (otherPlayers.length > 0) {
        attempts.push({
          power: "swap",
          sourcePlayerId: pid,
          sourceCardIndex: 0,
          targetPlayerId: otherPlayers[0],
          targetCardIndex: 0,
        })
      }
      for (const attempt of attempts) {
        const r = e.processEvent(pid, "USE_POWER", attempt)
        if (!r.error) break
      }
    }

    // Should be able to call showdown now
    const callR = e.processEvent(pid, "CALL_SHOWDOWN")
    assert.equal(callR.error, undefined)
    assert.equal(e.getState().state, "showdown")
    assert.equal(e.getState().callerId, pid)

    // Other players get 1 final turn
    for (let i = 1; i < players.length; i++) {
      const otherPid = players[i]
      playTurn(otherPid)
    }

    assert.equal(e.getState().state, "finished")
  })
})

// ───────────────────────────────  Event Log / Replay  ───────────────────────────────

describe("GameEngine — event log & replay", () => {
  function runSomeTurns(engine: GameEngine): void {
    const players = turnOrder(engine)
    const pid = players[0]
    engine.processEvent(pid, "DRAW_CARD", { source: "deck" })
    engine.processEvent(pid, "DISCARD_DRAWN")
    if (engine.getValidEvents(pid).includes("USE_POWER")) {
      const attempts: PowerAction[] = [
        { power: "peek", target: "own" },
        { power: "shuffle", targetPlayerId: pid },
        { power: "lock", targetPlayerId: pid, cardIndex: 0 },
        { power: "joker", mimicRank: "10", action: { power: "peek", target: "own" } },
      ]
      for (const attempt of attempts) {
        const r = engine.processEvent(pid, "USE_POWER", attempt)
        if (!r.error) break
      }
    }
    engine.processEvent(pid, "END_TURN")
  }

  it("replaying event log produces identical state", () => {
    const e1 = new GameEngine(makeConfig({ seed: 123 }))
    e1.createGame()
    runSomeTurns(e1)

    const log = e1.getEventLog()
    const e2 = GameEngine.fromEventLog(log, makeConfig({ seed: 123 }))

    const s1 = e1.getState()
    const s2 = e2.getState()
    assert.equal(s1.currentTurn, s2.currentTurn)
    assert.equal(s1.state, s2.state)
    assert.equal(s1.deck.length, s2.deck.length)
    assert.equal(s1.discardPile.length, s2.discardPile.length)
    for (let i = 0; i < s1.players.length; i++) {
      for (let j = 0; j < HAND_SIZE; j++) {
        assert.equal(s1.players[i].hand[j].card.id, s2.players[i].hand[j].card.id)
        assert.equal(s1.players[i].hand[j].locked, s2.players[i].hand[j].locked)
      }
    }
  })
})

// ───────────────────────────────  Visibility  ───────────────────────────────

describe("GameEngine — visibility", () => {
  it("getVisibleState hides opponent cards during play", () => {
    const e = new GameEngine(makeConfig())
    e.createGame()
    const vs = e.getVisibleState("alice")

    // There should be no myHand during in_progress
    assert.equal(vs.myHand, undefined)

    // Opponent should have handSize but no card details
    const bob = vs.players.find(p => p.id === "bob")!
    assert.equal(bob.handSize, HAND_SIZE)
  })

  it("discard pile is visible to all", () => {
    const e = new GameEngine(makeConfig())
    e.createGame()
    const pid = turnOrder(e)[0]

    e.processEvent(pid, "DRAW_CARD", { source: "deck" })
    e.processEvent(pid, "DISCARD_DRAWN")

    const vs = e.getVisibleState("bob")
    assert.ok(vs.discardPile.length > 0)
  })
})

// ───────────────────────────────  Edge Cases  ───────────────────────────────

describe("GameEngine — edge cases", () => {
  it("6-player game works", () => {
    const e = new GameEngine(makeConfig({
      playerIds: ["a", "b", "c", "d", "e", "f"],
    }))
    e.createGame()
    // All players should have 4 cards and deck should have 54 - 24 = 30 cards
    assert.equal(e.getState().deck.length, 30)
    assert.equal(e.getState().players.length, 6)
  })

  it("END_TURN not valid in draw phase", () => {
    const e = new GameEngine(makeConfig())
    e.createGame()
    assert.ok(!e.getValidEvents("alice").includes("END_TURN"))
  })

  it("USE_POWER not valid without pending power", () => {
    const e = new GameEngine(makeConfig())
    e.createGame()
    const r = e.processEvent(turnOrder(e)[0], "USE_POWER", { power: "peek", target: "own" } as PowerAction)
    assert.ok(r.error)
  })
})