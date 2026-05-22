/**
 * Faint reference strip showing each rank's hand-value. Mounted in TurnView
 * and SpectatorView so a player can glance at the table to recall, e.g.,
 * that 7 = 0 and JOKER = 20. Kept low-contrast and pointer-events:none so
 * it doesn't compete with primary UI.
 */
const ENTRIES: readonly (readonly [string, number])[] = [
  ["A", 1],
  ["2", 2],
  ["3", 3],
  ["4", 4],
  ["5", 5],
  ["6", 6],
  ["7", 0],
  ["8", 8],
  ["9", 9],
  ["10", 10],
  ["J", 11],
  ["Q", 12],
  ["K", 13],
  ["JK", 20],
];

export function Cheatsheet() {
  return (
    <div className="cheatsheet" aria-label="Card values">
      {ENTRIES.map(([rank, val]) => {
        const cls = val === 0 ? "cheatsheet-cell is-zero" : val === 20 ? "cheatsheet-cell is-max" : "cheatsheet-cell";
        return (
          <div key={rank} className={cls}>
            <span className="cheatsheet-rank">{rank}</span>
            <span className="cheatsheet-val">{val}</span>
          </div>
        );
      })}
    </div>
  );
}
