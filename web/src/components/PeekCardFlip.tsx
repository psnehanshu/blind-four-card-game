import { motion } from "motion/react";
import type { Card } from "../../../engine/types.js";
import { CardView } from "./CardView.js";
import { tiltForSlot } from "../util/rand.js";

type FlipSize = "sm" | "md" | "lg";

interface Props {
  card: Card;
  index: number;
  ownerName: string;
  lockMarker?: Card;
  /** Hide the per-slot label (used when surrounding slot already renders one). */
  hideLabel?: boolean;
  size?: FlipSize;
}

const SIZE_BOX: Record<FlipSize, { width: number; height: number }> = {
  sm: { width: 44, height: 64 },
  md: { width: 70, height: 100 },
  lg: { width: 90, height: 128 },
};

/**
 * Renders a peeked card with a face-down → face-up flip on mount. The back
 * and face are stacked back-to-back via backface-visibility; the wrapper
 * rotates on the Y axis.
 */
export function PeekCardFlip({ card, index, ownerName, lockMarker, hideLabel, size = "lg" }: Props) {
  const tilt = tiltForSlot(ownerName, index);
  const label = hideLabel ? undefined : `#${index + 1}`;
  const box = SIZE_BOX[size];
  return (
    <motion.div
      className="peek-flip"
      style={{ width: box.width, height: box.height }}
      initial={{ rotateY: 180, scale: 0.9 }}
      animate={{ rotateY: 0, scale: 1 }}
      transition={{
        rotateY: { type: "spring", stiffness: 140, damping: 18, delay: 0.15 + index * 0.08 },
        scale: { duration: 0.2, delay: 0.1 + index * 0.08 },
      }}
    >
      <div className="peek-flip-face">
        {/* Use the badge marker style so the peeked face stays visible — the
            full K/Joker overlay would otherwise hide the very card we just
            revealed. */}
        <CardView
          card={card}
          label={label}
          size={size}
          tilt={tilt}
          lockMarker={lockMarker}
          markerStyle={lockMarker ? "label" : "overlay"}
        />
      </div>
      <div className="peek-flip-back">
        <CardView hidden label={label} size={size} tilt={tilt} lockMarker={lockMarker} />
      </div>
    </motion.div>
  );
}
