import { motion } from "motion/react";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { CardView } from "./CardView.js";
import { tiltForSlot } from "../util/rand.js";

interface Props {
  remote: RemoteEngine;
}

export function InitialReveal({ remote }: Props) {
  const { identity, visibleState, displayNames, dispatch } = remote;
  if (!identity || !visibleState) return null;

  const hand = visibleState.myHand ?? [];
  const name = displayNames[identity.playerId] ?? identity.playerId;

  function ack() {
    dispatch("ACKNOWLEDGE_REVEAL", undefined);
  }

  return (
    <div className="screen reveal">
      <h2>{name}, memorize your hand</h2>
      <p className="muted">These cards will be hidden after you tap done.</p>

      <motion.div
        className="hand"
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.12 } } }}
      >
        {hand.map(({ index, card }) => (
          <CardView
            key={index}
            card={card.card}
            label={`#${index + 1}`}
            size="lg"
            tilt={tiltForSlot(identity.playerId, index)}
            motionProps={{
              variants: {
                hidden: { y: -40, opacity: 0, rotateX: -60 },
                show: { y: 0, opacity: 1, rotateX: 0 },
              },
              transition: { type: "spring", stiffness: 220, damping: 18 },
            }}
          />
        ))}
      </motion.div>

      {remote.lastError && <div className="error">{remote.lastError}</div>}

      <button type="button" className="primary big" onClick={ack}>
        Done — hide my cards
      </button>
    </div>
  );
}
