import type {
  Card, Game, Player, PlayerCard, TurnPhase,
  ProposedEventType, CommittedEvent, EngineConfig,
  PowerAction, EngineResult, LockMarker, PeekResult,
  VisibleGameState, VisiblePlayerState, Rank,
} from "./types.js"
import { HAND_SIZE, MIN_PLAYERS, MAX_PLAYERS, MIN_TURNS_BEFORE_SHOWDOWN } from "./types.js"
import { createDeck, isPowerCard } from "./cards.js"
import { SeededRNG } from "./rng.js"

let eventIdCounter = 0

/** Maps card rank → expected action name for USE_POWER. */
const POWER_ACTION_MAP: Record<string, string> = {
  "10": "peek",
  J: "shuffle",
  Q: "swap",
  K: "lock",
  JOKER: "joker",
}

export class GameEngine {
  private config: EngineConfig
  private game!: Game
  private eventLog: CommittedEvent[]
  private rng: SeededRNG

  // Internal turn-phase tracking
  private phase: TurnPhase
  private drawnCard: Card | null
  private totalTurnsTaken: number
  private playerTurnCount: Map<string, number>
  private pendingPowerRank: Rank | null
  private lockMarkers: LockMarker[]
  private playersCompletedFinalTurn: Set<string>
  private lastPeekResult: PeekResult | null

  constructor(config: EngineConfig) {
    if (config.playerIds.length < MIN_PLAYERS || config.playerIds.length > MAX_PLAYERS) {
      throw new Error(`Player count must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`)
    }
    this.config = { ...config }
    this.rng = new SeededRNG(config.seed ?? Date.now())
    this.eventLog = []
    this.phase = "draw"
    this.drawnCard = null
    this.totalTurnsTaken = 0
    this.playerTurnCount = new Map()
    this.pendingPowerRank = null
    this.lockMarkers = []
    this.playersCompletedFinalTurn = new Set()
    this.lastPeekResult = null
  }

  // ────────────────────────────── Public API ──────────────────────────────

  /** Create a game and deal cards. Returns the initial state. */
  createGame(): EngineResult {
    this.game = this.buildInitialGame()
    this.phase = "draw"
    return this.buildResult([])
  }

  /** Process a player action. Validates → commits → reduces → returns result. */
  processEvent(
    playerId: string,
    eventType: ProposedEventType,
    payload?: unknown,
  ): EngineResult {
    const error = this.validateEvent(playerId, eventType, payload)
    if (error) {
      return { ...this.buildResult([]), error }
    }

    const event: CommittedEvent = {
      id: `evt-${eventIdCounter++}`,
      sequence: this.eventLog.length,
      timestamp: Date.now(),
      playerId,
      type: eventType,
      payload,
    }

    this.eventLog.push(event)
    this.applyEvent(event)

    return this.buildResult([event])
  }

  /** Current game state (public fields only). */
  getState(): Game {
    return this.game
  }

  /** Event log for replay. */
  getEventLog(): CommittedEvent[] {
    return [...this.eventLog]
  }

  /** What events this player can perform right now. */
  getValidEvents(playerId: string): ProposedEventType[] {
    const valid: ProposedEventType[] = []

    // Must be this player's turn
    if (this.game.players[this.game.currentTurn].id !== playerId) return valid

    if (this.game.state === "finished") return valid

    switch (this.phase) {
      case "draw":
        valid.push("DRAW_CARD")
        break
      case "decision":
        valid.push("REPLACE_CARD", "DISCARD_DRAWN")
        break
      case "power":
        valid.push("USE_POWER")
        break
      case "showdown_eligible":
        if (
          this.game.state !== "showdown" &&
          this.isShowdownEligible()
        ) {
          valid.push("CALL_SHOWDOWN")
        }
        if (this.game.state !== "showdown" || playerId !== this.game.callerId) {
          valid.push("END_TURN")
        }
        break
    }

    return valid
  }

  /** State filtered for one player (respects visibility rules). */
  getVisibleState(playerId: string): VisibleGameState {
    const player = this.game.players.find(p => p.id === playerId)
    const players: VisiblePlayerState[] = []

    for (const p of this.game.players) {
      const lockedCards = this.lockMarkers
        .filter(lm => lm.playerId === p.id)
        .map(lm => ({ index: lm.cardIndex, markerCard: lm.markerCard }))

      players.push({
        id: p.id,
        name: p.name,
        lockedCards,
        handSize: p.hand.length,
        isCurrentTurn: this.game.players[this.game.currentTurn].id === p.id,
      })
    }

    const result: VisibleGameState = {
      id: this.game.id,
      state: this.game.state,
      players,
      discardPile: [...this.game.discardPile],
      deckSize: this.game.deck.length,
      currentTurn: this.game.currentTurn,
      callerId: this.game.callerId,
      lockMarkers: [...this.lockMarkers],
    }

    // Show own hand during initial_reveal or finished state
    if (player) {
      if (this.game.state === "initial_reveal" || this.game.state === "finished") {
        result.myHand = player.hand.map((pc, i) => ({ index: i, card: pc }))
      }
    }

    return result
  }

