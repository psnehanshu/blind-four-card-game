import type {
  Card,
  Game,
  Player,
  PlayerCard,
  TurnPhase,
  ProposedEventType,
  CommittedEvent,
  EngineConfig,
  PowerAction,
  EngineResult,
  LockMarker,
  PeekResult,
  VisibleGameState,
  VisiblePlayerState,
  Rank,
  EventPayloadMap,
} from "./types.js";
import { HAND_SIZE, MIN_PLAYERS, MAX_PLAYERS, MIN_TURNS_BEFORE_SHOWDOWN } from "./types.js";
import { createDeck, isPowerCard } from "./cards.js";
import { SeededRNG } from "./rng.js";

let eventIdCounter = 0;

/** Maps card rank → expected action name for USE_POWER. */
const POWER_ACTION_MAP: Record<string, string> = {
  "10": "peek",
  J: "shuffle",
  Q: "swap",
  K: "lock",
  JOKER: "joker",
};

export class GameEngine {
  private config: EngineConfig;
  private _game: Game | null = null;
  private eventLog: CommittedEvent[];
  private rng: SeededRNG;

  private get game(): Game {
    if (!this._game) throw new Error("Game not initialized");
    return this._game;
  }

  private set game(g: Game) {
    this._game = g;
  }

  // Internal turn-phase tracking
  private phase: TurnPhase;
  private drawnCard: Card | null;
  private totalTurnsTaken: number;
  private playerTurnCount: Map<string, number>;
  private pendingPowerRank: Rank | null;
  private lockMarkers: LockMarker[];
  private playersCompletedFinalTurn: Set<string>;
  private lastPeekResult: PeekResult | null;

