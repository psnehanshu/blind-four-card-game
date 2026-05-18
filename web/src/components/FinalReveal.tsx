import type { GameEngine } from "../../../engine/game-engine.js";
import { CardView } from "./CardView.js";
import { tiltForSlot } from "../util/rand.js";

interface Props {
  engine: GameEngine;
  onExit: () => void;
}

export function FinalReveal({ engine, onExit }: Props) {
  // Game is finished — all hands are public per spec, so we read the live state.
  const game = engine.getState();
  const winners = new Set(engine.winners.map((w) => w.id));
  const callerName = game.players.find((p) => p.id === game.callerId)?.name;
  const markersByPlayer = new Map<string, Map<number, import("../../../engine/types.js").Card>>();
  // The live Game type doesn't expose lockMarkers; pull them via any player's visible state
  // (lockMarkers are public, so any playerId works).
  const anyPlayerId = game.players[0]?.id;
  if (anyPlayerId) {
    const vs = engine.getVisibleState(anyPlayerId);
    for (const lm of vs.lockMarkers) {
      const map = markersByPlayer.get(lm.playerId) ?? new Map();
      map.set(lm.cardIndex, lm.markerCard);
      markersByPlayer.set(lm.playerId, map);
    }
  }

  const rows = game.players.map((player) => {
    const score = player.hand.reduce((sum, pc) => sum + pc.card.value, 0);
    const markers = markersByPlayer.get(player.id) ?? new Map();
    return { player, score, markers };
  });

  const lowestScore = Math.min(...rows.map((r) => r.score));

  return (
    <div className="screen final">
      <h2>Game over</h2>
      {callerName && <p className="muted">{callerName} called showdown.</p>}

      <section className="final-results">
        {rows.map(({ player, score, markers }) => {
          const isWinner = winners.has(player.id);
          const isCaller = player.id === game.callerId;
          return (
            <div key={player.id} className={isWinner ? "final-row winner" : "final-row"}>
              <div className="final-row-header">
                <span className="final-name">
                  {player.name}
                  {isCaller && <span className="badge caller">CALLER</span>}
                  {isWinner && <span className="badge winner-badge">WINNER</span>}
                </span>
                <span className={score === lowestScore ? "final-score low" : "final-score"}>{score}</span>
              </div>
              <div className="hand">
                {player.hand.map((pc, i) => (
                  <CardView
                    key={i}
                    card={pc.card}
                    label={`#${i + 1}`}
                    size="md"
                    lockMarker={markers.get(i)}
                    markerStyle="label"
                    tilt={tiltForSlot(player.id, i)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <button type="button" className="primary big" onClick={onExit}>
        Back to lobby
      </button>
    </div>
  );
}
