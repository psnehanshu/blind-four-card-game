export type Suit = "hearts" | "diamonds" | "clubs" | "spades"

export type Rank =
  | "A" | "2" | "3" | "4" | "5" | "6"
  | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "JOKER"

export interface Card {
  id: string
  suit?: Suit
  rank: Rank
  value: number
}

export interface PlayerCard {
  card: Card
  locked: boolean
}

export interface Player {
  id: string
  name: string
  hand: [PlayerCard, PlayerCard, PlayerCard, PlayerCard]
  connected: boolean
}

export type GameState =
  | "waiting"
  | "initial_reveal"
  | "in_progress"
  | "showdown"
  | "finished"

export interface Game {
  id: string
  players: Player[]
  deck: Card[]
  discardPile: Card[]
  currentTurn: number
  state: GameState
  callerId?: string
}

export type TurnPhase =
  | "draw"
  | "decision"
  | "power"
  | "showdown_eligible"

export type ProposedEventType =
  | "DRAW_CARD"
  | "REPLACE_CARD"
  | "DISCARD_DRAWN"
  | "CALL_SHOWDOWN"
  | "USE_POWER"
  | "END_TURN"

export interface CommittedEvent<T = unknown> {
  id: string
  sequence: number
  timestamp: number
  playerId: string
  type: ProposedEventType
  payload: T
}

export interface LockMarker {
  playerId: string
  cardIndex: number
  markerCard: Card
}

export interface EngineConfig {
  gameId: string
  playerIds: string[]
  seed?: number
}

export type PowerAction =
  | { power: "peek"; target: "own" }
  | { power: "peek"; target: "opponent"; opponentId: string }
  | { power: "shuffle"; targetPlayerId: string }
  | { power: "swap"; sourcePlayerId: string; sourceCardIndex: number; targetPlayerId: string; targetCardIndex: number }
  | { power: "lock"; targetPlayerId: string; cardIndex: number }
  | { power: "joker"; mimicRank: Rank; action: PowerAction }

export interface PeekResult {
  playerId: string
  cards: Array<{ index: number; card: Card }>
}

export interface EngineResult {
  nextState: Game
  events: CommittedEvent[]
  validEvents: ProposedEventType[]
  error?: string
  peekResult?: PeekResult
}

export interface VisiblePlayerState {
  id: string
  name: string
  lockedCards: Array<{ index: number; markerCard: Card }>
  handSize: number
  isCurrentTurn: boolean
}

export interface VisibleGameState {
  id: string
  state: GameState
  players: VisiblePlayerState[]
  discardPile: Card[]
  deckSize: number
  currentTurn: number
  callerId?: string
  myHand?: Array<{ index: number; card: PlayerCard }>
  lockMarkers: LockMarker[]
}

export const MAX_PLAYERS = 6
export const MIN_PLAYERS = 2
export const HAND_SIZE = 4
export const MIN_TURNS_BEFORE_SHOWDOWN = 2