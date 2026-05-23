# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project scope

This is **`blind-four`** — the full game, not just the rules. The repo hosts a deterministic game engine, a socket.io-backed game server, and one or more **form factors** (today: a React + Vite web app). Form factors are thin views that talk to the server; the engine never duplicates.

## Repository layout

```
engine/          Core game engine (TypeScript, no I/O). Shared by everything.
engine/SPEC.md   Authoritative rules spec.
server/          Node + socket.io + SQLite server. Lives at root (shares root package.json/tsconfig).
                 Imports the engine via relative path; persists every CommittedEvent.
web/             React + Vite client. Its own package — needs JSX/DOM compiler settings.
                 Talks to the server over socket.io; never owns engine state.
<form-factor>/   New frontends (mobile, terminal, …) go in their own top-level folder
                 alongside web/, with their own package.json + tsconfig.json.
```

The engine + server share the **root** `package.json`, `tsconfig.json`, and `eslint.config.ts`. Only standalone clients (web, future mobile, etc.) carry their own package.

When adding a new form factor:

- give it its own folder and `package.json` + `tsconfig.json` (JSX/DOM needs per-form-factor settings)
- consume the engine via relative import; **never duplicate game logic**
- talk to the server's wire protocol (`server/wire.ts`); never reach into engine state directly
- treat the engine as server-authoritative; clients render `VisibleGameState` and dispatch events

## Commands

- `npm test` — engine + server tests (`tsx --test engine/*.test.ts server/*.test.ts`)
- `npm run typecheck` — `tsc --noEmit` over `engine/**` + `server/**`, then `web`'s own `tsc --noEmit`
- `npm run lint` — ESLint (root config ignores `web/dist`, `web/node_modules`, `web/.vite`, `server/data`)
- `npm run format` / `npm run format:check` — Prettier write / check (also formats `web/src`)
- `npm run sanity` — typecheck + lint + format:check + test, in that order. **Run this after every change.**
- `npm run server:dev` — `tsx watch server/index.ts`, listens on `:3001`. DB file at `server/data/blind-four.db`.
- Run a single test file: `tsx --test engine/rng.test.ts`
- Run a single test by name: `tsx --test --test-name-pattern="same seed" engine/*.test.ts`

### Web form factor

From `web/`:

- `npm install` (one-time)
- `npm run dev` — Vite dev server on `:5173`. Set `VITE_SERVER_URL` to override the default `http://localhost:3001`.
- `npm run typecheck` — `tsc --noEmit` against `web/tsconfig.json`
- `npm run build` / `npm run preview`

## Architecture

`engine/SPEC.md` is the authoritative rules spec — read it before changing game rules.

**Core module: `engine/game-engine.ts`.** `GameEngine` is fully initialized in the constructor (deck shuffled, hands dealt). State starts in `initial_reveal` — every player must `ACKNOWLEDGE_REVEAL` before play begins; once all have ack'd, state transitions to `in_progress`. There is no separate `createGame()` method; `game: Game` is non-nullable.

**Event-sourced, server-authoritative, deterministic.** Every player action goes through:

1. `processEvent(playerId, type, payload)` — public entry
2. `validateEvent` — pure check, returns `string | null`. Validation errors come back as `{ error }` on the result; the engine never throws for invalid client input.
3. `createCommittedEvent` — wraps with id/sequence/timestamp, pushes to `eventLog`
4. `applyEvent` → one of `applyDraw` / `applyReplace` / `applyDiscardDrawn` / `applyCallShowdown` / `applyUsePower` / `applyEndTurn` — trusted reducer; throws on invariant violation (these should be unreachable after validation)
5. `buildResult` packages `nextState`, `events`, `validEvents`, optional `peekResult` / `error`

**Game-state lifecycle** (`GameState` in types.ts): `initial_reveal → in_progress → showdown → finished`. During `initial_reveal`, any player can `ACKNOWLEDGE_REVEAL` independent of turn order; other actions are rejected with "Game has not started yet".

**Turn phase state machine** (`TurnPhase` in types.ts), only meaningful once state is `in_progress`/`showdown`: `draw → decision → (power → )? showdown_eligible`. `getValidEvents` returns the actions allowed for the current phase. Power activation funnels through `discardAndCheckPower(card)`, called by both `applyReplace` (hand card → discard) and `applyDiscardDrawn` (drawn card → discard). Drawing from the discard pile does **not** trigger powers — the spec rule "discard-drawn power cards activate only on future discard" is implemented by `applyDraw` simply not calling `discardAndCheckPower`.

**Powers** (`USE_POWER` payload is a `PowerAction` discriminated union):

