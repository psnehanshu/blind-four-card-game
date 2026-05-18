import { useState } from "react";
import type { GameEngine } from "../../../engine/game-engine.js";
import type { Card, EventPayloadMap, ProposedEventType } from "../../../engine/types.js";
import type { Dispatch } from "../game/useEngine.js";
import { CardView } from "./CardView.js";

interface Props {
  engine: GameEngine;
  playerId: string;
  dispatch: Dispatch;
  /** Called once this player's turn has ended (END_TURN or CALL_SHOWDOWN committed). */
  onTurnEnd: () => void;
  onExit: () => void;
}

export function TurnView({ engine, playerId, dispatch, onTurnEnd, onExit }: Props) {
  const visible = engine.getVisibleState(playerId);
  const valid = engine.getValidEvents(playerId);
  const drawn: Card | null = engine.getDrawnCard(playerId);
  const [error, setError] = useState<string | null>(null);

  const me = visible.players.find((p) => p.id === playerId);
  const meName = me?.name ?? playerId;
  const opponents = visible.players.filter((p) => p.id !== playerId);
  const discardTop = visible.discardPile.at(-1);

  function tryDispatch<T extends ProposedEventType>(type: T, payload: EventPayloadMap[T]) {
    setError(null);
    const result = dispatch(playerId, type, payload);
    if (result.error) {
      setError(result.error);
      return false;
    }
    return true;
  }

  function drawFrom(source: "deck" | "discard") {
    tryDispatch("DRAW_CARD", { source });
  }

  function replaceSlot(handIndex: number) {
    tryDispatch("REPLACE_CARD", { handIndex });
  }

  function discardDrawn() {
    tryDispatch("DISCARD_DRAWN", undefined);
  }

  function endTurn() {
    if (tryDispatch("END_TURN", undefined)) onTurnEnd();
  }

  function callShowdown() {
    if (tryDispatch("CALL_SHOWDOWN", undefined)) onTurnEnd();
  }

  // Lock markers for this player so we can render locked slots visually.
  const myLocks = new Map(visible.lockMarkers.filter((lm) => lm.playerId === playerId).map((lm) => [lm.cardIndex, lm]));
  const handSize = me?.handSize ?? 4;

  const canDraw = valid.includes("DRAW_CARD");
  const inDecision = valid.includes("REPLACE_CARD") && valid.includes("DISCARD_DRAWN");
  const inPower = valid.includes("USE_POWER");
  const canEnd = valid.includes("END_TURN");
  const canShowdown = valid.includes("CALL_SHOWDOWN");

  return (
    <div className="screen turn">
      <header className="turn-header">
        <h2>{meName}&rsquo;s turn</h2>
        <button type="button" className="ghost small" onClick={onExit}>
          Exit to lobby
        </button>
      </header>

      <section className="opponents">
        <h3>Opponents</h3>
        <div className="opponent-list">
          {opponents.map((op) => {
            const locks = new Map(
              visible.lockMarkers.filter((lm) => lm.playerId === op.id).map((lm) => [lm.cardIndex, lm]),
            );
            return (
              <div key={op.id} className="opponent">
                <span className="opponent-name">{op.name}</span>
                <div className="hand small">
                  {Array.from({ length: op.handSize }).map((_, i) => (
                    <CardView key={i} hidden locked={locks.has(i)} label={`#${i + 1}`} size="sm" />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="center-row">
        <div className="pile">
          <span className="pile-label">Deck ({visible.deckSize})</span>
          <CardView hidden size="md" />
          <button
            type="button"
            className="primary"
            disabled={!canDraw || visible.deckSize === 0}
            onClick={() => drawFrom("deck")}
          >
            Draw from deck
          </button>
        </div>

        <div className="pile">
          <span className="pile-label">Discard ({visible.discardPile.length})</span>
          {discardTop ? <CardView card={discardTop} size="md" /> : <CardView hidden size="md" />}
          <button
            type="button"
            className="primary"
            disabled={!canDraw || visible.discardPile.length === 0}
            onClick={() => drawFrom("discard")}
          >
            Draw from discard
          </button>
        </div>

        {drawn && (
          <div className="pile drawn">
            <span className="pile-label">You drew</span>
            <CardView card={drawn} size="md" />
            {inDecision && (
              <button type="button" className="primary" onClick={discardDrawn}>
                Discard this card
              </button>
            )}
          </div>
        )}
      </section>

      <section className="my-hand">
        <h3>Your hand {inDecision && <span className="muted">— tap a slot to replace</span>}</h3>
        <div className="hand">
          {Array.from({ length: handSize }).map((_, i) => {
            const locked = myLocks.has(i);
            if (inDecision && !locked) {
              return (
                <button key={i} type="button" className="slot-btn" onClick={() => replaceSlot(i)}>
                  <CardView hidden locked={locked} label={`#${i + 1}`} size="lg" />
                </button>
              );
            }
            return <CardView key={i} hidden locked={locked} label={`#${i + 1}`} size="lg" />;
          })}
        </div>
      </section>

      {inPower && (
        <section className="placeholder">
          <p>
            You discarded a power card. Power resolution isn&rsquo;t implemented yet — exit to lobby to start a new game,
            or refresh to retry with a different seed.
          </p>
        </section>
      )}

      {(canEnd || canShowdown) && (
        <section className="end-actions">
          {canShowdown && (
            <button type="button" className="primary" onClick={callShowdown}>
              Call showdown
            </button>
          )}
          {canEnd && (
            <button type="button" className="primary big" onClick={endTurn}>
              End turn
            </button>
          )}
        </section>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  );
}
