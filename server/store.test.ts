import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameEngine } from "../engine/game-engine.js";
import { Store } from "./store.js";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "blind-four-store-"));
  return join(dir, "test.db");
}

describe("Store — persistence round-trip", () => {
  it("create lobby → start → append events → close → reopen → replay matches in-memory engine", () => {
    const file = tmpFile();

    // ── First open: create the game, drive a handful of events, persist. ──
    const store1 = new Store(file);
    const gameId = "GAME1";
    const seed = 42;
    const playerIds = ["alice", "bob"];

    store1.createLobby({ gameId, hostPlayerId: "alice", hostDisplayName: "Alice" });
    store1.addLobbyPlayer(gameId, "bob", "Bob");
    store1.startGame(gameId, seed, playerIds);

    const engine = new GameEngine({ gameId, playerIds, seed });
    const persistResult = (pid: string, evts: ReturnType<typeof engine.processEvent>): void => {
      assert.equal(evts.error, undefined, `engine rejected event for ${pid}`);
      store1.appendEvents(gameId, evts.events, engine.getState().state === "finished");
    };

    persistResult("alice", engine.processEvent("alice", "ACKNOWLEDGE_REVEAL", undefined));
    persistResult("bob", engine.processEvent("bob", "ACKNOWLEDGE_REVEAL", undefined));
    persistResult("alice", engine.processEvent("alice", "DRAW_CARD", { source: "deck" }));
    persistResult("alice", engine.processEvent("alice", "DISCARD_DRAWN", undefined));
    // If the discard triggered a power, skip — keep this test orthogonal to power resolution.
    if (engine.getValidEvents("alice").includes("END_TURN")) {
      persistResult("alice", engine.processEvent("alice", "END_TURN", undefined));
    }

    const expectedLog = engine.getEventLog();
    const expectedVisible = engine.getVisibleState("alice");

    store1.close();

    // ── Second open: hydrate from disk and confirm the replay matches. ──
    const store2 = new Store(file);
    const row = store2.loadGameRow(gameId);
    assert.ok(row);
    assert.equal(row.status, "running");
    assert.equal(row.seed, seed);
    assert.deepEqual(row.playerIds, playerIds);

    const loadedEvents = store2.loadEvents(gameId);
    assert.equal(loadedEvents.length, expectedLog.length);
    if (row.seed === null) throw new Error("seed missing");
    const replayed = GameEngine.fromEventLog(loadedEvents, {
      gameId: row.id,
      playerIds: row.playerIds,
      seed: row.seed,
    });

    assert.deepEqual(replayed.getEventLog(), expectedLog);
    assert.deepEqual(replayed.getVisibleState("alice"), expectedVisible);

    store2.close();
    rmSync(file, { force: true });
  });

  it("sessions round-trip", () => {
    const file = tmpFile();
    const store = new Store(file);
    store.createLobby({ gameId: "G", hostPlayerId: "alice", hostDisplayName: "Alice" });
    const token = store.createSession("G", "alice");
    assert.deepEqual(store.resolveSession(token), { gameId: "G", playerId: "alice" });
    assert.equal(store.resolveSession("nope"), null);
    store.close();
    rmSync(file, { force: true });
  });
});
