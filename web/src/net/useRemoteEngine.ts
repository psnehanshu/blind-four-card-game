import { useEffect, useReducer, useRef, useState } from "react";
import type { Card, EventData, PeekResult, ProposedEventType, Rank, VisibleGameState } from "../../../engine/types.js";
import type { ServerMsg } from "../../../server/wire.js";
import { getCardValue } from "../../../engine/cards.js";
import { isConnected, send, subscribe, subscribeConnect } from "./socket.js";
import { deriveCue, type AnimationCue } from "../game/cue.js";
import { playForCue, playSadTrombone } from "../audio/sound.js";

const CUE_TIMEOUT_MS = 900;
/** Low-value cards worth keeping; trading any of these for a bigger card is a regret moment. */
const SAD_DISCARD_RANKS = new Set<Rank>(["A", "2", "3", "7"]);

function isObj(p: unknown): p is Record<string, unknown> {
  return !!p && typeof p === "object";
}

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
  /** Set of playerIds currently bound to a live socket. Server-reported. */
  onlinePlayerIds: Set<string>;
  peekResult: PeekResult | null;
  cue: AnimationCue;
  version: number;
  lastError: string | null;
  dispatch: (event: EventData) => void;
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
  const [onlinePlayerIds, setOnlinePlayerIds] = useState<Set<string>>(() => new Set());
  const [peekResult, setPeekResult] = useState<PeekResult | null>(null);
  const [cue, setCue] = useState<AnimationCue>(null);
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const [lastError, setLastError] = useState<string | null>(null);

  const nonceRef = useRef(0);
  const initialFiredRef = useRef(false);
  const identityRef = useRef<RemoteIdentity | null>(null);
  identityRef.current = identity;
  // For the "sad trombone" cue: we need to know what card the active player
  // just drew when REPLACE_CARD lands. The actor sees it via msg.drawnCard;
  // observers can infer it only when the draw came from the (face-up) discard
  // pile, by remembering the pile's top before the draw event.
  const knownDrawnCardRef = useRef<Card | null>(null);
  const prevDiscardTopRef = useRef<Card | null>(null);

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
        setOnlinePlayerIds(new Set(msg.onlinePlayerIds));
        return;
      }
      if (msg.kind === "STATE") {
        const prevDiscardTop = prevDiscardTopRef.current;
        const newDiscardTop = msg.visibleState.discardPile.at(-1) ?? null;

        setVisibleState(msg.visibleState);
        setValidEvents(msg.validEvents);
        setDrawnCard(msg.drawnCard);
        setDisplayNames(msg.displayNames);
        setOnlinePlayerIds(new Set(msg.onlinePlayerIds));
        setWinnerIds(msg.winnerIds ?? []);
        bump();
        if (msg.peekResult) setPeekResult(msg.peekResult);
        // Animation cues + sound: replay each newly-committed event through deriveCue.
        for (const e of msg.lastEvents) {
          // Track drawn card across events so we can compare it to the
          // discarded hand card when a REPLACE_CARD lands.
          if (e.type === "DRAW_CARD") {
            const source = isObj(e.payload) ? e.payload.source : undefined;
            if (source === "discard") {
              knownDrawnCardRef.current = prevDiscardTop;
            } else if (source === "deck") {
              // msg.drawnCard is non-null only for the player who drew.
              knownDrawnCardRef.current = msg.drawnCard;
            }
          } else if (e.type === "REPLACE_CARD") {
            const discarded = newDiscardTop;
            const drawn = knownDrawnCardRef.current;
            if (
              discarded &&
              drawn &&
              SAD_DISCARD_RANKS.has(discarded.rank) &&
              getCardValue(drawn.rank) > getCardValue(discarded.rank)
            ) {
              playSadTrombone();
            }
            knownDrawnCardRef.current = null;
          } else if (e.type === "DISCARD_DRAWN") {
            knownDrawnCardRef.current = null;
          }
          nonceRef.current += 1;
          const next = deriveCue(e.type, e.payload, nonceRef.current, e.playerId);
          if (next) {
            setCue(next);
            playForCue(next);
          }
        }
        // Reconnect / cold-resume: if the server says we hold a drawn card
        // but we never saw the DRAW event, seed the ref from it.
        if (msg.drawnCard && !knownDrawnCardRef.current) {
          knownDrawnCardRef.current = msg.drawnCard;
        }
        prevDiscardTopRef.current = newDiscardTop;
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

  // Reconnect resync: after socket.io re-establishes the connection (network
  // blip, server reboot, OS-suspended tab), the server-side Socket is fresh —
  // no socket.data, not in our room. Re-send JOIN_GAME with the cached
  // sessionToken so the server rebinds us and pushes a fresh STATE.
  useEffect(() => {
    const onConnect = (): void => {
      const id = identityRef.current;
      if (!id) return;
      send({
        kind: "JOIN_GAME",
        gameId: id.gameId,
        // displayName is required by the wire schema but ignored on token
        // resume — the server keeps whatever was stored at original join.
        displayName: "",
        sessionToken: id.sessionToken,
      });
    };
    return subscribeConnect(onConnect);
  }, []);

  // Staleness catcher: when the tab returns to the foreground or the network
  // flips back online, request a fresh snapshot if our socket is still up.
  // (If it's down, the reconnect path above will handle it.)
  useEffect(() => {
    const refresh = (): void => {
      const id = identityRef.current;
      if (!id) return;
      if (!isConnected()) return;
      send({ kind: "REQUEST_STATE", gameId: id.gameId });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    if (!cue) return;
    const t = setTimeout(() => setCue(null), CUE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [cue]);

  const dispatch = (event: EventData): void => {
    const id = identityRef.current;
    if (!id) return;
    setLastError(null);
    send({ kind: "GAME_EVENT", gameId: id.gameId, ...event });
  };

  return {
    identity,
    lobby,
    visibleState,
    validEvents,
    drawnCard,
    winnerIds,
    displayNames,
    onlinePlayerIds,
    peekResult,
    cue,
    version,
    lastError,
    dispatch,
    clearPeek: () => setPeekResult(null),
    clearError: () => setLastError(null),
  };
}
