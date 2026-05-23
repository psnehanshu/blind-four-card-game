# blind-four

![Blind Four](web/public/logo.png)

A turn-based memory card game. 2–6 players, four hidden cards each, lowest total wins. You see your hand once at deal, then you have to remember what you held.

Deployed at **[blind-four.fly.dev](https://blind-four.fly.dev)**.

The repo holds the **whole game**, not just the rules: a deterministic engine, a socket.io game server, and form factors that render it. Today there is one form factor — a React + Vite web client. New ones (mobile, terminal, …) drop into their own top-level folder; the engine is never duplicated.

## Rules

See [`engine/SPEC.md`](engine/SPEC.md) — the authoritative spec. The short version:

- Deck is 54 cards (52 + 2 Jokers). 7s are worth 0, Jokers 20.
- Each turn: **draw** (deck or discard) → **decide** (replace a hand card or discard the drawn one) → power resolves if the discarded card was 10/J/Q/K/Joker → **end turn**.
- Powers: **10** peeks, **J** shuffles an opponent's unlocked positions, **Q** swaps one card between two players, **K** locks a card in place (the King sits face-up off the hand as a marker), **Joker** mimics any of the above.
- Anyone may **call showdown** on their turn once everyone has had two turns. Caller gets no more turns; every other player takes one final turn; then hands reveal. Caller wins only if strictly lowest.

## Quickstart

```bash
npm install
cd web && npm install && cd ..

# two terminals, or use the combined runner:
npm run dev
# server on :3001, web on :5173
```

Open <http://localhost:5173>, create a game, share the room code with a friend, start.

## Bots

Short on friends? The host can add **Kishore** — a server-driven bot — from the lobby to fill seats. Kishore plays by a handful of hardcoded rules (always draws from the deck, replaces when the drawn card beats the highest unlocked one, calls showdown below 10) with a 30% mistake rate so it isn't a free win. Add more than one and they're auto-numbered: Kishore, Kishore 2, Kishore 3, …

## Repository layout

```text
engine/   Pure TypeScript game engine. No I/O. engine/SPEC.md is the rules spec.
server/   Node + socket.io + SQLite. Shares the root package.json with the engine.
web/      React + Vite client. Its own package (needs JSX/DOM compiler settings).
docker/   Container assets (nginx config, entrypoint).
```

The engine and server share the root `package.json`; only standalone clients (web, future mobile, …) carry their own.

## Architecture in one paragraph

The engine is **event-sourced, server-authoritative, deterministic**. Every player action goes through `processEvent(playerId, type, payload)`, which validates (pure function, returns `string | null`), wraps the event with id/sequence/timestamp, appends it to the engine's log, and reduces the new game state. The server owns the only `GameEngine` instance per game and persists every committed event in SQLite before broadcasting state. On cold start it rebuilds via `GameEngine.fromEventLog`; no snapshots, the event log is the source of truth. Clients render the per-player `VisibleGameState` the server hands them and dispatch events back over the wire schema in `server/wire-schema.ts` (parsed with zod).

## Commands

| Command                           | What it does                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run sanity`                  | typecheck (engine + server + web) → lint → format check → tests. **Run after every change.** |
| `npm test`                        | Engine + server tests via `tsx --test`.                                                      |
| `npm run typecheck`               | `tsc --noEmit` over root, then web.                                                          |
| `npm run lint`                    | ESLint over the root config.                                                                 |
| `npm run format` / `format:check` | Prettier.                                                                                    |
| `npm run server:dev`              | Watch-mode server on `:3001`. SQLite file at `server/data/blind-four.db`.                    |
| `npm run dev`                     | Server + web together.                                                                       |

From `web/`: `npm run dev` (Vite), `npm run typecheck`, `npm run build`, `npm run preview`. Override the backend URL with `VITE_SERVER_URL`.

Env vars for the server: `PORT` (default `3001`), `DB_PATH` (default `server/data/blind-four.db`).

## Deployment

Built as a single nginx-fronted container — see [`Dockerfile`](Dockerfile). nginx serves `web/dist` and proxies `/api` to the in-container node server on one exposed port. Deployed to Fly.io (`fly.toml`), with `data/` mounted as a Fly volume so the SQLite file survives restarts.

## Contributing

- The engine is the source of truth for game rules. Form factors are thin — they render `VisibleGameState` and dispatch events; they never own engine state.
- Tests live alongside source (`engine/foo.ts` + `engine/foo.test.ts`).
- Project conventions (lint rules worth knowing, test seed cookbook, escape-hatch APIs) are documented in [`CLAUDE.md`](CLAUDE.md).
