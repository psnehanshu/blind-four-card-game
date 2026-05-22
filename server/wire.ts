import type { Card, CommittedEvent, PeekResult, ProposedEventType, VisibleGameState } from "../engine/types.js";

export interface LobbyPlayer {
  playerId: string;
  displayName: string;
}

/** Client → Server messages, sent as a single typed "msg" socket.io event. */
export type ClientMsg =
  | { kind: "CREATE_GAME"; displayName: string; seed?: number }
  | { kind: "JOIN_GAME"; gameId: string; displayName: string; sessionToken?: string }
  | { kind: "START_GAME"; gameId: string }
  | {
      kind: "GAME_EVENT";
      gameId: string;
      type: ProposedEventType;
      /** Engine deep-validates the payload after we narrow it on the server. */
      payload: unknown;
    }
  /**
   * Pull the latest snapshot for this player on demand. Used by clients that
   * suspect they've drifted (tab returned from background, network blip, etc.)
   * Reply is a single STATE/LOBBY sent only to the requesting socket.
   */
  | { kind: "REQUEST_STATE"; gameId: string };

/** Server → Client messages, broadcast as a single typed "msg" socket.io event. */
export type ServerMsg =
  | {
      kind: "WELCOME";
      gameId: string;
      playerId: string;
      sessionToken: string;
      hostPlayerId: string;
    }
  | {
      kind: "LOBBY";
      gameId: string;
      hostPlayerId: string;
      players: LobbyPlayer[];
      /** PlayerIds of seats currently bound to a live socket. Server-managed. */
      onlinePlayerIds: string[];
    }
  | {
      kind: "STATE";
      gameId: string;
      visibleState: VisibleGameState;
      validEvents: ProposedEventType[];
      drawnCard: Card | null;
      lastEvents: CommittedEvent[];
      /** Only populated when state === "finished". */
      winnerIds?: string[];
      /** Only sent to the player who triggered the Peek. */
      peekResult?: PeekResult;
      /** Display names indexed by playerId — server-managed, not in the engine. */
      displayNames: Record<string, string>;
      /** PlayerIds of seats currently bound to a live socket. Server-managed. */
      onlinePlayerIds: string[];
    }
  | { kind: "ERROR"; message: string };

/** Single channel used by both directions. */
export const MSG_CHANNEL = "msg";
