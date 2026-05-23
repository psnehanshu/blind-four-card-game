/**
 * "Kishore" — the dumb bot. Lives on the server (not in the engine) and is
 * driven by socket.ts after every state change. Plays by a handful of
 * hardcoded rules and makes mistakes a fixed percentage of the time:
 *
 *  - DRAW: always from the deck.
 *  - DECISION: if the drawn card is strictly lower than the highest unlocked
 *    card in hand, replace that highest slot; otherwise discard. The 30%
 *    mistake rate kicks in here — when replacing, the bot picks a random
 *    unlocked slot instead of the highest.
 *  - POWER: uses the discard-top's power on random valid targets. Joker
 *    mimics a random rank.
 *  - SHOWDOWN: when eligible and the bot's hand value is < 10, call it.
 *    Otherwise end turn.
 *
 * The bot reads its own hand from `engine.getState()` — server-side cheating
 * to keep the strategy simple. The 30% mistake rate is what stops it from
 * being a free win.
 */

import type { GameEngine } from "../engine/game-engine.js";
import { HAND_SIZE } from "../engine/types.js";
import type { BasePowerAction, EventData, PowerAction } from "../engine/types.js";

export interface BotOptions {
  /** RNG in [0, 1). Defaults to Math.random. Injected for deterministic tests. */
  rng?: () => number;
  /** Probability the bot mis-targets a REPLACE_CARD. Default 0.3. */
  mistakeRate?: number;
  /** Hand-value threshold strictly below which the bot calls showdown. Default 10. */
  showdownThreshold?: number;
}

type MimicRank = "10" | "J" | "Q" | "K";

/**
 * Returns the next bot in the game that has something to do, or null if no
 * bot can act right now. During initial_reveal any unacked bot is eligible;
 * during play, only the current-turn bot.
 */
export function nextBotPlayerId(engine: GameEngine, botIds: Set<string>): string | null {
  const game = engine.getState();
  if (game.state === "finished") return null;

  if (game.state === "initial_reveal") {
    for (const p of game.players) {
      if (!botIds.has(p.id)) continue;
      if (engine.getValidEvents(p.id).includes("ACKNOWLEDGE_REVEAL")) return p.id;
    }
    return null;
  }

  const current = game.players[game.currentTurn];
  if (current && botIds.has(current.id)) return current.id;
  return null;
}

/** Pick the bot's next action. Returns null if no valid event applies. */
export function pickBotAction(engine: GameEngine, botId: string, options: BotOptions = {}): EventData | null {
  const rng = options.rng ?? Math.random;
  const mistakeRate = options.mistakeRate ?? 0.3;
  const showdownThreshold = options.showdownThreshold ?? 10;

  const validEvents = engine.getValidEvents(botId);
  if (validEvents.length === 0) return null;

  if (validEvents.includes("ACKNOWLEDGE_REVEAL")) {
    return { type: "ACKNOWLEDGE_REVEAL", payload: undefined };
  }
  if (validEvents.includes("DRAW_CARD")) {
    return { type: "DRAW_CARD", payload: { source: "deck" } };
  }

  const canReplace = validEvents.includes("REPLACE_CARD");
  const canDiscard = validEvents.includes("DISCARD_DRAWN");
  if (canReplace || canDiscard) {
    return pickDecisionAction(engine, botId, rng, mistakeRate, canReplace, canDiscard);
  }

  if (validEvents.includes("USE_POWER")) {
    return { type: "USE_POWER", payload: pickPower(engine, botId, rng) };
  }

  if (validEvents.includes("CALL_SHOWDOWN") && shouldCallShowdown(engine, botId, showdownThreshold)) {
    return { type: "CALL_SHOWDOWN", payload: undefined };
  }
  if (validEvents.includes("END_TURN")) {
    return { type: "END_TURN", payload: undefined };
  }
  return null;
}

function pickDecisionAction(
  engine: GameEngine,
  botId: string,
  rng: () => number,
  mistakeRate: number,
  canReplace: boolean,
  canDiscard: boolean,
): EventData {
  const drawn = engine.getDrawnCard(botId);
  if (!drawn) throw new Error("Bot in decision phase but no drawn card");

  const game = engine.getState();
  const player = game.players.find((p) => p.id === botId);
  if (!player) throw new Error("Bot not found in game");

  const unlocked = player.hand.map((pc, i) => ({ pc, i })).filter((x) => !x.pc.locked);

  if (unlocked.length === 0) {
    if (canDiscard) return { type: "DISCARD_DRAWN", payload: undefined };
    throw new Error("Bot has no valid decision — all cards locked");
  }

  const highest = unlocked.reduce((a, b) => (b.pc.card.value > a.pc.card.value ? b : a));
  const wantsReplace = drawn.value < highest.pc.card.value;

  if (!wantsReplace && canDiscard) {
    return { type: "DISCARD_DRAWN", payload: undefined };
  }

  // Either the bot wants to replace, or it was forced (drew from discard so
  // can't discard back). Pick the optimal slot, or a random one on a mistake.
  const targetIdx = pickReplaceIndex(unlocked, highest.i, rng, mistakeRate);
  return { type: "REPLACE_CARD", payload: { handIndex: targetIdx } };
}

function pickReplaceIndex(unlocked: { i: number }[], optimalIdx: number, rng: () => number, mistakeRate: number): number {
  if (unlocked.length > 1 && rng() < mistakeRate) {
    const wrong = unlocked.filter((x) => x.i !== optimalIdx);
    return randomElement(wrong, rng).i;
  }
  return optimalIdx;
}

