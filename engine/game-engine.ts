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
  BasePowerAction,
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
  private game: Game;
  private eventLog: CommittedEvent[] = [];
  private rng: SeededRNG;
  private eventIdCounter = 0;

  // Internal turn-phase tracking
  private phase: TurnPhase = "draw";
  private drawnCard: Card | null = null;
  /**
   * True when the current `drawnCard` was taken from the discard pile rather
   * than the deck. A power card drawn from discard, then immediately
   * DISCARD_DRAWN back onto the pile, must NOT re-trigger its power — the
   * card has already had its discard moment. Cleared whenever drawnCard is.
   */
  private drawnFromDiscard = false;
  private totalTurnsTaken = 0;
  private playerTurnCount = new Map<string, number>();
  private pendingPowerRank: Rank | null = null;
  private lockMarkers: LockMarker[] = [];
  private playersCompletedFinalTurn = new Set<string>();
  private lastPeekResult: PeekResult | null = null;
  private playersAcknowledgedReveal = new Set<string>();

  /**
   * Constructs a fully-initialized GameEngine: validates the config,
   * shuffles the deck, deals hands, and leaves the engine ready for the
   * first DRAW_CARD.
   */
  constructor(config: EngineConfig) {
    if (config.playerIds.length < MIN_PLAYERS || config.playerIds.length > MAX_PLAYERS) {
      throw new Error(`Player count must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
    }
    if (new Set(config.playerIds).size !== config.playerIds.length) {
      throw new Error("Player IDs must be unique");
    }
    this.config = { ...config };
    this.rng = new SeededRNG(config.seed ?? Date.now());
    this.game = this.buildInitialGame();
  }

  // ────────────────────────────── Public API ──────────────────────────────

  /** Process a player action. Validates → commits → reduces → returns result. */
  processEvent<T extends ProposedEventType>(playerId: string, eventType: T, payload: EventPayloadMap[T]): EngineResult {
    const error = this.validateEvent(playerId, eventType, payload);
    if (error) {
      return { ...this.buildResult([], playerId), error };
    }

    const event = this.createCommittedEvent(playerId, eventType, payload);

    this.eventLog.push(event);
    this.applyEvent(event);

    return this.buildResult([event], playerId);
  }

  /**
   * Current game state (live reference — DO NOT mutate).
   * Returns the engine's internal Game object directly. Callers that need
   * a safe-to-mutate snapshot should use processEvent's nextState or
   * getVisibleState, which are deep-cloned.
   */
  getState(): Game {
    return this.game;
  }

  /** Event log for replay. */
  getEventLog(): CommittedEvent[] {
    return structuredClone(this.eventLog);
  }

  /**
   * The card the current player drew this turn (deck or discard), before they
   * have replaced or discarded it. Returns null unless `playerId` is the
   * current turn holder AND a draw is pending. The drawn card is private to
   * the active player — server-authoritative info exposed only to them.
   */
  getDrawnCard(playerId: string): Card | null {
    const currentPlayer = this.game.players[this.game.currentTurn];
    if (!currentPlayer || currentPlayer.id !== playerId) return null;
    if (!this.drawnCard) return null;
    return structuredClone(this.drawnCard);
  }

  /** What events this player can perform right now. */
  getValidEvents(playerId: string): ProposedEventType[] {
    const valid: ProposedEventType[] = [];

    if (this.game.state === "finished") return valid;

    // During initial_reveal, every player can ACK independently of turn order.
    if (this.game.state === "initial_reveal") {
      const player = this.game.players.find((p) => p.id === playerId);
      if (player && !this.playersAcknowledgedReveal.has(playerId)) {
        valid.push("ACKNOWLEDGE_REVEAL");
      }
      return valid;
    }

    // Otherwise, only the current-turn player can act.
    const currentPlayer = this.game.players[this.game.currentTurn];
    if (!currentPlayer || currentPlayer.id !== playerId) return valid;

    switch (this.phase) {
      case "draw":
        valid.push("DRAW_CARD");
        break;
      case "decision":
        valid.push("REPLACE_CARD");
        // A card drawn from the discard pile must be placed into the hand —
        // it cannot be discarded back. Only deck draws are discardable.
        if (!this.drawnFromDiscard) valid.push("DISCARD_DRAWN");
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
        isCurrentTurn: this.game.players[this.game.currentTurn]?.id === p.id,
        acknowledgedReveal: this.playersAcknowledgedReveal.has(p.id),
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

    // At finished, every hand is public — expose them in one place so remote
    // clients can render the final reveal without reaching into private state.
    if (this.game.state === "finished") {
      result.allHands = this.game.players.map((p) => ({ playerId: p.id, hand: [...p.hand] }));
    }

    return structuredClone(result);
  }

  /** Calculates the winners based on lowest hand value and tiebreaker rules. */
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
      winners = winners.filter((p) => p.id !== this.game.callerId);
    }

    return winners;
  }

  /**
   * Build engine from a prior event log (replay).
   * Pushes the original committed events into the log so getEventLog()
   * on the replayed engine matches the source, and continued play
   * appends to that sequence without restarting from zero.
   */
  static fromEventLog(eventLog: CommittedEvent[], config: EngineConfig): GameEngine {
    const engine = new GameEngine(config);
    for (const event of eventLog) {
      engine.eventLog.push(event);
      engine.applyEvent(event);
    }
    // Bump the id counter past any replayed events so continued play
    // doesn't collide with replayed ids (best-effort: only matters when
    // both source and replay engines share this process).
    let maxIdx = -1;
    for (const event of eventLog) {
      const match = /^evt-(\d+)$/.exec(event.id);
      if (match?.[1]) maxIdx = Math.max(maxIdx, Number(match[1]));
    }
    engine.eventIdCounter = Math.max(engine.eventIdCounter, maxIdx + 1);
    return engine;
  }

  // ────────────────────────── Private: Event Creation ──────────────────────

  /** Creates a committed event with unique ID and sequence metadata. */
  private createCommittedEvent<T extends ProposedEventType>(
    playerId: string,
    type: T,
    payload: EventPayloadMap[T],
  ): CommittedEvent {
    const id = `evt-${this.eventIdCounter++}`;
    const sequence = this.eventLog.length;
    const timestamp = Date.now();

    // Use type guards or explicit checks to satisfy Discriminated Union without 'as'
    if (type === "ACKNOWLEDGE_REVEAL") {
      return { id, sequence, timestamp, playerId, type: "ACKNOWLEDGE_REVEAL", payload: undefined };
    }
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

  /** Validates if an action is legal given the current game state and phase. */
  private validateEvent<T extends ProposedEventType>(
    playerId: string,
    eventType: T,
    payload: EventPayloadMap[T],
  ): string | null {
    if (this.game.state === "finished") return "Game is already finished";

    // initial_reveal: every player must acknowledge before play begins.
    if (this.game.state === "initial_reveal") {
      if (eventType !== "ACKNOWLEDGE_REVEAL") return "Game has not started yet";
      const player = this.game.players.find((p) => p.id === playerId);
      if (!player) return "Unknown player";
      if (this.playersAcknowledgedReveal.has(playerId)) return "Already acknowledged reveal";
      return null;
    }

    if (eventType === "ACKNOWLEDGE_REVEAL") return "Reveal phase already complete";

    const currentPlayer = this.game.players[this.game.currentTurn];
    if (!currentPlayer || currentPlayer.id !== playerId) return "Not your turn";

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
      if (eventType === "DISCARD_DRAWN" && this.drawnFromDiscard) {
        return "A card drawn from the discard pile must be replaced into the hand";
      }
      if (this.isReplacePayload(eventType, payload)) {
        const replaceError = this.validateReplaceTarget(payload.handIndex);
        if (replaceError) return replaceError;
      }
    } else if (this.isPowerPayload(eventType, payload)) {
      if (this.phase !== "power") return "No power to resolve";
      if (!this.pendingPowerRank) return "No pending power";
      const action = payload;
      if (!action.power) return "Invalid power action";
      const expected = POWER_ACTION_MAP[this.pendingPowerRank];
      if (action.power !== expected) {
        return `Expected power action "${expected}" but got "${action.power}"`;
      }
      if (action.power === "joker" && !action.action) {
        return "Invalid joker action: missing inner action";
      }

      // Validate the effective inner action (swap/lock target sanity for both base + joker mimic)
      const effective: BasePowerAction = action.power === "joker" ? action.action : action;
      const targetError = this.validatePowerTargets(effective);
      if (targetError) return targetError;
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

  /** Validates a REPLACE_CARD target. Returns an error message or null. */
  private validateReplaceTarget(handIndex: number): string | null {
    if (handIndex === undefined || handIndex < 0 || handIndex >= HAND_SIZE) {
      return "Invalid hand index";
    }
    const player = this.game.players[this.game.currentTurn];
    if (!player) return "Current player not found";
    const target = player.hand[handIndex];
    if (!target) return "Card not found in hand";
    if (target.locked) return "Cannot replace a locked card";
    return null;
  }

  /** Validates the effective (post-mimic) power action's target sanity. */
  private validatePowerTargets(action: BasePowerAction): string | null {
    if (action.power === "peek") {
      if (action.target === "opponent") {
        const currentPlayerId = this.game.players[this.game.currentTurn]?.id;
        if (action.opponentId === currentPlayerId) {
          return "Opponent peek target cannot be self; use target: 'own'";
        }
        const opponent = this.game.players.find((p) => p.id === action.opponentId);
        if (!opponent) return "Invalid opponentId";
        if (action.opponentCardIndex < 0 || action.opponentCardIndex >= HAND_SIZE) {
          return "Invalid opponentCardIndex";
        }
        if (!opponent.hand[action.opponentCardIndex]) return "Card not found";
      }
      return null;
    }

    if (action.power === "shuffle") {
      const currentPlayerId = this.game.players[this.game.currentTurn]?.id;
      if (action.targetPlayerId === currentPlayerId) return "Shuffle target cannot be self";
      const target = this.game.players.find((p) => p.id === action.targetPlayerId);
      if (!target) return "Invalid target player";
      return null;
    }

    if (action.power === "swap") {
      if (action.sourcePlayerId === action.targetPlayerId) return "Swap requires two different players";
      const source = this.game.players.find((p) => p.id === action.sourcePlayerId);
      const target = this.game.players.find((p) => p.id === action.targetPlayerId);
      if (!source || !target) return "Invalid player in swap";
      if (action.sourceCardIndex < 0 || action.sourceCardIndex >= HAND_SIZE) return "Invalid source card index";
      if (action.targetCardIndex < 0 || action.targetCardIndex >= HAND_SIZE) return "Invalid target card index";
      const sourcePC = source.hand[action.sourceCardIndex];
      const targetPC = target.hand[action.targetCardIndex];
      if (!sourcePC || !targetPC) return "Card not found for swap";
      if (sourcePC.locked || targetPC.locked) return "Cannot swap locked card";
      return null;
    }

    if (action.power === "lock") {
      const target = this.game.players.find((p) => p.id === action.targetPlayerId);
      if (!target) return "Invalid target player";
      if (action.cardIndex < 0 || action.cardIndex >= HAND_SIZE) return "Invalid card index";
      const playerCard = target.hand[action.cardIndex];
      if (!playerCard) return "Card not found";
      if (playerCard.locked) return "Card is already locked";
      return null;
    }

    return null;
  }

  // ────────────────────────── Private: Type Guards ──────────────────────

  /** Type guard for DRAW_CARD payload. */
  private isDrawPayload(type: ProposedEventType, _payload: unknown): _payload is EventPayloadMap["DRAW_CARD"] {
    return type === "DRAW_CARD";
  }

  /** Type guard for REPLACE_CARD payload. */
  private isReplacePayload(type: ProposedEventType, _payload: unknown): _payload is EventPayloadMap["REPLACE_CARD"] {
    return type === "REPLACE_CARD";
  }

  /** Type guard for USE_POWER payload (PowerAction). */
  private isPowerPayload(type: ProposedEventType, _payload: unknown): _payload is PowerAction {
    return type === "USE_POWER";
  }

  // ────────────────────────── Private: Event Reducer ──────────────────────

  /** Dispatches an event to the appropriate application logic. */
  private applyEvent(event: CommittedEvent): void {
    if (event.type === "ACKNOWLEDGE_REVEAL") {
      this.applyAcknowledgeReveal(event);
    } else if (event.type === "DRAW_CARD") {
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

  /** Records a player's reveal acknowledgment; starts play when all have ack'd. */
  private applyAcknowledgeReveal(event: CommittedEvent<"ACKNOWLEDGE_REVEAL">): void {
    this.playersAcknowledgedReveal.add(event.playerId);
    if (this.playersAcknowledgedReveal.size === this.game.players.length) {
      this.game.state = "in_progress";
    }
  }

  /** Draws a card from the deck or discard pile. */
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
    this.drawnFromDiscard = source === "discard";
    this.phase = "decision";
  }

  /** Replaces a card in the player's hand with the drawn card. */
  private applyReplace(event: CommittedEvent<"REPLACE_CARD">): void {
    const handIndex = event.payload.handIndex;
    if (handIndex === undefined || handIndex < 0 || handIndex >= HAND_SIZE) {
      throw new Error("Invalid hand index");
    }

    const player = this.game.players[this.game.currentTurn];
    if (!player) throw new Error("Player not found");
    const target = player.hand[handIndex];
    if (!target) throw new Error("Card not found in hand");
    if (target.locked) throw new Error("Cannot replace a locked card");

    // Put drawn card in hand, old card goes to discard
    const { drawnCard } = this;
    if (!drawnCard) throw new Error("No card drawn yet");

    player.hand[handIndex] = { card: drawnCard, locked: false };
    this.drawnCard = null;
    this.drawnFromDiscard = false;

    // Discard the replaced card and check for power
    this.discardAndCheckPower(target.card);
  }

  /** Discards the drawn card (only reachable when drawn from the deck). */
  private applyDiscardDrawn(_event: CommittedEvent<"DISCARD_DRAWN">): void {
    const { drawnCard } = this;
    if (!drawnCard) throw new Error("No card drawn yet");

    this.drawnCard = null;
    this.drawnFromDiscard = false;
    this.discardAndCheckPower(drawnCard);
  }

  /** Initiates the showdown phase. */
  private applyCallShowdown(_event: CommittedEvent<"CALL_SHOWDOWN">): void {
    const currentPlayer = this.game.players[this.game.currentTurn];
    if (!currentPlayer) throw new Error("Current player not found");
    const callerId = currentPlayer.id;
    this.game.state = "showdown";
    this.game.callerId = callerId;
    this.playersCompletedFinalTurn.add(callerId);
    this.advanceTurn();
  }

  /** Resolves the special power of a card. */
  private applyUsePower(event: CommittedEvent<"USE_POWER">): void {
    const action = event.payload;
    if (!action || !action.power) throw new Error("Invalid power action");

    // Determine effective power (handle joker mimic)
    let effectiveAction: BasePowerAction;
    if (action.power === "joker") {
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

  /** Ends the current player's turn. */
  private applyEndTurn(_event: CommittedEvent<"END_TURN">): void {
    this.advanceTurn();
  }

  // ────────────────────── Private: Power Resolution ────────────────────────

  /** Peeks at a player's own card or an opponent's card. */
  private applyPeek(action: BasePowerAction & { power: "peek" }): void {
    if (action.target === "own") {
      const player = this.game.players[this.game.currentTurn];
      if (!player) throw new Error("Current player not found");
      this.lastPeekResult = {
        playerId: player.id,
        cards: player.hand.map((pc, i) => ({ index: i, card: pc.card })),
      };
    } else if (action.target === "opponent") {
      const opponent = this.game.players.find((p) => p.id === action.opponentId);
      if (!opponent) throw new Error("Invalid opponent");
      const playerCard = opponent.hand[action.opponentCardIndex];
      if (!playerCard) throw new Error("Card not found");
      this.lastPeekResult = {
        playerId: opponent.id,
        cards: [{ index: action.opponentCardIndex, card: playerCard.card }],
      };
    }
  }

  /** Shuffles the unlocked cards of a target player. */
  private applyShuffle(action: BasePowerAction & { power: "shuffle" }): void {
    const targetPlayer = this.game.players.find((p) => p.id === action.targetPlayerId);
    if (!targetPlayer) throw new Error("Invalid target player");

    // Shuffle only unlocked card positions (lock states are preserved)
    const unlockedIndices = targetPlayer.hand
      .map((pc, i) => ({ pc, i }))
      .filter((x) => !x.pc.locked)
      .map((x) => x.i);

    const unlockedCards = unlockedIndices.map((i) => {
      const card = targetPlayer.hand[i];
      if (!card) throw new Error("Card not found");
      return card;
    });
    const shuffled = this.rng.shuffle(unlockedCards);

    for (let k = 0; k < unlockedIndices.length; k++) {
      const index = unlockedIndices[k];
      const card = shuffled[k];
      if (index === undefined || !card) throw new Error("Invalid shuffle state");
      targetPlayer.hand[index] = card;
    }
  }

  /** Swaps two unlocked cards between two players. */
  private applySwap(action: BasePowerAction & { power: "swap" }): void {
    const { sourcePlayerId, sourceCardIndex, targetPlayerId, targetCardIndex } = action;

    const sourcePlayer = this.game.players.find((p) => p.id === sourcePlayerId);
    const targetPlayer = this.game.players.find((p) => p.id === targetPlayerId);
    if (!sourcePlayer || !targetPlayer) throw new Error("Invalid player in swap");

    const sourcePC = sourcePlayer.hand[sourceCardIndex];
    const targetPC = targetPlayer.hand[targetCardIndex];

    if (!sourcePC || !targetPC) throw new Error("Card not found for swap");
    if (sourcePC.locked) throw new Error("Cannot swap locked card");
    if (targetPC.locked) throw new Error("Cannot swap locked card");

    const temp = sourcePC;
    sourcePlayer.hand[sourceCardIndex] = targetPC;
    targetPlayer.hand[targetCardIndex] = temp;
  }

  /** Locks a target player's card, making it unswappable until the end of the game. */
  private applyLock(action: BasePowerAction & { power: "lock" }): void {
    const { targetPlayerId, cardIndex } = action;

    const targetPlayer = this.game.players.find((p) => p.id === targetPlayerId);
    if (!targetPlayer) throw new Error("Invalid target player");
    const playerCard = targetPlayer.hand[cardIndex];
    if (!playerCard) throw new Error("Card not found");
    if (playerCard.locked) throw new Error("Card is already locked");

    // Mark as locked and add the King/Joker as a lock marker
    targetPlayer.hand[cardIndex] = {
      card: playerCard.card,
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

  /** Discards a card and updates the game phase if it triggers a power action. */
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

  /** Advances the game to the next player's turn or concludes the showdown. */
  private advanceTurn(): void {
    this.phase = "draw";
    this.drawnCard = null;
    this.drawnFromDiscard = false;
    this.pendingPowerRank = null;
    this.totalTurnsTaken++;

    const currentPlayer = this.game.players[this.game.currentTurn];
    if (!currentPlayer) throw new Error("Current player not found");
    const currentPlayerId = currentPlayer.id;
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
      const nextPlayer = this.game.players[nextIdx];
      if (!nextPlayer) continue;
      const nextPlayerId = nextPlayer.id;

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

  /** Constructs the initial game state, shuffling the deck and dealing cards. */
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
      state: "initial_reveal",
    };
  }

  /** Checks if the game is eligible for a showdown call. */
  private isShowdownEligible(): boolean {
    const currentPlayer = this.game.players[this.game.currentTurn];
    if (!currentPlayer) return false;
    const currentPlayerId = currentPlayer.id;
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

  /**
   * Packages the current engine state into a result format for the client.
   * `validEvents` reflects what the **actor** can do next (relevant during
   * initial_reveal where multiple players act in parallel); falls back to
   * the current-turn player when no actor is given.
   */
  private buildResult(events: CommittedEvent[], actorId?: string): EngineResult {
    const focusId = actorId ?? this.game.players[this.game.currentTurn]?.id;
    if (!focusId) throw new Error("No player to focus result on");
    const validEvents = this.getValidEvents(focusId);

    const result: EngineResult = {
      nextState: this.game,
      events,
      validEvents,
    };

    if (this.lastPeekResult) {
      result.peekResult = this.lastPeekResult;
      this.lastPeekResult = null;
    }

    return structuredClone(result);
  }
}
