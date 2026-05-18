import type { Card } from "../../../engine/types.js";
import { CardView } from "./CardView.js";
import { seededRange } from "../util/rand.js";

const MAX_DECK_DEPTH = 6;
const DEPTH_OFFSET = 2; // px per layer
const MAX_DISCARD_VISIBLE = 5;

function deckDepth(size: number): number {
  if (size <= 0) return 0;
  return Math.min(MAX_DECK_DEPTH, 1 + Math.floor(size / 10));
}

/**
 * Deck stack rendered with visible thickness — N shadow layers behind the top
 * card back, offset down-right. Layer count scales with `size` so the pile
 * visibly thins as the deck is drawn.
 */
export function DeckStack({ size }: { size: number }) {
  const depth = deckDepth(size);
  return (
    <div className="pile-stack">
      {Array.from({ length: depth }).map((_, i) => {
        const offset = (i + 1) * DEPTH_OFFSET;
        return <div key={i} className="pile-shadow" style={{ top: `${offset}px`, left: `${offset}px`, zIndex: i }} />;
      })}
      {size > 0 ? (
        <div className="pile-top" style={{ zIndex: depth + 1 }}>
          <CardView hidden size="md" />
        </div>
      ) : (
        <div className="pile-empty">empty</div>
      )}
    </div>
  );
}

/**
 * Discard pile rendered as a disorganized stack — the last few cards are
 * shown at stable per-card random rotations and offsets. The topmost card
 * is nearly upright so its face is clear.
 */
export function DiscardStack({ cards }: { cards: Card[] }) {
  if (cards.length === 0) {
    return (
      <div className="pile-stack">
        <div className="pile-empty">empty</div>
      </div>
    );
  }

  const visible = cards.slice(-MAX_DISCARD_VISIBLE);
  return (
    <div className="pile-stack">
      {visible.map((card, i) => {
        const isTop = i === visible.length - 1;
        const rot = isTop ? seededRange(card.id + "r", -4, 4) : seededRange(card.id + "r", -16, 16);
        const tx = isTop ? 0 : seededRange(card.id + "x", -7, 7);
        const ty = isTop ? 0 : seededRange(card.id + "y", -7, 7);
        return (
          <div
            key={card.id}
            className="pile-card"
            style={{
              transform: `translate(${tx}px, ${ty}px) rotate(${rot}deg)`,
              zIndex: i,
            }}
          >
            <CardView card={card} size="md" />
          </div>
        );
      })}
    </div>
  );
}
