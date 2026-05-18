import { useReducer } from "react";
import type { GameEngine } from "../../../engine/game-engine.js";
import type { EngineResult, EventPayloadMap, ProposedEventType } from "../../../engine/types.js";

export type Dispatch = <T extends ProposedEventType>(
  playerId: string,
  type: T,
  payload: EventPayloadMap[T],
) => EngineResult;

export interface UseEngine {
  dispatch: Dispatch;
  /** Increments on every dispatch — use as a render trigger / dependency. */
  version: number;
}

/**
 * Drives re-renders when the engine mutates. The engine itself is held by the
 * parent — this hook just bumps a counter after each event so consumers
 * re-read getState/getVisibleState.
 */
export function useEngine(engine: GameEngine): UseEngine {
  const [version, bump] = useReducer((n: number) => n + 1, 0);

  const dispatch: Dispatch = (playerId, type, payload) => {
    const result = engine.processEvent(playerId, type, payload);
    bump();
    return result;
  };

  return { dispatch, version };
}
