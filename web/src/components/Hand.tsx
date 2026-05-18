import { useEffect, type ReactNode } from "react";
import { motion, useAnimationControls } from "motion/react";

interface Props {
  className?: string;
  /** When set, plays a shake-keyframe animation once. The nonce drives re-triggering. */
  shakeNonce?: number;
  children: ReactNode;
}

/**
 * Hand container — wraps cards in a motion.div but uses imperative animation
 * controls so the wrapper element stays mounted across renders. This keeps
 * mount-once animations on children (e.g. the lock marker drop-in) from
 * re-firing every time a transient cue changes upstream.
 */
export function Hand({ className, shakeNonce, children }: Props) {
  const controls = useAnimationControls();

  useEffect(() => {
    if (shakeNonce === undefined) return;
    controls.start({
      x: [0, -6, 5, -3, 2, 0],
      rotate: [0, -4, 4, -2, 1, 0],
      transition: { duration: 0.55, ease: "easeOut" },
    });
  }, [shakeNonce, controls]);

  return (
    <motion.div className={className} animate={controls}>
      {children}
    </motion.div>
  );
}
