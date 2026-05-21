import { useEffect } from "react";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { CardView } from "./CardView.js";
import { tiltForSlot } from "../util/rand.js";
import { playWin } from "../audio/sound.js";

interface Props {
  remote: RemoteEngine;
}

export function FinalReveal({ remote }: Props) {
  useEffect(() => {
    playWin();
  }, []);

  async function exitToSplash() {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* ignore */
      }
    }
    window.location.assign("/");
  }
  const { visibleState, displayNames, winnerIds } = remote;
  if (!visibleState) return null;
  const winners = new Set(winnerIds);
  const callerId = visibleState.callerId;
  const callerName = callerId
    ? (displayNames[callerId] ?? visibleState.players.find((p) => p.id === callerId)?.name)
    : undefined;

  const markersByPlayer = new Map<string, Map<number, import("../../../engine/types.js").Card>>();
  for (const lm of visibleState.lockMarkers) {
    const map = markersByPlayer.get(lm.playerId) ?? new Map();
    map.set(lm.cardIndex, lm.markerCard);
    markersByPlayer.set(lm.playerId, map);
  }

  const allHands = visibleState.allHands ?? [];
  const rows = allHands.map((entry) => {
    const player = visibleState.players.find((p) => p.id === entry.playerId);
    const name = displayNames[entry.playerId] ?? player?.name ?? entry.playerId;
    const score = entry.hand.reduce((sum, pc) => sum + pc.card.value, 0);
    const markers = markersByPlayer.get(entry.playerId) ?? new Map();
    return { playerId: entry.playerId, name, hand: entry.hand, score, markers };
  });

  const lowestScore = rows.length > 0 ? Math.min(...rows.map((r) => r.score)) : 0;

  return (
    <div className="screen final">
      <h2>Game over</h2>
      {callerName && <p className="muted">{callerName} called showdown.</p>}

      <section className="final-results">
        {rows.map(({ playerId, name, hand, score, markers }) => {
          const isWinner = winners.has(playerId);
          const isCaller = playerId === callerId;
          return (
            <div key={playerId} className={isWinner ? "final-row winner" : "final-row"}>
              <div className="final-row-header">
                <span className="final-name">
                  {name}
                  {isCaller && <span className="badge caller">CALLER</span>}
                  {isWinner && <span className="badge winner-badge">WINNER</span>}
                </span>
                <span className={score === lowestScore ? "final-score low" : "final-score"}>{score}</span>
              </div>
              <div className="hand">
                {hand.map((pc, i) => (
                  <CardView
                    key={i}
                    card={pc.card}
                    label={`#${i + 1}`}
                    size="md"
                    lockMarker={markers.get(i)}
                    markerStyle="label"
                    tilt={tiltForSlot(playerId, i)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <button type="button" className="primary big" onClick={exitToSplash}>
        Exit
      </button>
    </div>
  );
}
