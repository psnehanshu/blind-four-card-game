import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { GameEngine } from "../../../engine/game-engine.js";
import type { Card, EventPayloadMap, PeekResult, ProposedEventType } from "../../../engine/types.js";
import type { Dispatch } from "../game/useEngine.js";
import type { AnimationCue } from "../game/cue.js";
import { CardView } from "./CardView.js";
import { PowerView } from "./PowerView.js";
import { Dialog } from "./Dialog.js";
import { DeckStack, DiscardStack } from "./Pile.js";
import { PeekCardFlip } from "./PeekCardFlip.js";
import { FlightLayer, type Flight } from "./FlightLayer.js";
import { Hand } from "./Hand.js";
import { ShuffleSlot } from "./ShuffleSlot.js";
import { tiltForSlot } from "../util/rand.js";

interface PeekDisplay {
  playerName: string;
  cards: PeekResult["cards"];
}

interface Props {
  engine: GameEngine;
  playerId: string;
  dispatch: Dispatch;
  cue: AnimationCue;
  /** Called once this player's turn has ended (END_TURN or CALL_SHOWDOWN committed). */
  onTurnEnd: () => void;
  onExit: () => void;
}

function rectCenter(el: HTMLElement | null): { x: number; y: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function TurnView({ engine, playerId, dispatch, cue, onTurnEnd, onExit }: Props) {
  const visible = engine.getVisibleState(playerId);
  const valid = engine.getValidEvents(playerId);
  const drawn: Card | null = engine.getDrawnCard(playerId);
  const [error, setError] = useState<string | null>(null);
  const [peekDisplay, setPeekDisplay] = useState<PeekDisplay | null>(null);

  // ───── Flight refs + state ─────
  const deckRef = useRef<HTMLDivElement | null>(null);
  const discardRef = useRef<HTMLDivElement | null>(null);
  const drawnRef = useRef<HTMLDivElement | null>(null);
  const handSlotRefs = useRef<(HTMLElement | null)[]>([]);
  const flightIdRef = useRef(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  // While a flight is animating the entry/exit of a slot, hide the underlying element.
  const [drawnHiddenForFlight, setDrawnHiddenForFlight] = useState(false);
  const [hideDiscardTopForFlight, setHideDiscardTopForFlight] = useState(false);

  function pushFlight(spec: Omit<Flight, "id" | "onComplete">, onDone: () => void) {
    const id = `flight-${++flightIdRef.current}`;
    const flight: Flight = {
      ...spec,
      id,
      onComplete: () => {
        setFlights((prev) => prev.filter((f) => f.id !== id));
        onDone();
      },
    };
    setFlights((prev) => [...prev, flight]);
  }

  const me = visible.players.find((p) => p.id === playerId);
  const meName = me?.name ?? playerId;
  const opponents = visible.players.filter((p) => p.id !== playerId);

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
    const fromEl = source === "deck" ? deckRef.current : discardRef.current;
    const from = rectCenter(fromEl);
    // For source=discard, capture the card BEFORE dispatch so we know what's flying.
    const sourceCardBefore: Card | null = source === "discard" ? (visible.discardPile.at(-1) ?? null) : null;

    const ok = tryDispatch("DRAW_CARD", { source });
    if (!ok || !from) return;

    // After the engine has accepted the draw, the drawn slot mounts on the next render.
    // Wait two frames so layout settles, then snapshot its position.
    setDrawnHiddenForFlight(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const to = rectCenter(drawnRef.current);
        if (!to) {
          setDrawnHiddenForFlight(false);
          return;
        }
        const drawnCard = engine.getDrawnCard(playerId);
        pushFlight(
          {
            from,
            to,
            // discard draws fly face-up; deck draws fly face-down and we reveal at arrival via the underlying slot.
            card: source === "discard" ? sourceCardBefore : null,
            revealAt: source === "deck" ? drawnCard : null,
          },
          () => setDrawnHiddenForFlight(false),
        );
      }),
    );
  }

  function replaceSlot(handIndex: number) {
    const drawnRect = rectCenter(drawnRef.current);
    const handRect = rectCenter(handSlotRefs.current[handIndex] ?? null);
    const discardRect = rectCenter(discardRef.current);
    const drawnBefore = drawn;

    const ok = tryDispatch("REPLACE_CARD", { handIndex });
    if (!ok || !drawnRect || !handRect || !discardRect || !drawnBefore) return;

    // After dispatch: drawn slot will unmount, discard pile gets a new top
    // (the just-replaced hand card). The hand slot stays hidden visually.
    const replacedCard = engine.getVisibleState(playerId).discardPile.at(-1) ?? null;

    setHideDiscardTopForFlight(true);

    // Flight 1: drawn slot → hand slot (the drawn card going into the hand).
    pushFlight({ from: drawnRect, to: handRect, card: drawnBefore, revealAt: null }, () => {
      /* no underlying-element update needed — hand slot was already hidden. */
    });

    // Flight 2: hand slot → discard (the replaced card being discarded).
    if (replacedCard) {
      pushFlight({ from: handRect, to: discardRect, card: replacedCard, revealAt: null }, () => {
        setHideDiscardTopForFlight(false);
      });
    } else {
      // Defensive: clear the hide flag immediately if no replaced card surfaced.
      setHideDiscardTopForFlight(false);
    }
  }

  function discardDrawn() {
    const from = rectCenter(drawnRef.current);
    const to = rectCenter(discardRef.current);
    // Snapshot the currently-drawn card before dispatch so we can fly its face-up.
    const drawnBefore = drawn;
    const ok = tryDispatch("DISCARD_DRAWN", undefined);
    if (!ok || !from || !to || !drawnBefore) return;

    // The new discard-pile top (the just-discarded card) shouldn't pop in via its
    // own entry animation while the flight is in transit — hide it until landed.
    setHideDiscardTopForFlight(true);
    pushFlight({ from, to, card: drawnBefore, revealAt: null }, () => setHideDiscardTopForFlight(false));
  }

  function endTurn() {
    if (tryDispatch("END_TURN", undefined)) onTurnEnd();
  }

  function callShowdown() {
    if (tryDispatch("CALL_SHOWDOWN", undefined)) onTurnEnd();
  }

  // Lock markers for this player so we can render the K/Joker face-up on top of locked slots.
  const myMarkers = new Map(
    visible.lockMarkers.filter((lm) => lm.playerId === playerId).map((lm) => [lm.cardIndex, lm.markerCard]),
  );
  const handSize = me?.handSize ?? 4;

  const canDraw = valid.includes("DRAW_CARD");
  const inDecision = valid.includes("REPLACE_CARD") && valid.includes("DISCARD_DRAWN");
  const inPower = valid.includes("USE_POWER");
  const canEnd = valid.includes("END_TURN");
  const canShowdown = valid.includes("CALL_SHOWDOWN");

  // Slot-level animation cue helpers.
  function slotCueClass(targetPlayerId: string, slotIndex: number): string {
    if (!cue) return "";
    if (cue.kind === "swap") {
      if (cue.a.playerId === targetPlayerId && cue.a.cardIndex === slotIndex) return "swap-pulse";
      if (cue.b.playerId === targetPlayerId && cue.b.cardIndex === slotIndex) return "swap-pulse";
    }
    return "";
  }

  function shuffleNonceFor(handPlayerId: string): number | undefined {
    if (cue?.kind === "shuffle" && cue.targetPlayerId === handPlayerId) return cue.nonce;
    return undefined;
  }

  // For hiding the discard pile's new top while a discard flight is in progress.
  const renderedDiscardPile = hideDiscardTopForFlight ? visible.discardPile.slice(0, -1) : visible.discardPile;

  return (
    <div className="screen turn">
      <header className="turn-header">
        <h2>{meName}&rsquo;s turn</h2>
        <button type="button" className="ghost small" onClick={onExit}>
          Exit to lobby
        </button>
      </header>

      <AnimatePresence>
        {visible.state === "showdown" && (
          <motion.div
            className="showdown-banner"
            initial={{ y: -16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -16, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
          >
            <strong>
              Showdown called by {visible.players.find((p) => p.id === visible.callerId)?.name ?? visible.callerId}.
            </strong>
            <span> This is your final turn.</span>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="opponents">
        <h3>Opponents</h3>
        <div className="opponent-list">
          {opponents.map((op) => {
            const markers = new Map(
              visible.lockMarkers.filter((lm) => lm.playerId === op.id).map((lm) => [lm.cardIndex, lm.markerCard]),
            );
            return (
              <div key={op.id} className="opponent">
                <span className="opponent-name">{op.name}</span>
                <Hand className="hand small" shakeNonce={shuffleNonceFor(op.id)}>
                  {Array.from({ length: op.handSize }).map((_, i) => {
                    const marker = markers.get(i);
                    const locked = !!marker;
                    const extra = slotCueClass(op.id, i);
                    const sn = locked ? undefined : shuffleNonceFor(op.id);
                    const cardView = (
                      <CardView
                        hidden
                        lockMarker={marker}
                        label={`#${i + 1}`}
                        size="sm"
                        tilt={tiltForSlot(op.id, i)}
                        motionProps={extra ? { className: `card-slot ${extra}` } : undefined}
                      />
                    );
                    if (!locked) {
                      return (
                        <ShuffleSlot key={i} slotIndex={i} shuffleNonce={sn}>
                          {cardView}
                        </ShuffleSlot>
                      );
                    }
                    return <div key={i}>{cardView}</div>;
                  })}
                </Hand>
              </div>
            );
          })}
        </div>
      </section>

      <section className="center-row">
        <div className="pile">
          <span className="pile-label">Deck ({visible.deckSize})</span>
          <div ref={deckRef}>
            <DeckStack size={visible.deckSize} />
          </div>
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
          <div ref={discardRef}>
            <DiscardStack cards={renderedDiscardPile} />
          </div>
          <button
            type="button"
            className="primary"
            disabled={!canDraw || visible.discardPile.length === 0}
            onClick={() => drawFrom("discard")}
          >
            Draw from discard
          </button>
        </div>

        {/* Drawn slot — always mounted when there's a drawn card, but visually
            hidden while a draw flight is animating to it. The flight overlay
            provides the entry "feel" instead of an in-place scale animation. */}
        {drawn && (
          <div className="pile drawn" style={{ opacity: drawnHiddenForFlight ? 0 : 1 }}>
            <span className="pile-label">You drew</span>
            <div ref={drawnRef}>
              <CardView card={drawn} size="md" />
            </div>
            {inDecision && (
              <button type="button" className="primary" onClick={discardDrawn}>
                Discard this card
              </button>
            )}
          </div>
        )}
        {/* Reserve the slot area so layout doesn't jump while the drawn pile mounts. */}
        {!drawn && <div className="pile drawn placeholder-slot" aria-hidden="true" />}
      </section>

      <section className="my-hand">
        <h3>Your hand {inDecision && <span className="muted">— tap a slot to replace</span>}</h3>
        <Hand className="hand" shakeNonce={shuffleNonceFor(playerId)}>
          {Array.from({ length: handSize }).map((_, i) => {
            const marker = myMarkers.get(i);
            const locked = !!marker;
            const tilt = tiltForSlot(playerId, i);
            const extra = slotCueClass(playerId, i);
            const sn = locked ? undefined : shuffleNonceFor(playerId);
            const setSlotRef = (el: HTMLElement | null) => {
              handSlotRefs.current[i] = el;
            };
            const cardView = (
              <CardView
                hidden
                lockMarker={marker}
                label={`#${i + 1}`}
                size="lg"
                tilt={tilt}
                motionProps={extra ? { className: `card-slot ${extra}` } : undefined}
              />
            );
            if (inDecision && !locked) {
              return (
                <button key={i} ref={setSlotRef} type="button" className="slot-btn" onClick={() => replaceSlot(i)}>
                  <ShuffleSlot slotIndex={i} shuffleNonce={sn}>
                    {cardView}
                  </ShuffleSlot>
                </button>
              );
            }
            if (!locked) {
              return (
                <div key={i} ref={setSlotRef}>
                  <ShuffleSlot slotIndex={i} shuffleNonce={sn}>
                    {cardView}
                  </ShuffleSlot>
                </div>
              );
            }
            return (
              <div key={i} ref={setSlotRef}>
                {cardView}
              </div>
            );
          })}
        </Hand>
      </section>

      {/* Defer opening the power dialog until any in-flight cards have landed —
          a native <dialog> renders in the browser's top layer (above z-index),
          which would otherwise cover a flying card mid-arc. */}
      <Dialog open={inPower && !peekDisplay && flights.length === 0}>
        {inPower && !peekDisplay && (
          <PowerView engine={engine} playerId={playerId} dispatch={dispatch} onResolved={setPeekDisplay} />
        )}
      </Dialog>

      <Dialog open={!!peekDisplay}>
        {peekDisplay && (
          <section className="peek-result">
            <h3>Peek result — {peekDisplay.playerName}</h3>
            <div className="hand">
              {peekDisplay.cards.map((c) => (
                <PeekCardFlip key={c.index} card={c.card} index={c.index} ownerName={peekDisplay.playerName} />
              ))}
            </div>
            <p className="muted">Only you can see this. Memorize it before continuing.</p>
            <button type="button" className="primary big" onClick={() => setPeekDisplay(null)}>
              Done
            </button>
          </section>
        )}
      </Dialog>

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

      <FlightLayer flights={flights} />
    </div>
  );
}
