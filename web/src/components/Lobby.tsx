import { useState } from "react";
import { GameEngine } from "../../../engine/game-engine.js";
import { MAX_PLAYERS, MIN_PLAYERS } from "../../../engine/types.js";

interface Props {
  onStart: (engine: GameEngine) => void;
}

export function Lobby({ onStart }: Props) {
  const [names, setNames] = useState<string[]>(["Alice", "Bob"]);
  const [seed, setSeed] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function updateName(i: number, value: string) {
    setNames((prev) => prev.map((n, idx) => (idx === i ? value : n)));
  }

  function addPlayer() {
    setNames((prev) => (prev.length >= MAX_PLAYERS ? prev : [...prev, `Player ${prev.length + 1}`]));
  }

  function removePlayer(i: number) {
    setNames((prev) => (prev.length <= MIN_PLAYERS ? prev : prev.filter((_, idx) => idx !== i)));
  }

  function start() {
    setError(null);
    const trimmed = names.map((n) => n.trim());
    if (trimmed.some((n) => n.length === 0)) {
      setError("All player names must be non-empty.");
      return;
    }
    if (new Set(trimmed).size !== trimmed.length) {
      setError("Player names must be unique.");
      return;
    }
    let seedNum: number | undefined;
    if (seed.trim().length > 0) {
      const parsed = Number(seed.trim());
      if (!Number.isFinite(parsed)) {
        setError("Seed must be a number.");
        return;
      }
      seedNum = parsed;
    }
    try {
      const engine = new GameEngine({
        gameId: `game-${Date.now()}`,
        playerIds: trimmed,
        ...(seedNum !== undefined ? { seed: seedNum } : {}),
      });
      onStart(engine);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }

  return (
    <div className="screen lobby">
      <h1>Blind Four</h1>
      <p className="muted">Hot-seat mode — pass the device between turns.</p>

      <section className="form-block">
        <h2>Players ({names.length})</h2>
        <ul className="player-list">
          {names.map((name, i) => (
            <li key={i}>
              <input value={name} onChange={(e) => updateName(i, e.target.value)} aria-label={`Player ${i + 1} name`} />
              <button
                type="button"
                className="ghost"
                onClick={() => removePlayer(i)}
                disabled={names.length <= MIN_PLAYERS}
                aria-label={`Remove player ${i + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="ghost" onClick={addPlayer} disabled={names.length >= MAX_PLAYERS}>
          Add player
        </button>
      </section>

      <section className="form-block">
        <label htmlFor="seed">
          Seed <span className="muted">(optional, for deterministic deals)</span>
        </label>
        <input
          id="seed"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="e.g. 0, 17, 999…"
          inputMode="numeric"
        />
      </section>

      {error && <div className="error">{error}</div>}

      <button type="button" className="primary big" onClick={start}>
        Start game
      </button>
    </div>
  );
}
