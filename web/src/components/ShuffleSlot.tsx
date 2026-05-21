import { useEffect, useRef, type ReactNode } from "react";
import { motion, useAnimationControls } from "motion/react";

interface Props {
  slotIndex: number;
  /** When set, plays a per-slot shuffle dance. Nonce drives re-trigger. */
  shuffleNonce?: number;
  children: ReactNode;
}

/**
 * Wraps an unlocked hand slot so the J/shuffle power can animate a believable
 * shuffle — cards lift out of the hand, overlap at the hand's center, fly
 * across to a partner position, and fall back into the row. Because all
 * unlocked cards spend time stacked at the center while spinning, the user
 * cannot map any card back to its original slot once the animation ends.
 *
 * Measurements are taken at trigger time so the animation works for any hand
 * width / card size (own hand vs opponent hand have very different pitches).
 */
export function ShuffleSlot({ slotIndex, shuffleNonce, children }: Props) {
  const controls = useAnimationControls();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (shuffleNonce === undefined) return;
    const el = ref.current;
    if (!el) return;
    const handEl = el.closest(".hand");
    if (!handEl) return;
    const slotRect = el.getBoundingClientRect();
    const handRect = handEl.getBoundingClientRect();
    const handCenterX = handRect.left + handRect.width / 2;
    const slotCenterX = slotRect.left + slotRect.width / 2;
    // Signed delta needed to reach the hand's center from this slot.
    const toCenter = handCenterX - slotCenterX;
    // Throw the card across to the opposite side as the "partner" position,
    // overshooting slightly so the visual feels like a real swap and not a
    // simple wobble. Distinct paths per slot stop the eye from tracking pairs.
    const toFar = -toCenter * 1.15;
    const dir = slotIndex % 2 === 0 ? 1 : -1;
    // Multi-turn rotation in alternating directions plus the cross-center
    // pile-up obscures orientation cues. Each card spends ~half the duration
    // overlapping with at least one sibling at the center.
    controls.start({
      x: [0, toCenter, toFar, toCenter * 0.4, toFar * 0.6, 0],
      y: [0, -65, -45, -70, -35, 0],
      rotate: [0, dir * 220, dir * -360, dir * 520, dir * -700, 0],
      scale: [1, 0.92, 0.88, 0.86, 0.92, 1],
      transition: {
        duration: 1.1,
        ease: [0.4, 0.0, 0.2, 1],
        times: [0, 0.22, 0.44, 0.62, 0.82, 1],
      },
    });
  }, [shuffleNonce, slotIndex, controls]);

  return (
    <motion.div ref={ref} className="shuffle-slot" animate={controls}>
      {children}
    </motion.div>
  );
}
