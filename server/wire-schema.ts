import { z } from "zod";

const ProposedEventTypeSchema = z.enum([
  "ACKNOWLEDGE_REVEAL",
  "DRAW_CARD",
  "REPLACE_CARD",
  "DISCARD_DRAWN",
  "CALL_SHOWDOWN",
  "USE_POWER",
  "END_TURN",
]);

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
  z.object({
    kind: z.literal("GAME_EVENT"),
    gameId: z.string(),
    type: ProposedEventTypeSchema,
    // Engine deep-validates the payload after dispatch; we leave it opaque here.
    payload: z.unknown(),
  }),
  z.object({
    kind: z.literal("REQUEST_STATE"),
    gameId: z.string(),
  }),
]);
