import { useEffect, useReducer, useRef, useState } from "react";
import type { GameEngine } from "../../../engine/game-engine.js";
import type { EngineResult, EventPayloadMap, ProposedEventType } from "../../../engine/types.js";
import { deriveCue, type AnimationCue } from "./cue.js";
import { playForCue } from "../audio/sound.js";

export type Dispatch = <T extends ProposedEventType>(
  playerId: string,
  type: T,
  payload: EventPayloadMap[T],
) => EngineResult;

export interface UseEngine {
  dispatch: Dispatch;
  /** Increments on every dispatch — use as a render trigger / dependency. */
  version: number;
  /** Transient animation hint set by the most recent successful event; auto-clears. */
  cue: AnimationCue;
}

const CUE_TIMEOUT_MS = 900;

/**
 * Drives re-renders when the engine mutates. Also publishes a short-lived
 * AnimationCue so the UI can play transient effects (shake, pulse, flight)
 * tied to the action that just happened.
 */
export function useEngine(engine: GameEngine): UseEngine {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const [cue, setCue] = useState<AnimationCue>(null);
  const nonceRef = useRef(0);

  const dispatch: Dispatch = (playerId, type, payload) => {
    const result = engine.processEvent(playerId, type, payload);
    bump();
    if (!result.error) {
      nonceRef.current += 1;
      const next = deriveCue(type, payload, nonceRef.current);
      if (next) {
        setCue(next);
        playForCue(next);
      }
    }
    return result;
  };

  useEffect(() => {
    if (!cue) return;
    const t = setTimeout(() => setCue(null), CUE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [cue]);

  return { dispatch, version, cue };
}
