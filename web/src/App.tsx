import { useState } from "react";
import { GameEngine } from "../../engine/game-engine.js";
import { Lobby } from "./components/Lobby.js";
import { GameShell } from "./components/GameShell.js";
import { Splash } from "./components/Splash.js";

type Phase = { kind: "splash" } | { kind: "lobby" } | { kind: "playing"; engine: GameEngine };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "splash" });

  if (phase.kind === "splash") {
    return <Splash onReady={() => setPhase({ kind: "lobby" })} />;
  }
  if (phase.kind === "lobby") {
    return <Lobby onStart={(engine) => setPhase({ kind: "playing", engine })} />;
  }
  return <GameShell engine={phase.engine} onExit={() => setPhase({ kind: "lobby" })} />;
}
