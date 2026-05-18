import type { GameEngine } from "../../../engine/game-engine.js";
import type { Dispatch } from "../game/useEngine.js";
import { CardView } from "./CardView.js";

interface Props {
  engine: GameEngine;
  playerId: string;
  dispatch: Dispatch;
  onDone: () => void;
}

export function InitialReveal({ engine, playerId, dispatch, onDone }: Props) {
  const visible = engine.getVisibleState(playerId);
  const me = visible.players.find((p) => p.id === playerId);
  const hand = visible.myHand ?? [];
  const name = me?.name ?? playerId;

  function ack() {
    const result = dispatch(playerId, "ACKNOWLEDGE_REVEAL", undefined);
    if (result.error) {
      alert(`Could not acknowledge: ${result.error}`);
      return;
    }
    onDone();
  }

  return (
    <div className="screen reveal">
      <h2>{name}, memorize your hand</h2>
      <p className="muted">These cards will be hidden after you tap done.</p>

      <div className="hand">
        {hand.map(({ index, card }) => (
          <CardView key={index} card={card.card} label={`#${index + 1}`} locked={card.locked} size="lg" />
        ))}
      </div>

      <button type="button" className="primary big" onClick={ack}>
        Done — hide my cards
      </button>
    </div>
  );
}
