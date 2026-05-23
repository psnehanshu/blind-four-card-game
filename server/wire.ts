import type { Card, CommittedEvent, PeekResult, ProposedEventType, VisibleGameState } from "../engine/types.js";

export interface LobbyPlayer {
  playerId: string;
  displayName: string;
}

/**
 * Client → Server messages, sent as a single typed "msg" socket.io event.
 * Derived from the zod schema so clients can't drift from the parser.
 */
export type { ClientMsg } from "./wire-schema.js";

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
      /** PlayerIds of seats currently bound to a live socket. Server-managed.
       *  Bots are always included — they have no socket but are always "present". */
      onlinePlayerIds: string[];
      /** PlayerIds occupied by server-driven bots. Subset of players. */
      botPlayerIds: string[];
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
      /** PlayerIds of seats currently bound to a live socket. Server-managed.
       *  Bots are always included — they have no socket but are always "present". */
      onlinePlayerIds: string[];
      /** PlayerIds occupied by server-driven bots. Subset of players. */
      botPlayerIds: string[];
    }
  | { kind: "ERROR"; message: string };

/** Single channel used by both directions. */
export const MSG_CHANNEL = "msg";
