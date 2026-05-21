/**
 * Resolve a player's display name, appending " (you)" when the id matches
 * the viewer. Single source of truth for the "(you)" suffix — every name
 * shown on screen should route through here so the marker is consistent.
 */
export function playerNameFor(
  id: string,
  meId: string | undefined,
  displayNames: Record<string, string>,
  fallback?: string,
): string {
  const base = displayNames[id] ?? fallback ?? id;
  return id === meId ? `${base} (you)` : base;
}
