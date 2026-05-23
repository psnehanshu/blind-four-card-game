import { z } from "zod";

// ─── Power actions ─────────────────────────────────────────────────────
// Mirrors engine PowerActionMap / PowerAction structurally. Engine still
// owns semantic checks (in-range indices, valid targets, locked cards,
// matching the discarded power card's rank, etc.).

const PeekActionSchema = z.discriminatedUnion("target", [
  z.object({
    power: z.literal("peek"),
    target: z.literal("own"),
  }),
  z.object({
    power: z.literal("peek"),
    target: z.literal("opponent"),
    opponentId: z.string(),
    opponentCardIndex: z.number().int(),
  }),
]);

const ShuffleActionSchema = z.object({
  power: z.literal("shuffle"),
  targetPlayerId: z.string(),
});

const SwapActionSchema = z.object({
  power: z.literal("swap"),
  sourcePlayerId: z.string(),
  sourceCardIndex: z.number().int(),
  targetPlayerId: z.string(),
  targetCardIndex: z.number().int(),
});

const LockActionSchema = z.object({
  power: z.literal("lock"),
  targetPlayerId: z.string(),
  cardIndex: z.number().int(),
});

const JokerActionSchema = z.discriminatedUnion("mimicRank", [
  z.object({
    power: z.literal("joker"),
    mimicRank: z.literal("10"),
    action: PeekActionSchema,
  }),
  z.object({
    power: z.literal("joker"),
    mimicRank: z.literal("J"),
    action: ShuffleActionSchema,
  }),
  z.object({
    power: z.literal("joker"),
    mimicRank: z.literal("Q"),
    action: SwapActionSchema,
  }),
  z.object({
    power: z.literal("joker"),
    mimicRank: z.literal("K"),
    action: LockActionSchema,
  }),
]);

const PowerActionSchema = z.discriminatedUnion("power", [
  PeekActionSchema,
  ShuffleActionSchema,
  SwapActionSchema,
  LockActionSchema,
  JokerActionSchema,
]);

// ─── GAME_EVENT message — one branch per event type ────────────────────

const GameEventMsgSchema = z.discriminatedUnion("type", [
  z.object({
    kind: z.literal("GAME_EVENT"),
    gameId: z.string(),
    type: z.literal("ACKNOWLEDGE_REVEAL"),
  }),
  z.object({
    kind: z.literal("GAME_EVENT"),
    gameId: z.string(),
    type: z.literal("DRAW_CARD"),
    payload: z.object({ source: z.enum(["deck", "discard"]) }),
  }),
  z.object({
    kind: z.literal("GAME_EVENT"),
    gameId: z.string(),
    type: z.literal("REPLACE_CARD"),
    payload: z.object({ handIndex: z.number().int() }),
  }),
  z.object({
    kind: z.literal("GAME_EVENT"),
    gameId: z.string(),
    type: z.literal("DISCARD_DRAWN"),
  }),
  z.object({
    kind: z.literal("GAME_EVENT"),
    gameId: z.string(),
    type: z.literal("CALL_SHOWDOWN"),
  }),
  z.object({
    kind: z.literal("GAME_EVENT"),
    gameId: z.string(),
    type: z.literal("USE_POWER"),
    payload: PowerActionSchema,
  }),
  z.object({
    kind: z.literal("GAME_EVENT"),
    gameId: z.string(),
    type: z.literal("END_TURN"),
  }),
]);

// ─── Client → server union ────────────────────────────────────────────

export const ClientMsgSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("CREATE_GAME"),
    displayName: z.string(),
    seed: z.number().optional(),
  }),
  z.object({
    kind: z.literal("JOIN_GAME"),
    gameId: z.string(),
    displayName: z.string(),
    sessionToken: z.string().optional(),
  }),
  z.object({
    kind: z.literal("START_GAME"),
    gameId: z.string(),
  }),
  GameEventMsgSchema,
  z.object({
    kind: z.literal("REQUEST_STATE"),
    gameId: z.string(),
  }),
]);

export type GameEventMsg = z.infer<typeof GameEventMsgSchema>;