  constructor(config: EngineConfig) {
    if (config.playerIds.length < MIN_PLAYERS || config.playerIds.length > MAX_PLAYERS) {
      throw new Error(`Player count must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
    }
    this.config = { ...config };
    this.rng = new SeededRNG(config.seed ?? Date.now());
    this.eventLog = [];
    this.phase = "draw";
    this.drawnCard = null;
    this.totalTurnsTaken = 0;
    this.playerTurnCount = new Map();
    this.pendingPowerRank = null;
    this.lockMarkers = [];
    this.playersCompletedFinalTurn = new Set();
    this.lastPeekResult = null;
  }

  // ────────────────────────────── Public API ──────────────────────────────

  /** Create a game and deal cards. Returns the initial state. */
  createGame(): EngineResult {
    this.game = this.buildInitialGame();
    this.phase = "draw";
    return this.buildResult([]);
  }

  /** Process a player action. Validates → commits → reduces → returns result. */
  processEvent<T extends ProposedEventType>(
    playerId: string,
    eventType: T,
    payload: EventPayloadMap[T],
  ): EngineResult {
    const error = this.validateEvent(playerId, eventType, payload);
    if (error) {
      return { ...this.buildResult([]), error };
    }

    const event = this.createCommittedEvent(playerId, eventType, payload);

    this.eventLog.push(event);
    this.applyEvent(event);

    return this.buildResult([event]);
  }

  /** Current game state (public fields only). */
  getState(): Game {
    return this.game;
  }

  /** Event log for replay. */
  getEventLog(): CommittedEvent[] {
    return [...this.eventLog];
  }

  /** What events this player can perform right now. */
  getValidEvents(playerId: string): ProposedEventType[] {
    const valid: ProposedEventType[] = [];

    // Must be this player's turn
    if (this.game.players[this.game.currentTurn].id !== playerId) return valid;

    if (this.game.state === "finished") return valid;

    switch (this.phase) {
      case "draw":
        valid.push("DRAW_CARD");
        break;
      case "decision":
        valid.push("REPLACE_CARD", "DISCARD_DRAWN");
        break;
      case "power":
        valid.push("USE_POWER");
        break;
      case "showdown_eligible":
        if (this.game.state !== "showdown" && this.isShowdownEligible()) {
          valid.push("CALL_SHOWDOWN");
        }
        if (this.game.state !== "showdown" || playerId !== this.game.callerId) {
          valid.push("END_TURN");
        }
        break;
    }

    return valid;
  }

  /** State filtered for one player (respects visibility rules). */
  getVisibleState(playerId: string): VisibleGameState {
    const player = this.game.players.find((p) => p.id === playerId);
    const players: VisiblePlayerState[] = [];

    for (const p of this.game.players) {
      const lockedCards = this.lockMarkers
        .filter((lm) => lm.playerId === p.id)
        .map((lm) => ({ index: lm.cardIndex, markerCard: lm.markerCard }));

      players.push({
        id: p.id,
        name: p.name,
        lockedCards,
        handSize: p.hand.length,
        isCurrentTurn: this.game.players[this.game.currentTurn].id === p.id,
      });
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
    };

    // Show own hand during initial_reveal or finished state
    if (player) {
      if (this.game.state === "initial_reveal" || this.game.state === "finished") {
        result.myHand = player.hand.map((pc, i) => ({ index: i, card: pc }));
      }
    }

    return result;
  }

  get winners(): Player[] {
    if (this.game.state !== "finished") return [];

    // Determine winner(s) based on lowest hand value, with tiebreakers
    let lowestValue = Infinity;
    let winners: Player[] = [];

    for (const player of this.game.players) {
      const handValue = player.hand.reduce((sum, pc) => sum + pc.card.value, 0);
      if (handValue < lowestValue) {
        lowestValue = handValue;
        winners = [player];
      } else if (handValue === lowestValue) {
        winners.push(player);
      }
    }

    // If multiple players tie on hand value, exclude caller as their score must be strictly lower than all opponents to win
    if (winners.length > 1 && this.game.callerId) {
      winners = winners.filter((p) => p.id === this.game.callerId);
    }

    return winners;
  }

  /** Build engine from a prior event log (replay). */
  static fromEventLog(eventLog: CommittedEvent[], config: EngineConfig): GameEngine {
    const engine = new GameEngine(config);
    engine.createGame();
    for (const event of eventLog) {
      engine.applyEvent(event);
    }
    return engine;
  }

  // ────────────────────────── Private: Event Creation ──────────────────────

  private createCommittedEvent<T extends ProposedEventType>(
    playerId: string,
    type: T,
    payload: EventPayloadMap[T],
  ): CommittedEvent {
    const id = `evt-${eventIdCounter++}`;
    const sequence = this.eventLog.length;
    const timestamp = Date.now();

    // Use type guards or explicit checks to satisfy Discriminated Union without 'as'
    if (this.isDrawPayload(type, payload)) {
      return { id, sequence, timestamp, playerId, type: "DRAW_CARD", payload };
    }
    if (this.isReplacePayload(type, payload)) {
      return { id, sequence, timestamp, playerId, type: "REPLACE_CARD", payload };
    }
    if (type === "DISCARD_DRAWN") {
      return { id, sequence, timestamp, playerId, type: "DISCARD_DRAWN", payload: undefined };
    }
    if (type === "CALL_SHOWDOWN") {
      return { id, sequence, timestamp, playerId, type: "CALL_SHOWDOWN", payload: undefined };
    }
    if (this.isPowerPayload(type, payload)) {
      return { id, sequence, timestamp, playerId, type: "USE_POWER", payload };
    }
    if (type === "END_TURN") {
      return { id, sequence, timestamp, playerId, type: "END_TURN", payload: undefined };
    }
    throw new Error("Unknown event type");
  }

  // ────────────────────────── Private: Validation ──────────────────────────

  private validateEvent<T extends ProposedEventType>(
    playerId: string,
    eventType: T,
    payload: EventPayloadMap[T],
  ): string | null {
    if (this.game.state === "finished") return "Game is already finished";

    const currentPlayer = this.game.players[this.game.currentTurn];
    if (currentPlayer.id !== playerId) return "Not your turn";

    // Phase-based validation
    if (this.isDrawPayload(eventType, payload)) {
      if (this.phase !== "draw") return "Must be in draw phase";
      if (this.drawnCard) return "Already drew this turn";
      const source = payload.source ?? "deck";
      if (source === "discard") {
        if (this.game.discardPile.length === 0) return "Discard pile is empty";
      } else if (this.game.deck.length === 0) return "Deck is empty";
    } else if (eventType === "REPLACE_CARD" || eventType === "DISCARD_DRAWN") {
      if (this.phase !== "decision") return "Must replace or discard drawn card";
      if (!this.drawnCard) return "No card drawn yet";
    } else if (this.isPowerPayload(eventType, payload)) {
      if (this.phase !== "power") return "No power to resolve";
      if (!this.pendingPowerRank) return "No pending power";
      const action = payload;
      if (!action.power) return "Invalid power action";
      const expected = POWER_ACTION_MAP[this.pendingPowerRank];
      if (action.power !== expected) {
        return `Expected power action "${expected}" but got "${action.power}"`;
      }
    } else if (eventType === "CALL_SHOWDOWN") {
      if (this.phase !== "showdown_eligible") return "Cannot call showdown now";
      if (this.game.state === "showdown") return "Showdown already in progress";
      if (!this.isShowdownEligible()) return "Must complete 2 turns each before showdown";
    } else if (eventType === "END_TURN") {
      if (this.phase !== "showdown_eligible") return "Cannot end turn now";
      if (this.game.state === "showdown" && playerId === this.game.callerId) {
        return "Caller gets no more turns";
      }
    }

    return null;
  }

  // ────────────────────────── Private: Type Guards ──────────────────────

  private isDrawPayload(type: ProposedEventType, _payload: unknown): _payload is EventPayloadMap["DRAW_CARD"] {
    return type === "DRAW_CARD";
  }

  private isReplacePayload(type: ProposedEventType, _payload: unknown): _payload is EventPayloadMap["REPLACE_CARD"] {
    return type === "REPLACE_CARD";
  }

  private isPowerPayload(type: ProposedEventType, _payload: unknown): _payload is PowerAction {
    return type === "USE_POWER";
  }

  // ────────────────────────── Private: Event Reducer ──────────────────────

  private applyEvent(event: CommittedEvent): void {
    if (event.type === "DRAW_CARD") {
      this.applyDraw(event);
    } else if (event.type === "REPLACE_CARD") {
      this.applyReplace(event);
    } else if (event.type === "DISCARD_DRAWN") {
      this.applyDiscardDrawn(event);
    } else if (event.type === "CALL_SHOWDOWN") {
      this.applyCallShowdown(event);
    } else if (event.type === "USE_POWER") {
      this.applyUsePower(event);
    } else if (event.type === "END_TURN") {
      this.applyEndTurn(event);
    }
  }

  private applyDraw(event: CommittedEvent<"DRAW_CARD">): void {
    const source = event.payload.source ?? "deck";
    let drawn: Card;

    if (source === "discard") {
      const card = this.game.discardPile.pop();
      if (!card) throw new Error("Discard pile is empty");
      drawn = card;
    } else {
      const card = this.game.deck.pop();
      if (!card) throw new Error("Deck is empty");
      drawn = card;
    }

    this.drawnCard = drawn;
    this.phase = "decision";
  }

  private applyReplace(event: CommittedEvent<"REPLACE_CARD">): void {
    const handIndex = event.payload.handIndex;
    if (handIndex === undefined || handIndex < 0 || handIndex >= HAND_SIZE) {
      throw new Error("Invalid hand index");
    }

    const player = this.game.players[this.game.currentTurn];
    const target = player.hand[handIndex];
    if (target.locked) throw new Error("Cannot replace a locked card");

    // Put drawn card in hand, old card goes to discard
    const { drawnCard } = this;
    if (!drawnCard) throw new Error("No card drawn yet");

    player.hand[handIndex] = { card: drawnCard, locked: false };
    this.drawnCard = null;

    // Discard the replaced card and check for power
    this.discardAndCheckPower(target.card);
  }

  private applyDiscardDrawn(_event: CommittedEvent<"DISCARD_DRAWN">): void {
    const { drawnCard } = this;
    if (!drawnCard) throw new Error("No card drawn yet");

    this.drawnCard = null;
    this.discardAndCheckPower(drawnCard);
  }

  private applyCallShowdown(_event: CommittedEvent<"CALL_SHOWDOWN">): void {
    const callerId = this.game.players[this.game.currentTurn].id;
    this.game.state = "showdown";
    this.game.callerId = callerId;
    this.playersCompletedFinalTurn.add(callerId);
    this.advanceTurn();
  }

  private applyUsePower(event: CommittedEvent<"USE_POWER">): void {
    const action = event.payload;
    if (!action || !action.power) throw new Error("Invalid power action");

    // Determine effective power (handle joker mimic)
    let effectiveAction: PowerAction;
    if (action.power === "joker") {
      if (!action.action) throw new Error("Invalid joker action");
      effectiveAction = action.action;
    } else {
      effectiveAction = action;
    }

    switch (effectiveAction.power) {
      case "peek":
        this.applyPeek(effectiveAction);
        break;
      case "shuffle":
        this.applyShuffle(effectiveAction);
        break;
      case "swap":
        this.applySwap(effectiveAction);
        break;
      case "lock":
        this.applyLock(effectiveAction);
        break;
    }

    this.pendingPowerRank = null;
    this.phase = "showdown_eligible";
  }

  private applyEndTurn(_event: CommittedEvent<"END_TURN">): void {
    this.advanceTurn();
  }

  // ────────────────────── Private: Power Resolution ────────────────────────

  private applyPeek(action: PowerAction): void {
    if (action.power !== "peek") return;

    if (action.target === "own") {
      const player = this.game.players[this.game.currentTurn];
      this.lastPeekResult = {
        playerId: player.id,
        cards: player.hand.map((pc, i) => ({ index: i, card: pc.card })),
      };
    } else if (action.target === "opponent" && action.opponentId) {
      const opponent = this.game.players.find((p) => p.id === action.opponentId);
      if (!opponent) throw new Error("Invalid opponent");

      // Peek at 1 random opponent card (or the first, since the player can choose)
      // The spec says "1 opponent card" — let's return all for the player to see
      // but only 1 card's data. Actually, let's return the first unlocked card.
      const unlockedIdx = opponent.hand.findIndex((pc) => !pc.locked);
      if (unlockedIdx === -1) throw new Error("No unlocked cards to peek at");
      this.lastPeekResult = {
        playerId: opponent.id,
        cards: [{ index: unlockedIdx, card: opponent.hand[unlockedIdx].card }],
      };
    }
  }

  private applyShuffle(action: PowerAction): void {
    if (action.power !== "shuffle") return;
    const targetPlayer = this.game.players.find((p) => p.id === action.targetPlayerId);
    if (!targetPlayer) throw new Error("Invalid target player");

    // Shuffle only unlocked card positions (lock states are preserved)
    const unlockedIndices = targetPlayer.hand
      .map((pc, i) => ({ pc, i }))
      .filter((x) => !x.pc.locked)
      .map((x) => x.i);

    const unlockedCards = unlockedIndices.map((i) => targetPlayer.hand[i]);
    const shuffled = this.rng.shuffle(unlockedCards);

    for (let k = 0; k < unlockedIndices.length; k++) {
      targetPlayer.hand[unlockedIndices[k]] = shuffled[k];
    }
  }

  private applySwap(action: PowerAction & { power: "swap" }): void {
    const { sourcePlayerId, sourceCardIndex, targetPlayerId, targetCardIndex } = action;

    const sourcePlayer = this.game.players.find((p) => p.id === sourcePlayerId);
    const targetPlayer = this.game.players.find((p) => p.id === targetPlayerId);
    if (!sourcePlayer || !targetPlayer) throw new Error("Invalid player in swap");
    if (sourcePlayer.hand[sourceCardIndex].locked) throw new Error("Cannot swap locked card");
    if (targetPlayer.hand[targetCardIndex].locked) throw new Error("Cannot swap locked card");

    const temp = sourcePlayer.hand[sourceCardIndex];
    sourcePlayer.hand[sourceCardIndex] = targetPlayer.hand[targetCardIndex];
    targetPlayer.hand[targetCardIndex] = temp;
  }

  private applyLock(action: PowerAction & { power: "lock" }): void {
    const { targetPlayerId, cardIndex } = action;

    const targetPlayer = this.game.players.find((p) => p.id === targetPlayerId);
    if (!targetPlayer) throw new Error("Invalid target player");
    if (targetPlayer.hand[cardIndex].locked) throw new Error("Card is already locked");

    // Mark as locked and add the King/Joker as a lock marker
    targetPlayer.hand[cardIndex] = {
      ...targetPlayer.hand[cardIndex],
      locked: true,
    };

    // The pending power card is the King/Joker that was discarded.
    // We already moved it to discard — but for lock, it's removed from discard pile
    // and placed as a visible lock marker instead.
    const lockCard = this.game.discardPile.pop();
    if (!lockCard) throw new Error("No card for lock marker");

    this.lockMarkers.push({
      playerId: targetPlayerId,
      cardIndex,
      markerCard: lockCard,
    });
  }

  // ────────────────────── Private: Helpers ────────────────────────────────

  private discardAndCheckPower(card: Card): void {
    const powerRank = isPowerCard(card.rank) ? card.rank : null;

    if (powerRank === "K") {
      // King stays as a lock marker — it doesn't go to discard yet.
      // It's popped from discard during applyLock. For now, temporarily put in discard.
      this.game.discardPile.push(card);
      this.pendingPowerRank = powerRank;
      this.phase = "power";
    } else if (powerRank === "JOKER") {
      this.game.discardPile.push(card);
      this.pendingPowerRank = powerRank;
      this.phase = "power";
    } else if (powerRank) {
      this.game.discardPile.push(card);
      this.pendingPowerRank = powerRank;
      this.phase = "power";
    } else {
      this.game.discardPile.push(card);
      this.pendingPowerRank = null;
      this.phase = "showdown_eligible";
    }
  }

  private advanceTurn(): void {
    this.phase = "draw";
    this.drawnCard = null;
    this.pendingPowerRank = null;
    this.totalTurnsTaken++;

    const currentPlayerId = this.game.players[this.game.currentTurn].id;
    this.playerTurnCount.set(currentPlayerId, (this.playerTurnCount.get(currentPlayerId) ?? 0) + 1);

    const isShowdown = this.game.state === "showdown";

    // During showdown, mark non-caller as having taken their final turn
    if (isShowdown && currentPlayerId !== this.game.callerId) {
      this.playersCompletedFinalTurn.add(currentPlayerId);
    }

    const numPlayers = this.game.players.length;

    // Find the next player
    for (let i = 1; i <= numPlayers; i++) {
      const nextIdx = (this.game.currentTurn + i) % numPlayers;
      const nextPlayerId = this.game.players[nextIdx].id;

      if (isShowdown) {
        // Skip the caller and players who already did their final turn
        if (nextPlayerId === this.game.callerId) continue;
        if (this.playersCompletedFinalTurn.has(nextPlayerId)) continue;

        this.game.currentTurn = nextIdx;
        return;
      }

      this.game.currentTurn = nextIdx;
      return;
    }

    // All players in showdown have taken their final turn → finished
    if (isShowdown) {
      this.game.state = "finished";
    }
  }

  private buildInitialGame(): Game {
    const deck = this.rng.shuffle(createDeck());
    const players: Player[] = this.config.playerIds.map((id) => {
      const hand: PlayerCard[] = [];
      for (let j = 0; j < HAND_SIZE; j++) {
        const card = deck.pop();
        if (!card) throw new Error("Deck exhausted during deal");
        hand.push({ card, locked: false });
      }

      // Hand consists of 4 cards exactly
      const c1 = hand[0];
      const c2 = hand[1];
      const c3 = hand[2];
      const c4 = hand[3];

      if (!c1 || !c2 || !c3 || !c4) throw new Error("Failed to deal 4 cards");

      return {
        id,
        name: id,
        hand: [c1, c2, c3, c4],
        connected: true,
      };
    });

    return {
      id: this.config.gameId,
      players,
      deck,
      discardPile: [],
      currentTurn: 0,
      state: "in_progress",
    };
  }

  private isShowdownEligible(): boolean {
    const currentPlayerId = this.game.players[this.game.currentTurn].id;
    // Every player (including the current caller) must have completed at least MIN_TURNS_BEFORE_SHOWDOWN
    for (const p of this.game.players) {
      if ((this.playerTurnCount.get(p.id) ?? 0) < MIN_TURNS_BEFORE_SHOWDOWN) {
        return false;
      }
    }
    // But the current player must have at least MIN_TURNS_BEFORE_SHOWDOWN from their perspective.
    // Since we're checking all players above, this covers it. Also verify the current player
    // has at least MIN_TURNS_BEFORE_SHOWDOWN — this should be redundant but is a safety check.
    return (this.playerTurnCount.get(currentPlayerId) ?? 0) >= MIN_TURNS_BEFORE_SHOWDOWN;
  }

  private buildResult(events: CommittedEvent[]): EngineResult {
    const currentPlayerId = this.game.players[this.game.currentTurn].id;
    const validEvents = this.getValidEvents(currentPlayerId);

    const result: EngineResult = {
      nextState: { ...this.game },
      events,
      validEvents,
    };

    if (this.lastPeekResult) {
      result.peekResult = this.lastPeekResult;
      this.lastPeekResult = null;
    }

    return result;
  }
}
