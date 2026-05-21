import type { EventPayloadMap, ProposedEventType } from "../../../engine/types.js";

/**
 * A short-lived hint, set on every successful dispatch, that drives transient
 * UI animations (shake, pulse, flight). Not every event produces a cue.
 *
 * `nonce` ensures consecutive identical cues (e.g. two shuffles targeting the
 * same player) still trigger fresh animations — components key off it.
 */
export type AnimationCue =
  | { kind: "shuffle"; nonce: number; actorId: string; targetPlayerId: string }
  | {
      kind: "swap";
      nonce: number;
      a: { playerId: string; cardIndex: number };
      b: { playerId: string; cardIndex: number };
    }
  | { kind: "lock"; nonce: number; targetPlayerId: string; cardIndex: number }
  | { kind: "draw"; nonce: number; source: "deck" | "discard"; actorId: string }
  | { kind: "discard"; nonce: number; actorId: string }
  | { kind: "replace"; nonce: number; actorId: string; handIndex: number }
  | null;

function isObj(p: unknown): p is Record<string, unknown> {
  return !!p && typeof p === "object";
}

/**
 * Inspects an event and returns the matching animation cue, or null. Pure —
 * does not access the engine.
 *
 * Payloads are narrowed structurally rather than via type predicates because
 * TS won't co-narrow `payload: EventPayloadMap[T]` when `type` is matched
 * against a literal. The engine guarantees type/payload match at runtime;
 * these structural checks are defensive.
 */
export function deriveCue<T extends ProposedEventType>(
  type: T,
  payload: EventPayloadMap[T],
  nonce: number,
  actorId: string,
): AnimationCue {
  const raw: unknown = payload;
  if (type === "DRAW_CARD" && isObj(raw)) {
    const src = raw.source;
    if (src === "deck" || src === "discard") return { kind: "draw", nonce, source: src, actorId };
    return null;
  }
  if (type === "REPLACE_CARD" && isObj(raw)) {
    const idx = raw.handIndex;
    if (typeof idx === "number") return { kind: "replace", nonce, actorId, handIndex: idx };
    return null;
  }
  if (type === "DISCARD_DRAWN") return { kind: "discard", nonce, actorId };
  if (type === "USE_POWER" && isObj(raw)) return derivePowerCue(raw, nonce, actorId);
  return null;
}

function derivePowerCue(p: Record<string, unknown>, nonce: number, actorId: string): AnimationCue {
  // Joker mimics another rank — treat joker-as-shuffle identically to a direct shuffle.
  const core: Record<string, unknown> = p.power === "joker" && isObj(p.action) ? p.action : p;
  if (core.power === "shuffle" && typeof core.targetPlayerId === "string") {
    return { kind: "shuffle", nonce, actorId, targetPlayerId: core.targetPlayerId };
  }
  if (
    core.power === "swap" &&
    typeof core.sourcePlayerId === "string" &&
    typeof core.sourceCardIndex === "number" &&
    typeof core.targetPlayerId === "string" &&
    typeof core.targetCardIndex === "number"
  ) {
    return {
      kind: "swap",
      nonce,
      a: { playerId: core.sourcePlayerId, cardIndex: core.sourceCardIndex },
      b: { playerId: core.targetPlayerId, cardIndex: core.targetCardIndex },
    };
  }
  if (core.power === "lock" && typeof core.targetPlayerId === "string" && typeof core.cardIndex === "number") {
    return { kind: "lock", nonce, targetPlayerId: core.targetPlayerId, cardIndex: core.cardIndex };
  }
  return null;
}
