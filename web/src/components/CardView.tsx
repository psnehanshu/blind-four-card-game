import type { Card, Suit } from "../../../engine/types.js";

const SUIT_GLYPH: Record<Suit, string> = {
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
  spades: "♠",
};

const RED_SUITS: Suit[] = ["hearts", "diamonds"];

interface Props {
  card?: Card;
  /** Face-down (hidden) when true. */
  hidden?: boolean;
  /** Show a small lock badge in the corner. */
  locked?: boolean;
  /** Extra label rendered above the card (e.g. slot index). */
  label?: string;
  /** Visual size. */
  size?: "sm" | "md" | "lg";
  /** Rotation in degrees applied to the card face (not the label). */
  tilt?: number;
}

export function CardView({ card, hidden, locked, label, size = "md", tilt }: Props) {
  const classes = ["card", `card-${size}`];
  if (hidden) classes.push("card-hidden");
  if (locked) classes.push("card-locked");
  const cardStyle = tilt !== undefined && tilt !== 0 ? { transform: `rotate(${tilt}deg)` } : undefined;

  let body;
  if (hidden || !card) {
    body = <span className="card-back">?</span>;
  } else if (card.rank === "JOKER") {
    body = (
      <>
        <span className="card-rank">JOKER</span>
        <span className="card-value">20</span>
      </>
    );
  } else {
    const isRed = card.suit && RED_SUITS.includes(card.suit);
    if (isRed) classes.push("card-red");
    body = (
      <>
        <span className="card-rank">{card.rank}</span>
        <span className="card-suit">{card.suit ? SUIT_GLYPH[card.suit] : ""}</span>
      </>
    );
  }

  return (
    <div className="card-slot">
      {label && <span className="card-label">{label}</span>}
      <div className={classes.join(" ")} style={cardStyle}>
        {body}
        {locked && <span className="card-lock-badge">LOCK</span>}
      </div>
    </div>
  );
}
