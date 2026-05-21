import { useState } from "react";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { InitialReveal } from "./InitialReveal.js";
import { TurnView } from "./TurnView.js";
import { FinalReveal } from "./FinalReveal.js";
import { Dealing } from "./Dealing.js";
import { SpectatorView } from "./SpectatorView.js";

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
        players={visibleState.players.map((p) => ({ id: p.id, name: displayNames[p.id] ?? p.name }))}
        handSize={handSize}
        onComplete={() => setDealingDone(true)}
      />
    );
  }

  if (visibleState.state === "initial_reveal") {
    if (validEvents.includes("ACKNOWLEDGE_REVEAL")) {
      return <InitialReveal remote={remote} />;
    }
    return (
      <div className="screen reveal">
        <h2>Waiting for the other players to acknowledge…</h2>
        <p className="muted">Play starts as soon as everyone has memorized their hand.</p>
      </div>
    );
  }

  const myTurn = visibleState.players[visibleState.currentTurn]?.id === identity.playerId;
  if (myTurn) return <TurnView remote={remote} />;
  return <SpectatorView remote={remote} />;
}
