import type { Server, Socket } from "socket.io";
import { randomBytes } from "node:crypto";
import type { CommittedEvent, EngineResult, PeekResult, PowerAction, ProposedEventType } from "../engine/types.js";
import { MAX_PLAYERS } from "../engine/types.js";
import { GameManager } from "./game-manager.js";
import { Store } from "./store.js";
import { MSG_CHANNEL, type ClientMsg, type ServerMsg } from "./wire.js";

interface SocketData {
  gameId?: string;
  playerId?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function asProposedEventType(x: unknown): ProposedEventType | null {
  if (x === "ACKNOWLEDGE_REVEAL") return x;
  if (x === "DRAW_CARD") return x;
  if (x === "REPLACE_CARD") return x;
  if (x === "DISCARD_DRAWN") return x;
  if (x === "CALL_SHOWDOWN") return x;
  if (x === "USE_POWER") return x;
  if (x === "END_TURN") return x;
  return null;
}

function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isRecord(raw)) return null;
  const { kind } = raw;
  if (kind === "CREATE_GAME") {
    if (typeof raw.displayName !== "string") return null;
    const seed = typeof raw.seed === "number" ? raw.seed : undefined;
    return seed === undefined ? { kind, displayName: raw.displayName } : { kind, displayName: raw.displayName, seed };
  }
  if (kind === "JOIN_GAME") {
    if (typeof raw.gameId !== "string" || typeof raw.displayName !== "string") return null;
    const token = typeof raw.sessionToken === "string" ? raw.sessionToken : undefined;
    return token === undefined
      ? { kind, gameId: raw.gameId, displayName: raw.displayName }
      : { kind, gameId: raw.gameId, displayName: raw.displayName, sessionToken: token };
  }
  if (kind === "START_GAME") {
    if (typeof raw.gameId !== "string") return null;
    return { kind, gameId: raw.gameId };
  }
  if (kind === "GAME_EVENT") {
    if (typeof raw.gameId !== "string") return null;
    const type = asProposedEventType(raw.type);
    if (!type) return null;
    return { kind, gameId: raw.gameId, type, payload: raw.payload };
  }
  if (kind === "REQUEST_STATE") {
    if (typeof raw.gameId !== "string") return null;
    return { kind, gameId: raw.gameId };
  }
  return null;
}

function send(socket: Socket, msg: ServerMsg): void {
  socket.emit(MSG_CHANNEL, msg);
}

