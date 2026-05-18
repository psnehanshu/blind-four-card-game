import { useState } from "react";
import type { GameEngine } from "../../../engine/game-engine.js";
import { useEngine } from "../game/useEngine.js";
import { nextActivePlayerId } from "../game/activePlayer.js";
import { PassDeviceGate } from "./PassDeviceGate.js";
import { InitialReveal } from "./InitialReveal.js";
import { TurnView } from "./TurnView.js";
import { FinalReveal } from "./FinalReveal.js";

interface Props {
  engine: GameEngine;
  onExit: () => void;
}

export function GameShell({ engine, onExit }: Props) {
  const { dispatch, version: _version, cue } = useEngine(engine);
  // Always gated at start of a turn / reveal; cleared once the active player taps through.
  const [gateClosed, setGateClosed] = useState(true);

  const state = engine.getState();
  const activeId = nextActivePlayerId(engine);
  const activeName = state.players.find((p) => p.id === activeId)?.name ?? activeId ?? "—";

  if (state.state === "finished") {
    return <FinalReveal engine={engine} onExit={onExit} />;
  }

  if (activeId === null) {
    return (
      <div className="screen done">
        <h2>No active player</h2>
        <p className="muted">The game is in an unexpected state.</p>
        <button type="button" className="primary big" onClick={onExit}>
          Back to lobby
        </button>
      </div>
    );
  }

  if (gateClosed) {
    const context = state.state === "initial_reveal" ? "Initial reveal" : "Your turn";
    return <PassDeviceGate playerName={activeName} context={context} onReady={() => setGateClosed(false)} />;
  }

  if (state.state === "initial_reveal") {
    return <InitialReveal engine={engine} playerId={activeId} dispatch={dispatch} onDone={() => setGateClosed(true)} />;
  }

  // in_progress or showdown
  return (
    <TurnView
      engine={engine}
      playerId={activeId}
      dispatch={dispatch}
      cue={cue}
      onTurnEnd={() => setGateClosed(true)}
      onExit={onExit}
    />
  );
}
