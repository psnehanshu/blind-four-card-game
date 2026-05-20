import { GameEngine } from "../engine/game-engine.js";
import type {
  Card,
  CommittedEvent,
  EngineResult,
  EventPayloadMap,
  PeekResult,
  ProposedEventType,
  VisibleGameState,
} from "../engine/types.js";
import { Store } from "./store.js";

export interface StateSnapshot {
  visibleState: VisibleGameState;
  validEvents: ProposedEventType[];
  drawnCard: Card | null;
  lastEvents: CommittedEvent[];
  winnerIds?: string[];
  peekResult?: PeekResult;
}

export class GameManager {
  private store: Store;
  private cache = new Map<string, GameEngine>();

  constructor(store: Store) {
    this.store = store;
  }

  /** Returns the engine for a running/finished game, hydrating from disk on miss. */
  getEngine(gameId: string): GameEngine | null {
    const cached = this.cache.get(gameId);
    if (cached) return cached;

    const row = this.store.loadGameRow(gameId);
    if (!row) return null;
    if (row.status === "lobby") return null;
    if (row.seed === null) throw new Error(`Game ${gameId} has no seed but status=${row.status}`);

    const events = this.store.loadEvents(gameId);
    const engine = GameEngine.fromEventLog(events, {
      gameId: row.id,
      playerIds: row.playerIds,
      seed: row.seed,
    });
    this.cache.set(gameId, engine);
    return engine;
  }

  /** Instantiate a fresh engine when starting a game out of the lobby. */
  startEngine(gameId: string, playerIds: string[], seed: number): GameEngine {
    const engine = new GameEngine({ gameId, playerIds, seed });
    this.cache.set(gameId, engine);
    return engine;
  }

  /** Process an event: validate via engine, persist on success, return EngineResult. */
  process<T extends ProposedEventType>(
    gameId: string,
    playerId: string,
    type: T,
    payload: EventPayloadMap[T],
  ): EngineResult {
    const engine = this.getEngine(gameId);
    if (!engine) {
      return {
        nextState: { id: gameId, players: [], deck: [], discardPile: [], currentTurn: 0, state: "waiting" },
        events: [],
        validEvents: [],
        error: "Game not running",
      };
    }
    const result = engine.processEvent(playerId, type, payload);
    if (result.error) return result;
    const finished = engine.getState().state === "finished";
    this.store.appendEvents(gameId, result.events, finished);
    return result;
  }

  /** Build a per-player snapshot for STATE pushes. */
  snapshotFor(
    gameId: string,
    playerId: string,
    lastEvents: CommittedEvent[],
    peekResult?: PeekResult,
  ): StateSnapshot | null {
    const engine = this.getEngine(gameId);
    if (!engine) return null;
    const visibleState = engine.getVisibleState(playerId);
    const validEvents = engine.getValidEvents(playerId);
    const drawnCard = engine.getDrawnCard(playerId);
    const snap: StateSnapshot = { visibleState, validEvents, drawnCard, lastEvents };
    if (visibleState.state === "finished") {
      snap.winnerIds = engine.winners.map((p) => p.id);
    }
    if (peekResult) snap.peekResult = peekResult;
    return snap;
  }
}
