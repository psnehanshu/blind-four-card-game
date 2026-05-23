import type { Server, Socket } from "socket.io";
import { randomBytes } from "node:crypto";
import type { CommittedEvent, PeekResult } from "../engine/types.js";
import { MAX_PLAYERS } from "../engine/types.js";
import { GameManager } from "./game-manager.js";
import { Store } from "./store.js";
import { MSG_CHANNEL, type ServerMsg } from "./wire.js";
import { ClientMsgSchema, type GameEventMsg } from "./wire-schema.js";
import z from "zod";

interface SocketData {
  gameId?: string;
  playerId?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
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

/** PlayerIds whose sockets are currently joined to the game's room. The set
 *  reflects live TCP/WebSocket presence — sockets that have disconnected are
 *  already gone from the room by the time this is called. */
async function onlinePlayerIds(io: Server, gameId: string): Promise<string[]> {
  const sockets = await io.in(gameId).fetchSockets();
  const ids = new Set<string>();
  for (const s of sockets) {
    if (isRecord(s.data) && typeof s.data.playerId === "string") {
      ids.add(s.data.playerId);
    }
  }
  return [...ids];
}

export function attachSocketHandlers(io: Server, store: Store, manager: GameManager): void {
  io.on("connection", (socket: Socket) => {
    // Ensure socket.data is our SocketData shape.
    socketData(socket);

    socket.on(MSG_CHANNEL, (raw: unknown) => {
      const res = ClientMsgSchema.safeParse(raw);
      if (!res.success) {
        send(socket, { kind: "ERROR", message: `Malformed message:\n${z.prettifyError(res.error)}` });
        return;
      }
      const msg = res.data;

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
          void handleRequestState(socket, io, store, manager, msg.gameId);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send(socket, { kind: "ERROR", message });
      }
    });

    // Disconnect: socket.io removes the socket from its rooms before this
    // fires, so onlinePlayerIds() will already exclude this seat. Re-broadcast
    // the appropriate room message so peers see the presence drop.
    socket.on("disconnect", () => {
      const data = socketData(socket);
      if (!data.gameId) return;
      const row = store.loadGameRow(data.gameId);
      if (!row) return;
      if (row.status === "lobby") {
        void broadcastLobby(io, store, data.gameId);
      } else {
        void broadcastState(io, store, manager, data.gameId, [], undefined, undefined);
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
  await broadcastLobby(io, store, gameId);
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
        await broadcastLobby(io, store, msg.gameId);
      } else {
        // Token resume on a running game: re-broadcast STATE to everyone so
        // peers see the presence flip back to online for the rejoiner. The
        // rejoiner gets a fresh snapshot in the same pass.
        await broadcastState(io, store, manager, msg.gameId, [], undefined, undefined);
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
  await broadcastLobby(io, store, msg.gameId);
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

async function handleGameEvent(
  socket: Socket,
  io: Server,
  store: Store,
  manager: GameManager,
  msg: GameEventMsg,
): Promise<void> {
  const data = socketData(socket);
  if (data.gameId !== msg.gameId || !data.playerId) {
    send(socket, { kind: "ERROR", message: "Not joined to this game" });
    return;
  }
  const result = manager.process(msg.gameId, data.playerId, msg.type, msg.payload);
  if (result.error) {
    send(socket, { kind: "ERROR", message: result.error });
    return;
  }
  await broadcastState(io, store, manager, msg.gameId, result.events, result.peekResult, data.playerId);
}

async function broadcastLobby(io: Server, store: Store, gameId: string): Promise<void> {
  const row = store.loadGameRow(gameId);
  if (!row) return;
  const players = row.playerIds.map((pid) => ({
    playerId: pid,
    displayName: row.displayNames[pid] ?? pid,
  }));
  const online = await onlinePlayerIds(io, gameId);
  const msg: ServerMsg = {
    kind: "LOBBY",
    gameId,
    hostPlayerId: row.hostPlayerId,
    players,
    onlinePlayerIds: online,
  };
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
  const online = new Set<string>();
  for (const s of sockets) {
    if (isRecord(s.data) && typeof s.data.playerId === "string") online.add(s.data.playerId);
  }
  const onlineList = [...online];
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
      onlinePlayerIds: onlineList,
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
async function sendStateTo(
  socket: Socket,
  io: Server,
  store: Store,
  manager: GameManager,
  gameId: string,
  playerId: string,
): Promise<void> {
  const row = store.loadGameRow(gameId);
  if (!row) return;
  const snap = manager.snapshotFor(gameId, playerId, [], undefined);
  if (!snap) return;
  const online = await onlinePlayerIds(io, gameId);
  const msg: ServerMsg = {
    kind: "STATE",
    gameId,
    visibleState: snap.visibleState,
    validEvents: snap.validEvents,
    drawnCard: snap.drawnCard,
    lastEvents: [],
    displayNames: row.displayNames,
    onlinePlayerIds: online,
    ...(snap.winnerIds ? { winnerIds: snap.winnerIds } : {}),
  };
  send(socket, msg);
}

/**
 * Reply to a client's explicit refresh request. Silently no-ops on sockets
 * we don't recognize (e.g., a REQUEST_STATE that races ahead of the
 * post-reconnect JOIN_GAME); the JOIN itself will deliver a fresh snapshot.
 */
async function handleRequestState(
  socket: Socket,
  io: Server,
  store: Store,
  manager: GameManager,
  gameId: string,
): Promise<void> {
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
    const online = await onlinePlayerIds(io, gameId);
    send(socket, {
      kind: "LOBBY",
      gameId,
      hostPlayerId: row.hostPlayerId,
      players,
      onlinePlayerIds: online,
    });
    return;
  }
  await sendStateTo(socket, io, store, manager, gameId, data.playerId);
}
