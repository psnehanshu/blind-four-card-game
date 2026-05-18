import type { GameEngine } from "../../../engine/game-engine.js";

/**
 * Who currently needs the device?
 * - initial_reveal: the first player who has not yet ACKNOWLEDGE_REVEAL'd.
 * - in_progress / showdown: the player whose turn it is.
 * - waiting / finished: null.
 */
export function nextActivePlayerId(engine: GameEngine): string | null {
  const state = engine.getState();
  if (state.state === "initial_reveal") {
    const acked = new Set(
      engine
        .getEventLog()
        .filter((e) => e.type === "ACKNOWLEDGE_REVEAL")
        .map((e) => e.playerId),
    );
    const next = state.players.find((p) => !acked.has(p.id));
    return next?.id ?? null;
  }
  if (state.state === "in_progress" || state.state === "showdown") {
    return state.players[state.currentTurn]?.id ?? null;
  }
  return null;
}
