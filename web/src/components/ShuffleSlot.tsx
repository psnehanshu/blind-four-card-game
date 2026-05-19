import { useEffect, type ReactNode } from "react";
import { motion, useAnimationControls } from "motion/react";

interface Props {
  slotIndex: number;
  /** When set, plays a per-slot shuffle dance. Nonce drives re-trigger. */
  shuffleNonce?: number;
  children: ReactNode;
}

// Four staggered lift-and-arc keyframes; alternating slots curl in opposite
// directions so adjacent cards appear to cross over each other mid-shuffle.
const VARIANTS = [
  { x: [0, 50, -20, 30, 0], y: [0, -55, -30, -15, 0], rotate: [0, 18, -6, 4, 0] },
  { x: [0, -50, 20, -30, 0], y: [0, -45, -55, -10, 0], rotate: [0, -18, 8, -4, 0] },
  { x: [0, 40, -30, 20, 0], y: [0, -50, -25, -20, 0], rotate: [0, 14, -10, 3, 0] },
  { x: [0, -40, 30, -20, 0], y: [0, -40, -60, -5, 0], rotate: [0, -14, 12, -3, 0] },
];

/**
 * Wraps an unlocked hand slot so the J/shuffle power can animate the card
 * lifting and crisscrossing — a stylized shuffle distinct from the container
 * shake. Locked slots skip this wrapper since their cards stay put.
 */
export function ShuffleSlot({ slotIndex, shuffleNonce, children }: Props) {
  const controls = useAnimationControls();

  useEffect(() => {
    if (shuffleNonce === undefined) return;
    const v = VARIANTS[slotIndex % VARIANTS.length];
    if (!v) return;
    controls.start({ ...v, transition: { duration: 0.7, ease: "easeInOut" } });
  }, [shuffleNonce, slotIndex, controls]);

  return (
    <motion.div className="shuffle-slot" animate={controls}>
      {children}
    </motion.div>
  );
}