  /** Build engine from a prior event log (replay). */
  static fromEventLog(eventLog: CommittedEvent[], config: EngineConfig): GameEngine {
    const engine = new GameEngine(config)
    engine.createGame()
    for (const event of eventLog) {
      engine.applyEvent(event)
    }
    return engine
  }

  // ────────────────────────── Private: Validation ──────────────────────────

  private validateEvent(
    playerId: string,
    eventType: ProposedEventType,
    payload?: unknown,
  ): string | null {
    if (this.game.state === "finished") return "Game is already finished"

    const currentPlayer = this.game.players[this.game.currentTurn]
    if (currentPlayer.id !== playerId) return "Not your turn"

    // Phase-based validation
    switch (eventType) {
      case "DRAW_CARD":
        if (this.phase !== "draw") return "Must be in draw phase"
        if (this.drawnCard) return "Already drew this turn"
        {
          const source = (payload as { source?: string })?.source ?? "deck"
          if (source === "discard") {
            if (this.game.discardPile.length === 0) return "Discard pile is empty"
          } else if (this.game.deck.length === 0) return "Deck is empty"
        }
        break
      case "REPLACE_CARD":
      case "DISCARD_DRAWN":
        if (this.phase !== "decision") return "Must replace or discard drawn card"
        if (!this.drawnCard) return "No card drawn yet"
        break
      case "USE_POWER":
        if (this.phase !== "power") return "No power to resolve"
        if (!this.pendingPowerRank) return "No pending power"
        {
          const action = (payload as PowerAction)
          if (!action?.power) return "Invalid power action"
          const expected = POWER_ACTION_MAP[this.pendingPowerRank]
          if (action.power !== expected) {
            return `Expected power action "${expected}" but got "${action.power}"`
          }
        }
        break
      case "CALL_SHOWDOWN":
        if (this.phase !== "showdown_eligible") return "Cannot call showdown now"
        if (this.game.state === "showdown") return "Showdown already in progress"
        if (!this.isShowdownEligible()) return "Must complete 2 turns each before showdown"
        break
      case "END_TURN":
        if (this.phase !== "showdown_eligible") return "Cannot end turn now"
        if (this.game.state === "showdown" && playerId === this.game.callerId) {
          return "Caller gets no more turns"
        }
        break
    }

    return null
  }

  // ────────────────────────── Private: Event Reducer ──────────────────────

  private applyEvent(event: CommittedEvent): void {
    switch (event.type) {
      case "DRAW_CARD":
        return this.applyDraw(event)
      case "REPLACE_CARD":
        return this.applyReplace(event)
      case "DISCARD_DRAWN":
        return this.applyDiscardDrawn(event)
      case "CALL_SHOWDOWN":
        return this.applyCallShowdown(event)
      case "USE_POWER":
        return this.applyUsePower(event)
      case "END_TURN":
        return this.applyEndTurn(event)
    }
  }

  private applyDraw(event: CommittedEvent): void {
    const source = (event.payload as { source?: string })?.source ?? "deck"
    let drawn: Card

    if (source === "discard") {
      const card = this.game.discardPile.pop()
      if (!card) throw new Error("Discard pile is empty")
      drawn = card
    } else {
      const card = this.game.deck.pop()
      if (!card) throw new Error("Deck is empty")
      drawn = card
    }

    this.drawnCard = drawn
    this.phase = "decision"
  }

  private applyReplace(event: CommittedEvent): void {
    const handIndex = (event.payload as { handIndex?: number })?.handIndex
    if (handIndex === undefined || handIndex < 0 || handIndex >= HAND_SIZE) {
      throw new Error("Invalid hand index")
    }

    const player = this.game.players[this.game.currentTurn]
    const target = player.hand[handIndex]
    if (target.locked) throw new Error("Cannot replace a locked card")

    // Put drawn card in hand, old card goes to discard
    const drawnCard = this.drawnCard!
    player.hand[handIndex] = { card: drawnCard, locked: false }
    this.drawnCard = null

    // Discard the replaced card and check for power
    this.discardAndCheckPower(target.card)
  }

  private applyDiscardDrawn(_event: CommittedEvent): void {
    const drawnCard = this.drawnCard!
    this.drawnCard = null
    this.discardAndCheckPower(drawnCard)
  }

