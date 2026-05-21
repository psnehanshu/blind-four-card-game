import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { InitialReveal } from "./InitialReveal.js";
import { TurnView } from "./TurnView.js";
import { FinalReveal } from "./FinalReveal.js";
import { Dealing } from "./Dealing.js";
import { SpectatorView } from "./SpectatorView.js";
import { playerNameFor } from "../util/playerName.js";

interface Props {
  remote: RemoteEngine;
}

export function GameShell({ remote }: Props) {
  const { identity, visibleState, validEvents, displayNames } = remote;
  const [dealingDone, setDealingDone] = useState(false);

  if (!identity || !visibleState) return null;

  if (visibleState.state === "finished") {
    return <FinalReveal remote={remote} />;
  }

  if (visibleState.state === "initial_reveal" && !dealingDone) {
    const handSize = visibleState.myHand?.length ?? 4;
    return (
      <Dealing
        players={visibleState.players.map((p) => ({
          id: p.id,
          name: playerNameFor(p.id, identity.playerId, displayNames, p.name),
        }))}
        handSize={handSize}
        onComplete={() => setDealingDone(true)}
      />
    );
  }

  if (visibleState.state === "initial_reveal") {
    if (validEvents.includes("ACKNOWLEDGE_REVEAL")) {
      return <InitialReveal remote={remote} />;
    }
    const pending = visibleState.players.filter((p) => !p.acknowledgedReveal);
    return (
      <div className="screen reveal">
        <h2>Waiting for the other players to acknowledge…</h2>
        <p className="muted">Play starts as soon as everyone has memorized their hand.</p>
        {pending.length > 0 && (
          <section className="form-block">
            <h3>Still memorizing their hand</h3>
            <ul className="player-list">
              {pending.map((p) => (
                <li key={p.id}>{playerNameFor(p.id, identity.playerId, displayNames, p.name)}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  const myTurn = visibleState.players[visibleState.currentTurn]?.id === identity.playerId;
  return (
    <>
      {myTurn ? <TurnView remote={remote} /> : <SpectatorView remote={remote} />}
      <ShuffleNotice remote={remote} />
    </>
  );
}

const SHUFFLE_NOTICE_MS = 3500;

function ShuffleNotice({ remote }: { remote: RemoteEngine }) {
  const { cue, identity, visibleState, displayNames } = remote;
  const myId = identity?.playerId;
  const [message, setMessage] = useState<string | null>(null);
  // Hold the dismiss timer in a ref so unrelated re-renders (cue clears,
  // STATE pushes) don't cancel it via the effect's cleanup. Only a new
  // shuffle cue should replace it.
  const lastNonceRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!cue || cue.kind !== "shuffle") return;
    if (cue.nonce === lastNonceRef.current) return;
    if (!myId || cue.targetPlayerId !== myId) return;
    lastNonceRef.current = cue.nonce;

    if (timerRef.current) clearTimeout(timerRef.current);

    const actorName = playerNameFor(
      cue.actorId,
      myId,
      displayNames,
      visibleState?.players.find((p) => p.id === cue.actorId)?.name,
    );
    setMessage(`${actorName} shuffled your hand`);
    timerRef.current = setTimeout(() => {
      setMessage(null);
      timerRef.current = null;
    }, SHUFFLE_NOTICE_MS);
  }, [cue, myId, displayNames, visibleState]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          className="shuffle-notice"
          initial={{ x: "-50%", y: 20, opacity: 0 }}
          animate={{ x: "-50%", y: 0, opacity: 1 }}
          exit={{ x: "-50%", y: 20, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 22 }}
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