function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function newGameId(): string {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

function socketData(socket: Socket): SocketData {
  if (!isRecord(socket.data)) {
    socket.data = {};
  }
  // socket.data is `any` by default in socket.io types; treat it as our SocketData.
  return socket.data;
}

export function attachSocketHandlers(io: Server, store: Store, manager: GameManager): void {
  io.on("connection", (socket: Socket) => {
    // Ensure socket.data is our SocketData shape.
    socketData(socket);

    socket.on(MSG_CHANNEL, (raw: unknown) => {
      const msg = parseClientMsg(raw);
      if (!msg) {
        send(socket, { kind: "ERROR", message: "Malformed message" });
        return;
      }

      try {
        if (msg.kind === "CREATE_GAME") {
          void handleCreateGame(socket, io, store, msg.displayName);
        } else if (msg.kind === "JOIN_GAME") {
          void handleJoinGame(socket, io, store, manager, msg);
        } else if (msg.kind === "START_GAME") {
          void handleStartGame(socket, io, store, manager, msg.gameId);
        } else if (msg.kind === "GAME_EVENT") {
          void handleGameEvent(socket, io, store, manager, msg);
        } else if (msg.kind === "REQUEST_STATE") {
          handleRequestState(socket, store, manager, msg.gameId);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send(socket, { kind: "ERROR", message });
      }
    });
  });
}

async function handleCreateGame(socket: Socket, io: Server, store: Store, displayName: string): Promise<void> {
  const gameId = newGameId();
  const playerId = shortId("p");
  store.createLobby({ gameId, hostPlayerId: playerId, hostDisplayName: displayName });
  const token = store.createSession(gameId, playerId);
  const data = socketData(socket);
  data.gameId = gameId;
  data.playerId = playerId;
  await socket.join(gameId);
  send(socket, { kind: "WELCOME", gameId, playerId, sessionToken: token, hostPlayerId: playerId });
  broadcastLobby(io, store, gameId);
}

async function handleJoinGame(
  socket: Socket,
  io: Server,
  store: Store,
  manager: GameManager,
  msg: { gameId: string; displayName: string; sessionToken?: string },
): Promise<void> {
  const row = store.loadGameRow(msg.gameId);
  if (!row) {
    send(socket, { kind: "ERROR", message: `No game with id ${msg.gameId}` });
    return;
  }

  // Token resume path.
  if (msg.sessionToken) {
    const resolved = store.resolveSession(msg.sessionToken);
    if (resolved && resolved.gameId === msg.gameId) {
      const data = socketData(socket);
      data.gameId = msg.gameId;
      data.playerId = resolved.playerId;
      await socket.join(msg.gameId);
      send(socket, {
        kind: "WELCOME",
        gameId: msg.gameId,
        playerId: resolved.playerId,
        sessionToken: msg.sessionToken,
        hostPlayerId: row.hostPlayerId,
      });
      if (row.status === "lobby") {
        broadcastLobby(io, store, msg.gameId);
      } else {
        // Token resume on a running game: refresh only the rejoiner. The rest
        // of the room hasn't changed and doesn't need another STATE push.
        sendStateTo(socket, store, manager, msg.gameId, resolved.playerId);
      }
      return;
    }
  }

  // Fresh join.
  if (row.status !== "lobby") {
    send(socket, { kind: "ERROR", message: "Game already started — cannot join as a new player" });
    return;
  }
  if (row.playerIds.length >= MAX_PLAYERS) {
    send(socket, { kind: "ERROR", message: "Lobby is full" });
    return;
  }
  const playerId = shortId("p");
  store.addLobbyPlayer(msg.gameId, playerId, msg.displayName);
  const token = store.createSession(msg.gameId, playerId);
  const data = socketData(socket);
  data.gameId = msg.gameId;
  data.playerId = playerId;
  await socket.join(msg.gameId);
  send(socket, { kind: "WELCOME", gameId: msg.gameId, playerId, sessionToken: token, hostPlayerId: row.hostPlayerId });
  broadcastLobby(io, store, msg.gameId);
}

async function handleStartGame(
  socket: Socket,
  io: Server,
  store: Store,
  manager: GameManager,
  gameId: string,
): Promise<void> {
  const data = socketData(socket);
  const row = store.loadGameRow(gameId);
  if (!row) {
    send(socket, { kind: "ERROR", message: "No such game" });
    return;
  }
  if (data.playerId !== row.hostPlayerId) {
    send(socket, { kind: "ERROR", message: "Only the host can start the game" });
    return;
  }
  if (row.status !== "lobby") {
    send(socket, { kind: "ERROR", message: "Game already started" });
    return;
  }
  if (row.playerIds.length < 2) {
    send(socket, { kind: "ERROR", message: "Need at least 2 players to start" });
    return;
  }
  const seed = Date.now();
  // Rotate the lobby order so the first turn lands on a random player. Turn
  // order (round-robin) is the array order, so rotating preserves the
  // join-order rhythm while randomizing who goes first. The rotated array is
  // persisted, so replays + hydration see the same turn sequence.
  const startOffset = Math.floor(Math.random() * row.playerIds.length);
  const turnOrder = [...row.playerIds.slice(startOffset), ...row.playerIds.slice(0, startOffset)];
  store.startGame(gameId, seed, turnOrder);
  manager.startEngine(gameId, turnOrder, seed);
  await broadcastState(io, store, manager, gameId, [], undefined, undefined);
}

/** Type guard mirroring engine.isPowerPayload — we trust the engine to deep-validate. */
function isPowerActionShape(p: unknown): p is PowerAction {
  return isRecord(p) && typeof p.power === "string";
}

function dispatchGameEvent(
  manager: GameManager,
  gameId: string,
  playerId: string,
  type: ProposedEventType,
  payload: unknown,
): EngineResult {
  if (type === "ACKNOWLEDGE_REVEAL") return manager.process(gameId, playerId, "ACKNOWLEDGE_REVEAL", undefined);
  if (type === "DISCARD_DRAWN") return manager.process(gameId, playerId, "DISCARD_DRAWN", undefined);
  if (type === "CALL_SHOWDOWN") return manager.process(gameId, playerId, "CALL_SHOWDOWN", undefined);
  if (type === "END_TURN") return manager.process(gameId, playerId, "END_TURN", undefined);
  if (type === "DRAW_CARD") {
    if (!isRecord(payload)) throw new Error("DRAW_CARD payload required");
    const src = payload.source;
    if (src !== "deck" && src !== "discard") throw new Error("DRAW_CARD source invalid");
    return manager.process(gameId, playerId, "DRAW_CARD", { source: src });
  }
  if (type === "REPLACE_CARD") {
    if (!isRecord(payload)) throw new Error("REPLACE_CARD payload required");
    const idx = payload.handIndex;
    if (typeof idx !== "number") throw new Error("REPLACE_CARD handIndex required");
    return manager.process(gameId, playerId, "REPLACE_CARD", { handIndex: idx });
  }
  // USE_POWER.
  if (!isPowerActionShape(payload)) throw new Error("USE_POWER payload required");
  return manager.process(gameId, playerId, "USE_POWER", payload);
}

async function handleGameEvent(
  socket: Socket,
  io: Server,
  store: Store,
  manager: GameManager,
  msg: { gameId: string; type: ProposedEventType; payload: unknown },
): Promise<void> {
  const data = socketData(socket);
  if (data.gameId !== msg.gameId || !data.playerId) {
    send(socket, { kind: "ERROR", message: "Not joined to this game" });
    return;
  }
  let result: EngineResult;
  try {
    result = dispatchGameEvent(manager, msg.gameId, data.playerId, msg.type, msg.payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    send(socket, { kind: "ERROR", message });
    return;
  }
  if (result.error) {
    send(socket, { kind: "ERROR", message: result.error });
    return;
  }
  await broadcastState(io, store, manager, msg.gameId, result.events, result.peekResult, data.playerId);
}

function broadcastLobby(io: Server, store: Store, gameId: string): void {
  const row = store.loadGameRow(gameId);
  if (!row) return;
  const players = row.playerIds.map((pid) => ({
    playerId: pid,
    displayName: row.displayNames[pid] ?? pid,
  }));
  const msg: ServerMsg = { kind: "LOBBY", gameId, hostPlayerId: row.hostPlayerId, players };
  io.to(gameId).emit(MSG_CHANNEL, msg);
}

async function broadcastState(
  io: Server,
  store: Store,
  manager: GameManager,
  gameId: string,
  lastEvents: CommittedEvent[],
  peekResult: PeekResult | undefined,
  peekRecipientId: string | undefined,
): Promise<void> {
  const row = store.loadGameRow(gameId);
  if (!row) return;
  const displayNames = row.displayNames;
  const sockets = await io.in(gameId).fetchSockets();
  for (const s of sockets) {
    const recipientPid = isRecord(s.data) && typeof s.data.playerId === "string" ? s.data.playerId : null;
    if (!recipientPid) continue;
    const snap = manager.snapshotFor(
      gameId,
      recipientPid,
      lastEvents,
      recipientPid === peekRecipientId ? peekResult : undefined,
    );
    if (!snap) continue;
    const msg: ServerMsg = {
      kind: "STATE",
      gameId,
      visibleState: snap.visibleState,
      validEvents: snap.validEvents,
      drawnCard: snap.drawnCard,
      lastEvents: snap.lastEvents,
      displayNames,
      ...(snap.winnerIds ? { winnerIds: snap.winnerIds } : {}),
      ...(snap.peekResult ? { peekResult: snap.peekResult } : {}),
    };
    s.emit(MSG_CHANNEL, msg);
  }
}

/**
 * Send a single fresh STATE snapshot to one socket. Used for reconnect /
 * resume / explicit REQUEST_STATE — no `lastEvents` so the client doesn't
 * replay animations or sounds for actions it already processed.
 */
function sendStateTo(socket: Socket, store: Store, manager: GameManager, gameId: string, playerId: string): void {
  const row = store.loadGameRow(gameId);
  if (!row) return;
  const snap = manager.snapshotFor(gameId, playerId, [], undefined);
  if (!snap) return;
  const msg: ServerMsg = {
    kind: "STATE",
    gameId,
    visibleState: snap.visibleState,
    validEvents: snap.validEvents,
    drawnCard: snap.drawnCard,
    lastEvents: [],
    displayNames: row.displayNames,
    ...(snap.winnerIds ? { winnerIds: snap.winnerIds } : {}),
  };
  send(socket, msg);
}

/**
 * Reply to a client's explicit refresh request. Silently no-ops on sockets
 * we don't recognize (e.g., a REQUEST_STATE that races ahead of the
 * post-reconnect JOIN_GAME); the JOIN itself will deliver a fresh snapshot.
 */
function handleRequestState(socket: Socket, store: Store, manager: GameManager, gameId: string): void {
  const data = socketData(socket);
  if (data.gameId !== gameId || !data.playerId) return;
  const row = store.loadGameRow(gameId);
  if (!row) {
    send(socket, { kind: "ERROR", message: "No such game" });
    return;
  }
  if (row.status === "lobby") {
    const players = row.playerIds.map((pid) => ({
      playerId: pid,
      displayName: row.displayNames[pid] ?? pid,
    }));
    send(socket, { kind: "LOBBY", gameId, hostPlayerId: row.hostPlayerId, players });
    return;
  }
  sendStateTo(socket, store, manager, gameId, data.playerId);
}
