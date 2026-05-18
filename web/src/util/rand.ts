/** Deterministic 32-bit djb2 hash of a string. Stable across renders. */
export function hashId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Returns an integer in [min, max] inclusive, derived from a string seed. */
export function seededRange(seed: string, min: number, max: number): number {
  const span = max - min + 1;
  return min + (hashId(seed) % span);
}

/**
 * Stable per-slot tilt (degrees) for a card in a player's hand. Each player's
 * hand looks slightly different but doesn't reshuffle on re-render.
 */
export function tiltForSlot(playerId: string, slotIndex: number): number {
  return seededRange(`${playerId}-slot-${slotIndex}`, -3, 3);
}