  private applyCallShowdown(_event: CommittedEvent): void {
    const callerId = this.game.players[this.game.currentTurn].id
    this.game.state = "showdown"
    this.game.callerId = callerId
    this.playersCompletedFinalTurn.add(callerId)
    this.advanceTurn()
  }

  private applyUsePower(event: CommittedEvent): void {
    const action = event.payload as PowerAction
    if (!action || !action.power) throw new Error("Invalid power action")

    // Determine effective power (handle joker mimic)
    let effectiveAction: PowerAction
    if (action.power === "joker") {
      effectiveAction = action.action!
    } else {
      effectiveAction = action
    }

    switch (effectiveAction.power) {
      case "peek":
        this.applyPeek(effectiveAction)
        break
      case "shuffle":
        this.applyShuffle(effectiveAction)
        break
      case "swap":
        this.applySwap(effectiveAction)
        break
      case "lock":
        this.applyLock(effectiveAction)
        break
    }

    this.pendingPowerRank = null
    this.phase = "showdown_eligible"
  }

  private applyEndTurn(_event: CommittedEvent): void {
    this.advanceTurn()
  }

  // ────────────────────── Private: Power Resolution ────────────────────────

  private applyPeek(action: PowerAction): void {
    if (action.power !== "peek") return

    if (action.target === "own") {
      const player = this.game.players[this.game.currentTurn]
      this.lastPeekResult = {
        playerId: player.id,
        cards: player.hand.map((pc, i) => ({ index: i, card: pc.card })),
      }
    } else if (action.target === "opponent" && action.opponentId) {
      const opponent = this.game.players.find(p => p.id === action.opponentId)
      if (!opponent) throw new Error("Invalid opponent")

      // Peek at 1 random opponent card (or the first, since the player can choose)
      // The spec says "1 opponent card" — let's return all for the player to see
      // but only 1 card's data. Actually, let's return the first unlocked card.
      const unlockedIdx = opponent.hand.findIndex(pc => !pc.locked)
      if (unlockedIdx === -1) throw new Error("No unlocked cards to peek at")
      this.lastPeekResult = {
        playerId: opponent.id,
        cards: [{ index: unlockedIdx, card: opponent.hand[unlockedIdx].card }],
      }
    }
  }

  private applyShuffle(action: PowerAction): void {
    if (action.power !== "shuffle") return
    const targetPlayer = this.game.players.find(p => p.id === action.targetPlayerId)
    if (!targetPlayer) throw new Error("Invalid target player")

    // Shuffle only unlocked card positions (lock states are preserved)
    const unlockedIndices = targetPlayer.hand
      .map((pc, i) => ({ pc, i }))
      .filter(x => !x.pc.locked)
      .map(x => x.i)

    const unlockedCards = unlockedIndices.map(i => targetPlayer.hand[i])
    const shuffled = this.rng.shuffle(unlockedCards)

    for (let k = 0; k < unlockedIndices.length; k++) {
      targetPlayer.hand[unlockedIndices[k]] = shuffled[k]
    }
  }

  private applySwap(action: PowerAction): void {
    if (action.power !== "swap") return
    const { sourcePlayerId, sourceCardIndex, targetPlayerId, targetCardIndex } = action as PowerAction & { power: "swap" }

    const sourcePlayer = this.game.players.find(p => p.id === sourcePlayerId)
    const targetPlayer = this.game.players.find(p => p.id === targetPlayerId)
    if (!sourcePlayer || !targetPlayer) throw new Error("Invalid player in swap")
    if (sourcePlayer.hand[sourceCardIndex].locked) throw new Error("Cannot swap locked card")
    if (targetPlayer.hand[targetCardIndex].locked) throw new Error("Cannot swap locked card")

    const temp = sourcePlayer.hand[sourceCardIndex]
    sourcePlayer.hand[sourceCardIndex] = targetPlayer.hand[targetCardIndex]
    targetPlayer.hand[targetCardIndex] = temp
  }

  private applyLock(action: PowerAction): void {
    if (action.power !== "lock") return
    const { targetPlayerId, cardIndex } = action as PowerAction & { power: "lock" }

    const targetPlayer = this.game.players.find(p => p.id === targetPlayerId)
    if (!targetPlayer) throw new Error("Invalid target player")
    if (targetPlayer.hand[cardIndex].locked) throw new Error("Card is already locked")

    // Mark as locked and add the King/Joker as a lock marker
    targetPlayer.hand[cardIndex] = {
      ...targetPlayer.hand[cardIndex],
      locked: true,
    }

    // The pending power card is the King/Joker that was discarded.
    // We already moved it to discard — but for lock, it's removed from discard pile
    // and placed as a visible lock marker instead.
    const lockCard = this.game.discardPile.pop()
    if (!lockCard) throw new Error("No card for lock marker")

    this.lockMarkers.push({
      playerId: targetPlayerId,
      cardIndex,
      markerCard: lockCard,
    })
  }