function shouldCallShowdown(engine: GameEngine, botId: string, threshold: number): boolean {
  const game = engine.getState();
  const player = game.players.find((p) => p.id === botId);
  if (!player) return false;
  const handValue = player.hand.reduce((sum, pc) => sum + pc.card.value, 0);
  return handValue < threshold;
}

function pickPower(engine: GameEngine, botId: string, rng: () => number): PowerAction {
  const game = engine.getState();
  const top = game.discardPile[game.discardPile.length - 1];
  if (!top) throw new Error("Power phase but no discard top");

  if (top.rank === "JOKER") {
    const mimics: MimicRank[] = ["10", "J", "Q", "K"];
    const mimic = randomElement(mimics, rng);
    return buildJokerAction(engine, botId, mimic, rng);
  }
  if (top.rank === "10" || top.rank === "J" || top.rank === "Q" || top.rank === "K") {
    return buildBaseAction(engine, botId, top.rank, rng);
  }
  throw new Error(`Unexpected discard-top rank for power: ${top.rank}`);
}

function buildJokerAction(engine: GameEngine, botId: string, mimic: MimicRank, rng: () => number): PowerAction {
  if (mimic === "10") return { power: "joker", mimicRank: "10", action: buildPeek(engine, botId, rng) };
  if (mimic === "J") return { power: "joker", mimicRank: "J", action: buildShuffle(engine, botId, rng) };
  if (mimic === "Q") return { power: "joker", mimicRank: "Q", action: buildSwap(engine, botId, rng) };
  return { power: "joker", mimicRank: "K", action: buildLock(engine, rng) };
}

function buildBaseAction(engine: GameEngine, botId: string, rank: MimicRank, rng: () => number): BasePowerAction {
  if (rank === "10") return buildPeek(engine, botId, rng);
  if (rank === "J") return buildShuffle(engine, botId, rng);
  if (rank === "Q") return buildSwap(engine, botId, rng);
  return buildLock(engine, rng);
}

function buildPeek(engine: GameEngine, botId: string, rng: () => number): BasePowerAction & { power: "peek" } {
  const game = engine.getState();
  const opponents = game.players.filter((p) => p.id !== botId);
  if (opponents.length === 0 || rng() < 0.5) {
    return { power: "peek", target: "own" };
  }
  const opp = randomElement(opponents, rng);
  const idx = Math.floor(rng() * HAND_SIZE);
  return { power: "peek", target: "opponent", opponentId: opp.id, opponentCardIndex: idx };
}

function buildShuffle(engine: GameEngine, botId: string, rng: () => number): BasePowerAction & { power: "shuffle" } {
  const game = engine.getState();
  const opponents = game.players.filter((p) => p.id !== botId);
  if (opponents.length === 0) throw new Error("Shuffle requires an opponent");
  return { power: "shuffle", targetPlayerId: randomElement(opponents, rng).id };
}

function buildSwap(engine: GameEngine, botId: string, rng: () => number): BasePowerAction & { power: "swap" } {
  const game = engine.getState();
  const players = game.players;
  const botPlayer = players.find((p) => p.id === botId);
  if (!botPlayer) throw new Error("Bot not found");

  const unlockedOf = (handHolder: { hand: typeof botPlayer.hand }): { i: number }[] =>
    handHolder.hand.map((pc, i) => ({ pc, i })).filter((x) => !x.pc.locked);

  // Preferred: swap one of the bot's cards with an opponent's. Cycle through
  // opponents in random order until one with an unlocked slot is found.
  const botSlots = unlockedOf(botPlayer);
  const opponents = shuffleArr(
    players.filter((p) => p.id !== botId),
    rng,
  );
  if (botSlots.length > 0) {
    for (const opp of opponents) {
      const oppSlots = unlockedOf(opp);
      if (oppSlots.length === 0) continue;
      return {
        power: "swap",
        sourcePlayerId: botId,
        sourceCardIndex: randomElement(botSlots, rng).i,
        targetPlayerId: opp.id,
        targetCardIndex: randomElement(oppSlots, rng).i,
      };
    }
  }

  // Fallback: bot's cards are all locked. Swap any two different players.
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      if (!a || !b) continue;
      const aSlots = unlockedOf(a);
      const bSlots = unlockedOf(b);
      if (aSlots.length === 0 || bSlots.length === 0) continue;
      return {
        power: "swap",
        sourcePlayerId: a.id,
        sourceCardIndex: randomElement(aSlots, rng).i,
        targetPlayerId: b.id,
        targetCardIndex: randomElement(bSlots, rng).i,
      };
    }
  }
  throw new Error("No valid swap targets");
}

function buildLock(engine: GameEngine, rng: () => number): BasePowerAction & { power: "lock" } {
  const game = engine.getState();
  const candidates: { playerId: string; cardIndex: number }[] = [];
  for (const p of game.players) {
    for (let i = 0; i < p.hand.length; i++) {
      const pc = p.hand[i];
      if (pc && !pc.locked) candidates.push({ playerId: p.id, cardIndex: i });
    }
  }
  if (candidates.length === 0) throw new Error("No lock targets");
  const pick = randomElement(candidates, rng);
  return { power: "lock", targetPlayerId: pick.playerId, cardIndex: pick.cardIndex };
}

function randomElement<T>(arr: T[], rng: () => number): T {
  const idx = Math.floor(rng() * arr.length);
  const item = arr[idx];
  if (item === undefined) throw new Error("Random pick from empty array");
  return item;
}

function shuffleArr<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) throw new Error("Shuffle index out of bounds");
    out[i] = b;
    out[j] = a;
  }
  return out;
}
