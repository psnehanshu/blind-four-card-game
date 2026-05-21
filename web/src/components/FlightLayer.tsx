import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { Card } from "../../../engine/types.js";
import { CardView } from "./CardView.js";

const CARD_W = 70;
const CARD_H = 100;

export interface Flight {
  id: string;
  /** When non-null, the card flies face-up showing this card. When null, it flies face-down. */
  card: Card | null;
  /** Source center (viewport coordinates). */
  from: { x: number; y: number };
  /** Destination center (viewport coordinates). */
  to: { x: number; y: number };
  /** If provided, the card flips at the end of the flight to reveal this face. Used for deck draws. */
  revealAt?: Card | null;
  /** Pixels to lift the arc apex above the higher of from/to. Defaults to 50.
   *  Swap flights vary this so two cards crossing don't trace identical arcs. */
  arcLift?: number;
  /** Starting scale (default 0.95). Draws/discards from the close-up overlay
   *  start large so they hand off visually from the held card. */
  scaleFrom?: number;
  /** Ending scale (default 1). A deck/discard draw flight ends large because
   *  the card is being brought "to the player's face". */
  scaleTo?: number;
  onComplete: () => void;
}

export function FlightLayer({ flights }: { flights: Flight[] }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="flight-layer">
      {flights.map((f) => (
        <FlyingCard key={f.id} flight={f} />
      ))}
    </div>,
    document.body,
  );
}

function FlyingCard({ flight }: { flight: Flight }) {
  const fromX = flight.from.x - CARD_W / 2;
  const fromY = flight.from.y - CARD_H / 2;
  const toX = flight.to.x - CARD_W / 2;
  const toY = flight.to.y - CARD_H / 2;

  // dx/dy of the arc midpoint; a slight arc upward feels more natural than a straight line.
  const midX = (fromX + toX) / 2;
  const midY = Math.min(fromY, toY) - (flight.arcLift ?? 50);

  const sFrom = flight.scaleFrom ?? 0.95;
  const sTo = flight.scaleTo ?? 1;
  const sMid = Math.max(sFrom, sTo) * 1.04;

  return (
    <motion.div
      className="flight-card"
      initial={{ x: fromX, y: fromY, rotate: -6, scale: sFrom }}
      animate={{
        x: [fromX, midX, toX],
        y: [fromY, midY, toY],
        rotate: [-6, 4, 0],
        scale: [sFrom, sMid, sTo],
      }}
      transition={{ duration: 0.55, ease: [0.4, 0.0, 0.2, 1], times: [0, 0.5, 1] }}
      onAnimationComplete={flight.onComplete}
    >
      <CardView card={flight.card ?? undefined} hidden={!flight.card} size="md" />
    </motion.div>
  );
}
