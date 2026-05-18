import type { EventPayloadMap, PowerAction, ProposedEventType } from "../../../engine/types.js";

/**
 * A short-lived hint, set on every successful dispatch, that drives transient
 * UI animations (shake, pulse, flight). Not every event produces a cue.
 *
 * `nonce` ensures consecutive identical cues (e.g. two shuffles targeting the
 * same player) still trigger fresh animations — components key off it.
 */
export type AnimationCue =
  | { kind: "shuffle"; nonce: number; targetPlayerId: string }
  | { kind: "swap"; nonce: number; a: { playerId: string; cardIndex: number }; b: { playerId: string; cardIndex: number } }
  | { kind: "lock"; nonce: number; targetPlayerId: string; cardIndex: number }
  | { kind: "draw"; nonce: number; source: "deck" | "discard" }
  | { kind: "discard"; nonce: number }
  | { kind: "replace"; nonce: number; handIndex: number }
  | null;

function isDrawPayload<T extends ProposedEventType>(
  type: T,
  _payload: EventPayloadMap[T],
): _payload is EventPayloadMap["DRAW_CARD"] {
  return type === "DRAW_CARD";
}

function isReplacePayload<T extends ProposedEventType>(
  type: T,
  _payload: EventPayloadMap[T],
): _payload is EventPayloadMap["REPLACE_CARD"] {
  return type === "REPLACE_CARD";
}

function isPowerPayload<T extends ProposedEventType>(type: T, _payload: EventPayloadMap[T]): _payload is PowerAction {
  return type === "USE_POWER";
}

/**
 * Inspects an event and returns the matching animation cue, or null. Pure —
 * does not access the engine.
 */
export function deriveCue<T extends ProposedEventType>(type: T, payload: EventPayloadMap[T], nonce: number): AnimationCue {
  if (isDrawPayload(type, payload)) return { kind: "draw", nonce, source: payload.source };
  if (isReplacePayload(type, payload)) return { kind: "replace", nonce, handIndex: payload.handIndex };
  if (type === "DISCARD_DRAWN") return { kind: "discard", nonce };
  if (isPowerPayload(type, payload)) {
    const effective = payload.power === "joker" ? payload.action : payload;
    if (effective.power === "shuffle") return { kind: "shuffle", nonce, targetPlayerId: effective.targetPlayerId };
    if (effective.power === "swap") {
      return {
        kind: "swap",
        nonce,
        a: { playerId: effective.sourcePlayerId, cardIndex: effective.sourceCardIndex },
        b: { playerId: effective.targetPlayerId, cardIndex: effective.targetCardIndex },
      };
    }
    if (effective.power === "lock") {
      return { kind: "lock", nonce, targetPlayerId: effective.targetPlayerId, cardIndex: effective.cardIndex };
    }
  }
  return null;
}