- 10 = peek (own = all 4 own cards; opponent = one chosen card via `opponentCardIndex`, must not be self — locked cards may be peeked)
- J = shuffle (target player's unlocked positions, target must not be self; locks preserved in place)
- Q = swap (two **different** players, both cards unlocked)
- K = lock (target's card; King is removed from discard and placed as a face-up `LockMarker`, never re-enters discard)
- Joker = wild; mimics another rank via `mimicRank` + nested `action`. Joker-as-K behaves identically to K.

All four `applyPeek/Shuffle/Swap/Lock` take `BasePowerAction & { power: "<rank>" }` — narrowed by the exhaustive switch in `applyUsePower`.

**Replay.** `GameEngine.fromEventLog(log, config)` rebuilds engine state and **repopulates `eventLog`** with the original committed events (and bumps `eventIdCounter` past them). `getEventLog()` round-trips; continued play picks up the sequence.

**Encapsulation.** `processEvent`'s `EngineResult`, `getVisibleState`, and `getEventLog` are `structuredClone`d before returning so callers can't mutate engine internals. **`getState()` returns the live internal `Game` reference** — documented escape hatch; some tests rely on it for state forcing.

**Visibility.** `getVisibleState(playerId)` hides opponent hands always, and hides own hand except during `state === "initial_reveal"` or `state === "finished"`. `lockMarkers` and `discardPile` are public. At `state === "finished"`, `allHands` is also populated — every player's hand is public per spec, and remote clients (which can't read `engine.getState()`) need it for the final reveal.

## Server + persistence

`server/` is a Node + socket.io server backed by SQLite (`better-sqlite3`). It owns the only `GameEngine` instance per game; clients talk to it via the wire types in `server/wire.ts`.

- **`server/store.ts`** — SQLite wrapper with three append-only tables: `games` (lobby roster, frozen at start, plus seed), `events` (every `CommittedEvent`), `sessions` (per-player token used for reconnect).
- **`server/game-manager.ts`** — in-memory `Map<gameId, GameEngine>`. On cache miss (cold start) hydrates via `GameEngine.fromEventLog(events, { gameId, playerIds, seed })`. No snapshots; the event log is the source of truth.
- **`server/socket.ts`** — message handlers (`CREATE_GAME`, `JOIN_GAME`, `START_GAME`, `GAME_EVENT`). Every accepted event is persisted in a single SQLite transaction before any STATE is broadcast. `STATE` is built per-recipient so visibility (drawn card, peek result) is enforced server-side.
- **`server/index.ts`** — HTTP server boot. `PORT` (default 3001) and `DB_PATH` (default `server/data/blind-four.db`) are env-overridable.

**Identity / reconnect.** The first `WELCOME` returns a `sessionToken`; clients persist it in `localStorage["blind-four:<gameId>"]`. A subsequent `JOIN_GAME { gameId, sessionToken }` resumes the same seat without a new player.

**RNG.** `engine/rng.ts` is a Mulberry32 `SeededRNG`. Seeds via `EngineConfig.seed` (defaults to `Date.now()`). Used for the initial deal and the J/shuffle power. Replay determinism depends on the same seed + same event order.

**Showdown.** Caller may `CALL_SHOWDOWN` only on their turn after the decision/power phase, and only after every player has completed `MIN_TURNS_BEFORE_SHOWDOWN` (=2) turns. Each non-caller gets exactly one final turn; caller is locked out (`Caller gets no more turns`). When all non-callers have taken their final turn, state → `finished`. Winner rules (the `winners` getter): strictly lowest hand-value wins; on a tie that includes the caller, the caller loses and the tied non-caller(s) win.

## Lint / TS quirks worth knowing

- `@typescript-eslint/consistent-type-assertions: "never"` — **no `as` casts**. Use type guards (see `isDrawPayload` / `isReplacePayload` / `isPowerPayload` patterns) or narrow via `if`.
- `@typescript-eslint/no-non-null-assertion: "error"` — **no `!`**. Use `assert.ok(x)` in tests, or `if (!x) throw new Error(...)` in engine code.
- `noUncheckedIndexedAccess: true` — array/Map access returns `T | undefined`. Existing code uses explicit `if (!x) throw` lines after indexed access.

## Conventions observed in this codebase

- Commit subjects are short imperatives ending in a period; bodies explain the _why_. See recent `git log` for style.
- Tests live alongside source (`engine/foo.ts` + `engine/foo.test.ts`).
- Test seeds in `game-engine.test.ts` are chosen for deterministic first-draw ranks (seed 0 = 8, seed 17 = 10, seed 2 = JOKER, seed 9 = Q, seed 999 = K). Reuse these when setting up power-trigger scenarios rather than inventing new seeds.
- Use the `startGame(overrides?)` test helper for any test that needs an `in_progress` engine — it constructs + acks all players. Use `new GameEngine(makeConfig(...))` directly only when probing initial_reveal itself or testing constructor throws.
