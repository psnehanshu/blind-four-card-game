import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CommittedEvent, EventPayloadMap, ProposedEventType } from "../engine/types.js";

export type GameStatus = "lobby" | "running" | "finished";

export interface GameRow {
  id: string;
  status: GameStatus;
  hostPlayerId: string;
  playerIds: string[];
  displayNames: Record<string, string>;
  /** Subset of playerIds occupied by server-driven bots (no socket binding). */
  botPlayerIds: string[];
  seed: number | null;
  createdAt: number;
  startedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL,
  host_player_id  TEXT NOT NULL,
  player_ids      TEXT NOT NULL,
  display_names   TEXT NOT NULL,
  bot_player_ids  TEXT NOT NULL DEFAULT '[]',
  seed            INTEGER,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  game_id   TEXT NOT NULL REFERENCES games(id),
  sequence  INTEGER NOT NULL,
  event_id  TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  type      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (game_id, sequence)
);

CREATE TABLE IF NOT EXISTS sessions (
  token     TEXT PRIMARY KEY,
  game_id   TEXT NOT NULL,
  player_id TEXT NOT NULL
);
`;

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function asString(x: unknown, field: string): string {
  if (typeof x !== "string") throw new Error(`Expected string for ${field}`);
  return x;
}

function asNumber(x: unknown, field: string): number {
  if (typeof x !== "number") throw new Error(`Expected number for ${field}`);
  return x;
}

function asNumberOrNull(x: unknown, field: string): number | null {
  if (x === null) return null;
  return asNumber(x, field);
}

function parseStatus(s: string): GameStatus {
  if (s === "lobby" || s === "running" || s === "finished") return s;
  throw new Error(`Invalid game status: ${s}`);
}

function parseStringArray(json: string, field: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error(`${field} not an array`);
  const out: string[] = [];
  for (const v of parsed) {
    if (typeof v !== "string") throw new Error(`${field} contains non-string`);
    out.push(v);
  }
  return out;
}

function parseStringMap(json: string, field: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error(`${field} not an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string") throw new Error(`${field} contains non-string value`);
    out[k] = v;
  }
  return out;
}

function toGameRow(raw: unknown): GameRow {
  if (!isRecord(raw)) throw new Error("game row not an object");
  const botRaw = raw.bot_player_ids;
  const botJson = typeof botRaw === "string" ? botRaw : "[]";
  return {
    id: asString(raw.id, "id"),
    status: parseStatus(asString(raw.status, "status")),
    hostPlayerId: asString(raw.host_player_id, "host_player_id"),
    playerIds: parseStringArray(asString(raw.player_ids, "player_ids"), "player_ids"),
    displayNames: parseStringMap(asString(raw.display_names, "display_names"), "display_names"),
    botPlayerIds: parseStringArray(botJson, "bot_player_ids"),
    seed: asNumberOrNull(raw.seed, "seed"),
    createdAt: asNumber(raw.created_at, "created_at"),
    startedAt: asNumberOrNull(raw.started_at, "started_at"),
  };
}

function parseProposedEventType(s: string): ProposedEventType {
  switch (s) {
    case "ACKNOWLEDGE_REVEAL":
    case "DRAW_CARD":
    case "REPLACE_CARD":
    case "DISCARD_DRAWN":
    case "CALL_SHOWDOWN":
    case "USE_POWER":
    case "END_TURN":
      return s;
    default:
      throw new Error(`Invalid event type: ${s}`);
  }
}

function isPowerAction(x: unknown): x is EventPayloadMap["USE_POWER"] {
  // We trust the engine wrote a valid PowerAction; just shape-check.
  return isRecord(x) && typeof x.power === "string";
}

function toCommittedEvent(raw: unknown): CommittedEvent {
  if (!isRecord(raw)) throw new Error("event row not an object");
  const type = parseProposedEventType(asString(raw.type, "type"));
  const parsedPayload: unknown = JSON.parse(asString(raw.payload, "payload"));
  const base = {
    id: asString(raw.event_id, "event_id"),
    sequence: asNumber(raw.sequence, "sequence"),
    timestamp: asNumber(raw.timestamp, "timestamp"),
    playerId: asString(raw.player_id, "player_id"),
  };
  if (type === "DRAW_CARD") {
    if (!isRecord(parsedPayload)) throw new Error("DRAW_CARD missing payload");
    const src = parsedPayload.source;
    if (src !== "deck" && src !== "discard") throw new Error("DRAW_CARD payload.source invalid");
    return { ...base, type, payload: { source: src } };
  }
  if (type === "REPLACE_CARD") {
    if (!isRecord(parsedPayload)) throw new Error("REPLACE_CARD missing payload");
    const idx = parsedPayload.handIndex;
    if (typeof idx !== "number") throw new Error("REPLACE_CARD payload.handIndex invalid");
    return { ...base, type, payload: { handIndex: idx } };
  }
  if (type === "USE_POWER") {
    if (!isPowerAction(parsedPayload)) throw new Error("USE_POWER missing payload");
    return { ...base, type, payload: parsedPayload };
  }
  return { ...base, type, payload: undefined };
}

