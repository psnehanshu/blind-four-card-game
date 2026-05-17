/** Standard card suit. */
export type Suit = "hearts" | "diamonds" | "clubs" | "spades"

/** Card rank including Joker. Value mapping is defined in cards.ts. */
export type Rank =
  | "A" | "2" | "3" | "4" | "5" | "6"
  | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "JOKER"

/** A single card in the deck or a player's hand. */
export interface Card {
  /** Unique identifier (e.g. "card-0"), not a display name. */
  id: string
  /** Present for all cards except Jokers. */
  suit?: Suit
  rank: Rank
  /** Score value used for scoring at showdown. */
  value: number
}

/** A card held by a player, with its lock state. */
export interface PlayerCard {
  card: Card
  /** True when a King/Joker lock marker has been placed on this card. */
  locked: boolean
}

/** A player participating in the game. */
export interface Player {
  id: string
  name: string
  /** Exactly 4 cards. Hidden from the owner after initial reveal. */
  hand: [PlayerCard, PlayerCard, PlayerCard, PlayerCard]
  /** Whether the player is currently connected. */
  connected: boolean
}

/** High-level game lifecycle state. */
export type GameState =
  | "waiting"
  | "initial_reveal"
  | "in_progress"
  | "showdown"
  | "finished"

/** The full game state visible to the engine (not filtered for clients). */
export interface Game {
  id: string
  players: Player[]
  /** Cards remaining in the draw pile. */
  deck: Card[]
  /** Cards that have been discarded (visible to all players). */
  discardPile: Card[]
  /** Index into `players` — whose turn it is. */
  currentTurn: number
  state: GameState
  /** Player who called showdown. Only set during showdown/finished states. */
  callerId?: string
}

/** Sub-phase within a single turn state, governing which actions are valid. */
export type TurnPhase =
  | "draw"
  | "decision"
  | "power"
  | "showdown_eligible"

/** Actions a player may propose during their turn. */
export type ProposedEventType =
  | "DRAW_CARD"
  | "REPLACE_CARD"
  | "DISCARD_DRAWN"
  | "CALL_SHOWDOWN"
  | "USE_POWER"
  | "END_TURN"

/** An event that has been validated and appended to the event log. */
export interface CommittedEvent<T = unknown> {
  id: string
  /** Monotonically increasing index in the event log. */
  sequence: number
  /** Unix timestamp (ms) when the event was committed. */
  timestamp: number
  /** The player who proposed this event. */
  playerId: string
  type: ProposedEventType
  /** Arbitrary data specific to the event type. */
  payload: T
}

/** A King or Joker card placed face-up as a lock marker. */
export interface LockMarker {
  /** The player whose card is locked. */
  playerId: string
  /** Which slot in the player's hand[cardIndex] is locked. */
  cardIndex: number
  /** The King or Joker card on the table (not in the discard pile). */
  markerCard: Card
}

/** Configuration passed to the GameEngine constructor. */
export interface EngineConfig {
  gameId: string
  playerIds: string[]
  /** Seed for deterministic RNG. Uses Date.now() if omitted. */
  seed?: number
}

/** Discriminated union for USE_POWER payloads. */
export type PowerAction =
  | { power: "peek"; target: "own" }
  | { power: "peek"; target: "opponent"; opponentId: string }
  | { power: "shuffle"; targetPlayerId: string }
  | { power: "swap"; sourcePlayerId: string; sourceCardIndex: number; targetPlayerId: string; targetCardIndex: number }
  | { power: "lock"; targetPlayerId: string; cardIndex: number }
  | { power: "joker"; mimicRank: Rank; action: PowerAction }

/** Result of a Peek power action — shows which cards were viewed. */
export interface PeekResult {
  /** The player whose cards were peeked at. */
  playerId: string
  /** The cards that were revealed. For opponent peek, only 1 card. */
  cards: { index: number; card: Card }[]
}

/** Returned by every GameEngine method call. */
export interface EngineResult {
  /** The resulting game state after applying the event. */
  nextState: Game
  /** Events newly committed in this action. */
  events: CommittedEvent[]
  /** Actions the current player can take next. */
  validEvents: ProposedEventType[]
  /** Present when the action was rejected. Describes why. */
  error?: string
  /** Present when the resolved power was a Peek (10). */
  peekResult?: PeekResult
}

/** Per-player information visible to a specific client. */
export interface VisiblePlayerState {
  id: string
  name: string
  /** Lock markers on this player's cards (visible to all). */
  lockedCards: { index: number; markerCard: Card }[]
  /** Total cards held (always 4 in normal play). */
  handSize: number
  /** Whether this player is the current turn holder. */
  isCurrentTurn: boolean
}

/** Game state filtered for one player (respects visibility rules). */
export interface VisibleGameState {
  id: string
  state: GameState
  players: VisiblePlayerState[]
  /** Top card is at index [discardPile.length - 1]. */
  discardPile: Card[]
  /** Number of cards remaining in the draw pile. */
  deckSize: number
  /** Index into `players` — whose turn it is. */
  currentTurn: number
  /** Player who called showdown, if any. */
  callerId?: string
  /** Own hand cards — only populated during initial_reveal and finished states. */
  myHand?: { index: number; card: PlayerCard }[]
  /** All active lock markers, visible to every player. */
  lockMarkers: LockMarker[]
}

/** Maximum number of players supported. */
export const MAX_PLAYERS = 6
/** Minimum number of players required. */
export const MIN_PLAYERS = 2
/** Cards dealt to each player. */
export const HAND_SIZE = 4
/** Full turns each player must complete before showdown can be called. */
export const MIN_TURNS_BEFORE_SHOWDOWN = 2