  // ────────────────────── Private: Helpers ────────────────────────────────

  private discardAndCheckPower(card: Card): void {
    const powerRank = isPowerCard(card.rank) ? card.rank : null

    if (powerRank === "K") {
      // King stays as a lock marker — it doesn't go to discard yet.
      // It's popped from discard during applyLock. For now, temporarily put in discard.
      this.game.discardPile.push(card)
      this.pendingPowerRank = powerRank
      this.phase = "power"
    } else if (powerRank === "JOKER") {
      this.game.discardPile.push(card)
      this.pendingPowerRank = powerRank
      this.phase = "power"
    } else if (powerRank) {
      this.game.discardPile.push(card)
      this.pendingPowerRank = powerRank
      this.phase = "power"
    } else {
      this.game.discardPile.push(card)
      this.pendingPowerRank = null
      this.phase = "showdown_eligible"
    }
  }

  private advanceTurn(): void {
    this.phase = "draw"
    this.drawnCard = null
    this.pendingPowerRank = null
    this.totalTurnsTaken++

    const currentPlayerId = this.game.players[this.game.currentTurn].id
    this.playerTurnCount.set(
      currentPlayerId,
      (this.playerTurnCount.get(currentPlayerId) ?? 0) + 1,
    )

    const isShowdown = this.game.state === "showdown"

    // During showdown, mark non-caller as having taken their final turn
    if (isShowdown && currentPlayerId !== this.game.callerId) {
      this.playersCompletedFinalTurn.add(currentPlayerId)
    }

    const numPlayers = this.game.players.length

    // Find the next player
    for (let i = 1; i <= numPlayers; i++) {
      const nextIdx = (this.game.currentTurn + i) % numPlayers
      const nextPlayerId = this.game.players[nextIdx].id

      if (isShowdown) {
        // Skip the caller and players who already did their final turn
        if (nextPlayerId === this.game.callerId) continue
        if (this.playersCompletedFinalTurn.has(nextPlayerId)) continue

        this.game.currentTurn = nextIdx
        return
      }

      this.game.currentTurn = nextIdx
      return
    }

    // All players in showdown have taken their final turn → finished
    if (isShowdown) {
      this.game.state = "finished"
    }
  }

  private buildInitialGame(): Game {
    const deck = this.rng.shuffle(createDeck())
    const players: Player[] = this.config.playerIds.map((id) => ({
      id,
      name: id,
      hand: [] as unknown as [PlayerCard, PlayerCard, PlayerCard, PlayerCard],
      connected: true,
    }))

    for (let i = 0; i < this.config.playerIds.length; i++) {
      const hand: PlayerCard[] = []
      for (let j = 0; j < HAND_SIZE; j++) {
        const card = deck.pop()!
        hand.push({ card, locked: false })
      }
      players[i].hand = hand as [PlayerCard, PlayerCard, PlayerCard, PlayerCard]
    }

    return {
      id: this.config.gameId,
      players,
      deck,
      discardPile: [],
      currentTurn: 0,
      state: "in_progress",
    }
  }

  private isShowdownEligible(): boolean {
    const currentPlayerId = this.game.players[this.game.currentTurn].id
    // Every player (including the current caller) must have completed at least MIN_TURNS_BEFORE_SHOWDOWN
    for (const p of this.game.players) {
      if ((this.playerTurnCount.get(p.id) ?? 0) < MIN_TURNS_BEFORE_SHOWDOWN) {
        return false
      }
    }
    // But the current player must have at least MIN_TURNS_BEFORE_SHOWDOWN from their perspective.
    // Since we're checking all players above, this covers it. Also verify the current player
    // has at least MIN_TURNS_BEFORE_SHOWDOWN — this should be redundant but is a safety check.
    return (this.playerTurnCount.get(currentPlayerId) ?? 0) >= MIN_TURNS_BEFORE_SHOWDOWN
  }

  private buildResult(events: CommittedEvent[]): EngineResult {
    const currentPlayerId = this.game.players[this.game.currentTurn].id
    const validEvents = this.getValidEvents(currentPlayerId)

    const result: EngineResult = {
      nextState: { ...this.game },
      events,
      validEvents,
    }

    if (this.lastPeekResult) {
      result.peekResult = this.lastPeekResult
      this.lastPeekResult = null
    }

    return result
  }
}