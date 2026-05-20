import { useEffect, useReducer, useRef, useState } from "react";
import type { Card, EventPayloadMap, PeekResult, ProposedEventType, VisibleGameState } from "../../../engine/types.js";
import type { ServerMsg } from "../../../server/wire.js";
import { send, subscribe } from "./socket.js";
import { deriveCue, type AnimationCue } from "../game/cue.js";
import { playForCue } from "../audio/sound.js";

const CUE_TIMEOUT_MS = 900;

export interface RemoteIdentity {
  gameId: string;
  playerId: string;
  hostPlayerId: string;
  sessionToken: string;
}

export interface LobbyState {
  gameId: string;
  hostPlayerId: string;
  players: { playerId: string; displayName: string }[];
}

export interface RemoteEngine {
  identity: RemoteIdentity | null;
  lobby: LobbyState | null;
  visibleState: VisibleGameState | null;
  validEvents: ProposedEventType[];
  drawnCard: Card | null;
  winnerIds: string[];
  displayNames: Record<string, string>;
  peekResult: PeekResult | null;
  cue: AnimationCue;
  version: number;
  lastError: string | null;
  dispatch: <T extends ProposedEventType>(type: T, payload: EventPayloadMap[T]) => void;
  clearPeek: () => void;
  clearError: () => void;
}

interface Pending {
  type: "CREATE";
  displayName: string;
}

interface JoinSpec {
  type: "JOIN";
  gameId: string;
  displayName: string;
  sessionToken?: string;
}

type InitialAction = Pending | JoinSpec | null;

export function useRemoteEngine(initial: InitialAction): RemoteEngine {
  const [identity, setIdentity] = useState<RemoteIdentity | null>(null);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [visibleState, setVisibleState] = useState<VisibleGameState | null>(null);
  const [validEvents, setValidEvents] = useState<ProposedEventType[]>([]);
  const [drawnCard, setDrawnCard] = useState<Card | null>(null);
  const [winnerIds, setWinnerIds] = useState<string[]>([]);
  const [displayNames, setDisplayNames] = useState<Record<string, string>>({});
  const [peekResult, setPeekResult] = useState<PeekResult | null>(null);
  const [cue, setCue] = useState<AnimationCue>(null);
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const [lastError, setLastError] = useState<string | null>(null);

  const nonceRef = useRef(0);
  const initialFiredRef = useRef(false);
  const identityRef = useRef<RemoteIdentity | null>(null);
  identityRef.current = identity;

  // Subscribe to server messages.
  useEffect(() => {
    const unsubscribe = subscribe((msg: ServerMsg) => {
      if (msg.kind === "WELCOME") {
        const id: RemoteIdentity = {
          gameId: msg.gameId,
          playerId: msg.playerId,
          hostPlayerId: msg.hostPlayerId,
          sessionToken: msg.sessionToken,
        };
        setIdentity(id);
        try {
          window.localStorage.setItem(`blind-four:${msg.gameId}`, msg.sessionToken);
        } catch {
          // localStorage may be disabled; reconnect-by-token simply won't work in that case.
        }
        return;
      }
      if (msg.kind === "LOBBY") {
        setLobby({ gameId: msg.gameId, hostPlayerId: msg.hostPlayerId, players: msg.players });
        return;
      }
      if (msg.kind === "STATE") {
        setVisibleState(msg.visibleState);
        setValidEvents(msg.validEvents);
        setDrawnCard(msg.drawnCard);
        setDisplayNames(msg.displayNames);
        setWinnerIds(msg.winnerIds ?? []);
        bump();
        if (msg.peekResult) setPeekResult(msg.peekResult);
        // Animation cues + sound: replay each newly-committed event through deriveCue.
        for (const e of msg.lastEvents) {
          nonceRef.current += 1;
          const next = deriveCue(e.type, e.payload, nonceRef.current);
          if (next) {
            setCue(next);
            playForCue(next);
          }
        }
        return;
      }
      if (msg.kind === "ERROR") {
        setLastError(msg.message);
      }
    });
    return unsubscribe;
  }, []);

  // Fire the initial CREATE_GAME or JOIN_GAME once.
  useEffect(() => {
    if (initialFiredRef.current || !initial) return;
    initialFiredRef.current = true;
    if (initial.type === "CREATE") {
      send({ kind: "CREATE_GAME", displayName: initial.displayName });
    } else {
      const baseMsg: { kind: "JOIN_GAME"; gameId: string; displayName: string; sessionToken?: string } = {
        kind: "JOIN_GAME",
        gameId: initial.gameId,
        displayName: initial.displayName,
      };
      if (initial.sessionToken) baseMsg.sessionToken = initial.sessionToken;
      send(baseMsg);
    }
  }, [initial]);

  useEffect(() => {
    if (!cue) return;
    const t = setTimeout(() => setCue(null), CUE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [cue]);

  const dispatch = <T extends ProposedEventType>(type: T, payload: EventPayloadMap[T]): void => {
    const id = identityRef.current;
    if (!id) return;
    setLastError(null);
    send({ kind: "GAME_EVENT", gameId: id.gameId, type, payload });
  };

  return {
    identity,
    lobby,
    visibleState,
    validEvents,
    drawnCard,
    winnerIds,
    displayNames,
    peekResult,
    cue,
    version,
    lastError,
    dispatch,
    clearPeek: () => setPeekResult(null),
    clearError: () => setLastError(null),
  };
}
