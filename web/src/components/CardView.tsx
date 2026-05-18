import { AnimatePresence, motion } from "motion/react";
import type { HTMLMotionProps } from "motion/react";
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
  /** When set, the actual King/Joker that locked this slot. */
  lockMarker?: Card;
  /**
   * How to render the lock marker:
   *   - "overlay" (default): full marker card sits face-up on top of the slot,
   *     with a one-time drop-in animation. Hides whatever is underneath.
   *   - "label": small chip showing the marker's rank, leaving the slot card
   *     fully visible. Used in the final reveal where players need to see
   *     what was locked.
   */
  markerStyle?: "overlay" | "label";
  /** Extra label rendered above the card (e.g. slot index). */
  label?: string;
  /** Visual size. */
  size?: "sm" | "md" | "lg";
  /** Rotation in degrees applied to the card face (not the label). */
  tilt?: number;
  /** Optional motion props forwarded to the outer slot wrapper — used for
   *  entrance/exit/layout animations. */
  motionProps?: HTMLMotionProps<"div">;
}

export function CardView({
  card,
  hidden,
  lockMarker,
  markerStyle = "overlay",
  label,
  size = "md",
  tilt,
  motionProps,
}: Props) {
  const isOverlay = markerStyle === "overlay" && !!lockMarker;
  return (
    <motion.div className="card-slot" {...motionProps}>
      {label && <span className="card-label">{label}</span>}
      <div className="card-stack">
        <CardFace card={card} hidden={hidden} size={size} tilt={tilt} locked={!!lockMarker} />
        <AnimatePresence>
          {isOverlay && (
            <motion.div
              key={`marker-${lockMarker.id}`}
              className="lock-marker"
              initial={{ y: -40, rotate: -45, scale: 0.6, opacity: 0 }}
              animate={{ y: 0, rotate: -8, scale: 1, opacity: 1 }}
              exit={{ y: -40, opacity: 0 }}
              transition={{ type: "spring", stiffness: 280, damping: 16 }}
            >
              <CardFace card={lockMarker} size={size} />
            </motion.div>
          )}
        </AnimatePresence>
        {markerStyle === "label" && lockMarker && (
          <span className="lock-label-badge" title={`Locked by ${lockMarker.rank}`}>
            LOCK {lockMarker.rank}
          </span>
        )}
      </div>
    </motion.div>
  );
}

interface FaceProps {
  card?: Card;
  hidden?: boolean;
  size: "sm" | "md" | "lg";
  tilt?: number;
  locked?: boolean;
}

function CardFace({ card, hidden, size, tilt, locked }: FaceProps) {
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
    <div className={classes.join(" ")} style={cardStyle}>
      {body}
    </div>
  );
}
