import { motion } from "motion/react";
import type { Card } from "../../../engine/types.js";
import { CardView } from "./CardView.js";
import { tiltForSlot } from "../util/rand.js";

interface Props {
  card: Card;
  index: number;
  ownerName: string;
}

/**
 * Renders a peeked card with a face-down → face-up flip on mount. The back
 * and face are stacked back-to-back via backface-visibility; the wrapper
 * rotates on the Y axis.
 */
export function PeekCardFlip({ card, index, ownerName }: Props) {
  const tilt = tiltForSlot(ownerName, index);
  return (
    <motion.div
      className="peek-flip"
      initial={{ rotateY: 180, scale: 0.9 }}
      animate={{ rotateY: 0, scale: 1 }}
      transition={{
        rotateY: { type: "spring", stiffness: 140, damping: 18, delay: 0.15 + index * 0.08 },
        scale: { duration: 0.2, delay: 0.1 + index * 0.08 },
      }}
    >
      <div className="peek-flip-face">
        <CardView card={card} label={`#${index + 1}`} size="lg" tilt={tilt} />
      </div>
      <div className="peek-flip-back">
        <CardView hidden label={`#${index + 1}`} size="lg" tilt={tilt} />
      </div>
    </motion.div>
  );
}
