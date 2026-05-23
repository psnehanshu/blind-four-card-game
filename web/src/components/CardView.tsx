import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { HTMLMotionProps } from "motion/react";
import type { Card, Suit } from "../../../engine/types.js";
import { cardImageSrc } from "../util/cardAssets.js";

/**
 * Lock-marker card ids whose drop-in flourish has already played this
 * session. TurnView and SpectatorView mount distinct CardView trees, so
 * without this the King/Joker entry animation would re-run every time the
 * UI swaps views. The `setTimeout(0)` defers the add past React's strict-
 * mode double-mount in dev so the first true placement still animates.
 */
const seenLockMarkers = new Set<string>();

function cardAltText(card: Card): string {
  if (card.rank === "JOKER") return "Joker";
  const suit: Suit | undefined = card.suit;
  return `${card.rank}${suit ? ` of ${suit}` : ""}`;
}

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
  const markerId = lockMarker?.id;
  const skipMarkerEntry = markerId !== undefined && seenLockMarkers.has(markerId);

  useEffect(() => {
    if (markerId === undefined) return;
    const handle = setTimeout(() => seenLockMarkers.add(markerId), 0);
    return () => clearTimeout(handle);
  }, [markerId]);

  return (
    <motion.div className="card-slot" {...motionProps}>
      <div className="card-stack">
        <CardFace card={card} hidden={hidden} size={size} tilt={tilt} locked={!!lockMarker} />
        <AnimatePresence>
          {isOverlay && (
            <motion.div
              key={`marker-${lockMarker.id}`}
              className="lock-marker"
              initial={skipMarkerEntry ? false : { x: 0, y: -40, rotate: -45, scale: 0.6, opacity: 0 }}
              animate={{ x: -10, y: -3, rotate: -4, scale: 1, opacity: 1 }}
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
      {label && <span className="card-label">{label}</span>}
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
  if (hidden || !card) classes.push("card-hidden");
  else classes.push("card-face");
  if (locked) classes.push("card-locked");
  const cardStyle = tilt !== undefined && tilt !== 0 ? { transform: `rotate(${tilt}deg)` } : undefined;

  if (hidden || !card) {
    return (
      <div className={classes.join(" ")} style={cardStyle}>
        <span className="card-back">?</span>
      </div>
    );
  }

  return (
    <div className={classes.join(" ")} style={cardStyle}>
      <img className="card-img" src={cardImageSrc(card)} alt={cardAltText(card)} draggable={false} />
    </div>
  );
}
