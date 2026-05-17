# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project scope

This is **`blind-four`** — the full game, not just the rules. The repo will grow to host multiple **form factors** (web, mobile, terminal UI, …), all sharing a single deterministic game engine. As of this writing only the engine exists.

## Repository layout

```
engine/          Core game engine (TypeScript, no I/O). Shared by every form factor.
engine/SPEC.md   Authoritative rules spec.
<form-factor>/   Each frontend lives in its own top-level folder (web/, mobile/, terminal/, …).
                 Add new ones as siblings of engine/.
```

Form-factor folders don't exist yet. When adding one:

- give it its own folder and `package.json` (or convert the root to npm workspaces if multiple land)
- consume the engine via a relative import; **never duplicate game logic**
- treat the engine as server-authoritative even if the form factor runs everything locally — that's what makes a future networked client cheap

## Commands

Current scripts target the engine. Expect them to evolve as form factors land.

- `npm test` — run all engine tests via `tsx --test engine/*.test.ts`
- `npm run typecheck` — `tsc --noEmit` (currently only includes `engine/**/*.ts`; extend `tsconfig.json#include` when adding a form factor)
- `npm run lint` — ESLint
- `npm run format` / `npm run format:check` — Prettier write / check
- `npm run sanity` — typecheck + lint + format:check + test, in that order. **Run this after every change.**
- Run a single test file: `tsx --test engine/rng.test.ts`
- Run a single test by name: `tsx --test --test-name-pattern="same seed" engine/*.test.ts`

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
- J = shuffle (target player's unlocked positions; locks preserved in place)
- Q = swap (two **different** players, both cards unlocked)
- K = lock (target's card; King is removed from discard and placed as a face-up `LockMarker`, never re-enters discard)
- Joker = wild; mimics another rank via `mimicRank` + nested `action`. Joker-as-K behaves identically to K.

All four `applyPeek/Shuffle/Swap/Lock` take `BasePowerAction & { power: "<rank>" }` — narrowed by the exhaustive switch in `applyUsePower`.

**Replay.** `GameEngine.fromEventLog(log, config)` rebuilds engine state and **repopulates `eventLog`** with the original committed events (and bumps `eventIdCounter` past them). `getEventLog()` round-trips; continued play picks up the sequence.

**Encapsulation.** `processEvent`'s `EngineResult`, `getVisibleState`, and `getEventLog` are `structuredClone`d before returning so callers can't mutate engine internals. **`getState()` returns the live internal `Game` reference** — documented escape hatch; some tests rely on it for state forcing.

**Visibility.** `getVisibleState(playerId)` hides opponent hands always, and hides own hand except during `state === "initial_reveal"` or `state === "finished"`. `lockMarkers` and `discardPile` are public.

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
