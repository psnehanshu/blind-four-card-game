import type Database from "better-sqlite3";
import { Umzug, type MigrationParams, type UmzugStorage } from "umzug";

const MIGRATIONS_TABLE = "_migrations";

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function hasStringName(x: unknown): x is { name: string } {
  return isRecord(x) && typeof x.name === "string";
}

function sqliteStorage(db: Database.Database): UmzugStorage<Database.Database> {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       name        TEXT PRIMARY KEY,
       executed_at INTEGER NOT NULL
     )`,
  );
  const insert = db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, executed_at) VALUES (?, ?)`);
  const remove = db.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = ?`);
  const list = db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name ASC`);
  return {
    logMigration: ({ name }) => {
      insert.run(name, Date.now());
      return Promise.resolve();
    },
    unlogMigration: ({ name }) => {
      remove.run(name);
      return Promise.resolve();
    },
    executed: () => {
      const rows: unknown[] = list.all();
      const out: string[] = [];
      for (const r of rows) {
        if (hasStringName(r)) out.push(r.name);
      }
      return Promise.resolve(out);
    },
  };
}

type MigrationFn = (params: MigrationParams<Database.Database>) => Promise<void>;

interface Migration {
  name: string;
  up: MigrationFn;
}

const migrations: Migration[] = [
  {
    name: "001-initial-schema",
    up: ({ context: db }) => {
      db.exec(`
        CREATE TABLE games (
          id              TEXT PRIMARY KEY,
          status          TEXT NOT NULL,
          host_player_id  TEXT NOT NULL,
          player_ids      TEXT NOT NULL,
          display_names   TEXT NOT NULL,
          seed            INTEGER,
          created_at      INTEGER NOT NULL,
          started_at      INTEGER
        );
        CREATE TABLE events (
          game_id   TEXT NOT NULL REFERENCES games(id),
          sequence  INTEGER NOT NULL,
          event_id  TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          player_id TEXT NOT NULL,
          type      TEXT NOT NULL,
          payload   TEXT NOT NULL,
          PRIMARY KEY (game_id, sequence)
        );
        CREATE TABLE sessions (
          token     TEXT PRIMARY KEY,
          game_id   TEXT NOT NULL,
          player_id TEXT NOT NULL
        );
      `);
      return Promise.resolve();
    },
  },
  {
    name: "002-add-bot-player-ids",
    up: ({ context: db }) => {
      db.exec("ALTER TABLE games ADD COLUMN bot_player_ids TEXT NOT NULL DEFAULT '[]'");
      return Promise.resolve();
    },
  },
];

export async function runMigrations(db: Database.Database): Promise<void> {
  const storage = sqliteStorage(db);
  const umzug = new Umzug({
    migrations,
    context: db,
    storage,
    logger: undefined,
  });
  await umzug.up();
}
