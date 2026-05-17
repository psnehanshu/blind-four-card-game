# Blind Four — Core Engine Specification

## Overview

Turn-based multiplayer memory card game.

- 2–6 players
- 4 hidden cards/player
- goal: lowest total
- players briefly view own cards once at round start
- cards remain hidden afterward
- server authoritative
- deterministic event-driven engine

Locked cards use visible face-up King/Joker markers.

---

# Deck

54 cards (52 + 2 Jokers).

| Card  | Value      |
| ----- | ---------- |
| A     | 1          |
| 2–6   | face value |
| 7     | 0          |
| 8–10  | face value |
| J     | 11         |
| Q     | 12         |
| K     | 13         |
| Joker | 20         |

---

# Powers

## 10 — Peek

- view all own cards OR 1 opponent card privately
- no ownership/position changes
- visibility unaffected for others

## Jack — Shuffle

- shuffle target player's 4 card positions randomly
- cards remain hidden
- ownership/lock state preserved

## Queen — Swap

- swap 1 chosen card between 2 players
- swapped cards remain hidden
- locked cards cannot swap

## King — Lock

- lock chosen card
- King placed face-up as lock marker
- locked cards cannot replace/swap
- may target self/others
- King removed from discard circulation until round end

## Joker — Wild

- when discarded, mimics any power card
- retains score value 20
- if mimicking King, Joker becomes lock marker
- Joker lock markers behave like King lock markers

---

# Round Setup

1. shuffle
2. deal 4 face-down cards/player
3. players privately view own cards once
4. arrange cards strategically
5. hide cards
6. first turn begins

---

# Turn Flow

## Draw

Choose one:

- draw deck top
- draw discard top

Rules:

- only top discard drawable
- discard draws are public
- deck draws private until revealed/discarded

## Decision

Choose one:

- replace non-locked hand card
- discard drawn card

## Power Resolution

- powers activate only when card enters discard pile
- discarded card may originate from draw or replaced hand card
- powers resolve immediately after discard
- discarded power cards stay visible in discard pile
- discard-drawn power cards activate only on future discard
- King/Joker lock markers never re-enter discard until round end

## End Turn

Advance turn.

---

# Showdown

A player may call SHOWDOWN only during their turn, after discarding/resolving powers, and only after every player completes 2 turns.

Rules:

- caller gets no more turns
- every other player gets exactly 1 final turn
- then reveal all cards and score

Caller wins only if:

```text
caller_total < every_other_player_total
```

Tie against caller = caller loses, tied non-caller wins.

---

# Visibility

| Information             | Visible To |
| ----------------------- | ---------- |
| own cards during reveal | owner      |
| own cards afterward     | hidden     |
| opponent cards          | hidden     |
| lock markers            | everyone   |
| discard pile            | everyone   |
| deck size               | everyone   |

---

# Data Model

```ts
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
```

---

# Engine Architecture

## Core Principles

- server authoritative
- clients untrusted
- deterministic state machine
- pure reducers
- replayable event log
- no UI/networking logic in engine

## Flow

```text
Client Proposed Event
    ↓
Validation
    ↓
Commit To Event Log
    ↓
Reducer Transition
    ↓
Broadcast State + Valid Events
```

## Event Model

```ts
export type ProposedEventType =
  | "DRAW_CARD"
  | "REPLACE_CARD"
  | "DISCARD_DRAWN"
  | "CALL_SHOWDOWN"
  | "USE_POWER"

export interface CommittedEvent<T = unknown> {
  id: string
  sequence: number
  timestamp: number
  playerId: string
  type: ProposedEventType
  payload: T
}
```

State derivation:

```text
Initial State + Event Log = Current State
```

Reducer:

```ts
const nextState = reducer(currentState, committedEvent)
```

Engine response:

```ts
interface EngineResult {
  nextState: Game
  events: CommittedEvent[]
  validEvents: ProposedEventType[]
}
```

## Validation

- correct turn only
- no double draw
- no replacing/swapping locked cards
- no hidden info leaks
- invalid targets rejected

## Determinism

- seeded RNG
- replayable outcomes
- serializable state/events

## MVP

Included:

- local engine
- multiplayer-ready architecture
- showdown logic
- powers
- deterministic rules

Excluded:

- matchmaking
- persistence
- bots
- spectators
- reconnect recovery
- animations