export interface CreateLobbyArgs {
  gameId: string;
  hostPlayerId: string;
  hostDisplayName: string;
}

export class Store {
  private db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Apply forward-only migrations for DBs created by older schema versions. */
  private migrate(): void {
    const rawCols: unknown = this.db.pragma("table_info(games)");
    if (!Array.isArray(rawCols)) return;
    const hasBotColumn = rawCols.some((c) => isRecord(c) && c.name === "bot_player_ids");
    if (!hasBotColumn) {
      this.db.exec("ALTER TABLE games ADD COLUMN bot_player_ids TEXT NOT NULL DEFAULT '[]'");
    }
  }

  close(): void {
    this.db.close();
  }

  createLobby({ gameId, hostPlayerId, hostDisplayName }: CreateLobbyArgs): void {
    this.db
      .prepare(
        "INSERT INTO games (id, status, host_player_id, player_ids, display_names, seed, created_at, started_at) VALUES (?, 'lobby', ?, ?, ?, NULL, ?, NULL)",
      )
      .run(
        gameId,
        hostPlayerId,
        JSON.stringify([hostPlayerId]),
        JSON.stringify({ [hostPlayerId]: hostDisplayName }),
        Date.now(),
      );
  }

  addLobbyPlayer(gameId: string, playerId: string, displayName: string): void {
    const game = this.loadGameRow(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);
    if (game.status !== "lobby") throw new Error("Cannot join — game already started");
    if (game.playerIds.includes(playerId)) return;
    const playerIds = [...game.playerIds, playerId];
    const displayNames = { ...game.displayNames, [playerId]: displayName };
    this.db
      .prepare("UPDATE games SET player_ids = ?, display_names = ? WHERE id = ?")
      .run(JSON.stringify(playerIds), JSON.stringify(displayNames), gameId);
  }

  /** Add a bot seat to the lobby. Bot occupies a player slot but has no
   *  socket — the server drives its turns directly. */
  addLobbyBot(gameId: string, botId: string, displayName: string): void {
    const game = this.loadGameRow(gameId);
    if (!game) throw new Error(`Game not found: ${gameId}`);
    if (game.status !== "lobby") throw new Error("Cannot add bot — game already started");
    if (game.playerIds.includes(botId)) return;
    const playerIds = [...game.playerIds, botId];
    const displayNames = { ...game.displayNames, [botId]: displayName };
    const botPlayerIds = [...game.botPlayerIds, botId];
    this.db
      .prepare("UPDATE games SET player_ids = ?, display_names = ?, bot_player_ids = ? WHERE id = ?")
      .run(JSON.stringify(playerIds), JSON.stringify(displayNames), JSON.stringify(botPlayerIds), gameId);
  }

  startGame(gameId: string, seed: number, orderedPlayerIds: string[]): void {
    this.db
      .prepare("UPDATE games SET status = 'running', seed = ?, player_ids = ?, started_at = ? WHERE id = ?")
      .run(seed, JSON.stringify(orderedPlayerIds), Date.now(), gameId);
  }

  appendEvents(gameId: string, events: CommittedEvent[], finished: boolean): void {
    const insertEvent = this.db.prepare(
      "INSERT INTO events (game_id, sequence, event_id, timestamp, player_id, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const setFinished = this.db.prepare("UPDATE games SET status = 'finished' WHERE id = ?");

    const tx = this.db.transaction((rows: CommittedEvent[]) => {
      for (const e of rows) {
        insertEvent.run(gameId, e.sequence, e.id, e.timestamp, e.playerId, e.type, JSON.stringify(e.payload ?? null));
      }
      if (finished) setFinished.run(gameId);
    });
    tx(events);
  }

  loadGameRow(gameId: string): GameRow | null {
    const raw: unknown = this.db.prepare("SELECT * FROM games WHERE id = ?").get(gameId);
    if (!raw) return null;
    return toGameRow(raw);
  }

  loadEvents(gameId: string): CommittedEvent[] {
    const rows: unknown[] = this.db
      .prepare(
        "SELECT sequence, event_id, timestamp, player_id, type, payload FROM events WHERE game_id = ? ORDER BY sequence ASC",
      )
      .all(gameId);
    const out: CommittedEvent[] = [];
    for (const r of rows) out.push(toCommittedEvent(r));
    return out;
  }

  createSession(gameId: string, playerId: string): string {
    const token = randomBytes(24).toString("hex");
    this.db.prepare("INSERT INTO sessions (token, game_id, player_id) VALUES (?, ?, ?)").run(token, gameId, playerId);
    return token;
  }

  resolveSession(token: string): { gameId: string; playerId: string } | null {
    const raw: unknown = this.db.prepare("SELECT game_id, player_id FROM sessions WHERE token = ?").get(token);
    if (!isRecord(raw)) return null;
    return {
      gameId: asString(raw.game_id, "game_id"),
      playerId: asString(raw.player_id, "player_id"),
    };
  }
}
