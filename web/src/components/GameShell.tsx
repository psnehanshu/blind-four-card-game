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
    return <WaitingForAcknowledge remote={remote} />;
  }

  const myTurn = visibleState.players[visibleState.currentTurn]?.id === identity.playerId;
  return (
    <>
      {myTurn ? <TurnView remote={remote} /> : <SpectatorView remote={remote} />}
      <div className={`my-turn-outline${myTurn ? " is-active" : ""}`} aria-hidden="true" />
      <ShuffleNotice remote={remote} />
    </>
  );
}

const SEAT_COLORS = ["#3d8bff", "#5cd99a", "#f5c542", "#ff8a8a", "#c084fc", "#22d3ee"];

function seatInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/**
 * Shown while we've already acknowledged but at least one other player is
 * still memorizing. Mirrors the Lobby's chip-style seat list so the wait
 * feels active rather than dead — each seat shows ready / memorizing state
 * and the memorizing avatars gently pulse.
 */
function WaitingForAcknowledge({ remote }: { remote: RemoteEngine }) {
  const { identity, visibleState, displayNames } = remote;
  if (!identity || !visibleState) return null;
  const players = visibleState.players;
  const pendingCount = players.filter((p) => !p.acknowledgedReveal).length;

  return (
    <div className="screen reveal-waiting">
      <h2>Waiting on the table…</h2>
      <p className="muted">
        {pendingCount === 1
          ? "1 player is still memorizing their hand."
          : `${pendingCount} players are still memorizing their hand.`}
      </p>

      <ul className="lobby-seats reveal-seats">
        {players.map((p, i) => {
          const color = SEAT_COLORS[i % SEAT_COLORS.length] ?? SEAT_COLORS[0];
          const isYou = p.id === identity.playerId;
          const name = displayNames[p.id] ?? p.name ?? p.id;
          const ready = p.acknowledgedReveal;
          return (
            <motion.li
              key={p.id}
              layout
              initial={{ opacity: 0, y: 10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
              className={`lobby-seat filled reveal-seat${ready ? " is-ready" : " is-waiting"}`}
            >
              <span className="seat-avatar" style={{ background: color }}>
                {seatInitials(name)}
              </span>
              <span className="seat-name">
                {name}
                {isYou && <span className="badge seat-you-badge">YOU</span>}
              </span>
              <span className={`reveal-status ${ready ? "ok" : "pending"}`}>{ready ? "Ready" : "Memorizing…"}</span>
            </motion.li>
          );
        })}
      </ul>
    </div>
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
