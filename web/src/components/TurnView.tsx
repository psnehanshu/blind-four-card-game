import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Card, EventPayloadMap, PeekResult, ProposedEventType } from "../../../engine/types.js";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { CardView } from "./CardView.js";
import { PowerView } from "./PowerView.js";
import { Dialog } from "./Dialog.js";
import { DeckStack, DiscardStack } from "./Pile.js";
import { PeekCardFlip } from "./PeekCardFlip.js";
import { FlightLayer, type Flight } from "./FlightLayer.js";
import { Hand } from "./Hand.js";
import { ShuffleSlot } from "./ShuffleSlot.js";
import { tiltForSlot } from "../util/rand.js";
import { playerNameFor } from "../util/playerName.js";
import { playPeek, playShowdown } from "../audio/sound.js";

interface PeekDisplay {
  playerName: string;
  cards: PeekResult["cards"];
}

const DRAWN_CLOSEUP_SCALE = 2.6;
// After entering showdown_eligible, give the player a window before auto-ending.
// Longer when showdown is a real choice; shorter buffer otherwise so animations land.
const SHOWDOWN_WINDOW_MS = 5000;
const AUTO_END_BUFFER_MS = 1000;

interface Props {
  remote: RemoteEngine;
}

function rectCenter(el: HTMLElement | null): { x: number; y: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function TurnView({ remote }: Props) {
  const { identity, visibleState, validEvents, drawnCard, cue, displayNames, dispatch, lastError, peekResult, clearPeek } =
    remote;
  if (!identity || !visibleState) return null;
  const playerId = identity.playerId;
  const visible = visibleState;
  const drawn: Card | null = drawnCard;
  const [peekDisplay, setPeekDisplay] = useState<PeekDisplay | null>(null);

  // ───── Flight refs + state ─────
  const deckRef = useRef<HTMLDivElement | null>(null);
  const discardRef = useRef<HTMLDivElement | null>(null);
  const drawnRef = useRef<HTMLDivElement | null>(null);
  // Keyed by `${playerId}-${cardIndex}` — covers every hand slot on screen
  // (mine and opponents'), so the swap power can fly cards between any two.
  const slotRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const flightIdRef = useRef(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  // While a flight is animating the entry/exit of a slot, hide the underlying element.
  const [drawnHiddenForFlight, setDrawnHiddenForFlight] = useState(false);
  const [hideDiscardTopForFlight, setHideDiscardTopForFlight] = useState(false);
  // Slots whose contents are visually hidden while a swap flight is in transit.
  const [hiddenSlots, setHiddenSlots] = useState<Set<string>>(new Set());
  // Countdown displayed alongside the Call Showdown button (null = no window active).
  const [endCountdown, setEndCountdown] = useState<number | null>(null);
  const endTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // dispatch is recreated each render; ref it so the auto-end effect stays stable.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  function setSlotRef(handPlayerId: string, cardIndex: number) {
    return (el: HTMLElement | null) => {
      slotRefs.current.set(`${handPlayerId}-${cardIndex}`, el);
    };
  }

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
  const meName = playerNameFor(playerId, playerId, displayNames, me?.name);
  const opponents = visible.players.filter((p) => p.id !== playerId);

  function send<T extends ProposedEventType>(type: T, payload: EventPayloadMap[T]) {
    dispatch(type, payload);
  }

  function drawFrom(source: "deck" | "discard") {
    const fromEl = source === "deck" ? deckRef.current : discardRef.current;
    const from = rectCenter(fromEl);
    const sourceCardBefore: Card | null = source === "discard" ? (visible.discardPile.at(-1) ?? null) : null;
    send("DRAW_CARD", { source });
    if (!from) return;
    setDrawnHiddenForFlight(true);
    // After the engine's STATE push arrives, drawnRef will be mounted.
    // Two RAFs let the next render settle so we can snapshot the destination.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const to = rectCenter(drawnRef.current);
        if (!to) {
          setDrawnHiddenForFlight(false);
          return;
        }
        // After the STATE push, remote.drawnCard reflects the deck-drawn card.
        const justDrawn = source === "deck" ? remote.drawnCard : null;
        pushFlight(
          {
            from,
            to,
            card: source === "discard" ? sourceCardBefore : null,
            revealAt: source === "deck" ? justDrawn : null,
            scaleTo: DRAWN_CLOSEUP_SCALE,
            arcLift: 120,
          },
          () => setDrawnHiddenForFlight(false),
        );
      }),
    );
  }

  function replaceSlot(handIndex: number) {
    const drawnRect = rectCenter(drawnRef.current);
    const handEl = slotRefs.current.get(`${playerId}-${handIndex}`) ?? null;
    const handRect = rectCenter(handEl);
    const discardRect = rectCenter(discardRef.current);
    const drawnBefore = drawn;

    send("REPLACE_CARD", { handIndex });
    if (!drawnRect || !handRect || !discardRect || !drawnBefore) return;

    setHideDiscardTopForFlight(true);

    pushFlight(
      { from: drawnRect, to: handRect, card: drawnBefore, revealAt: null, scaleFrom: DRAWN_CLOSEUP_SCALE },
      () => {
        /* no underlying-element update needed — hand slot was already hidden. */
      },
    );

    // Hand slot → discard. We don't know which card was at handIndex (it was hidden
    // before this turn), so the flight is face-down; the new discard top will reveal
    // once the STATE push arrives and we drop hideDiscardTopForFlight.
    pushFlight({ from: handRect, to: discardRect, card: null, revealAt: null }, () => {
      setHideDiscardTopForFlight(false);
    });
  }

  function discardDrawn() {
    const from = rectCenter(drawnRef.current);
    const to = rectCenter(discardRef.current);
    const drawnBefore = drawn;
    send("DISCARD_DRAWN", undefined);
    if (!from || !to || !drawnBefore) return;
    setHideDiscardTopForFlight(true);
    pushFlight({ from, to, card: drawnBefore, revealAt: null, scaleFrom: DRAWN_CLOSEUP_SCALE }, () =>
      setHideDiscardTopForFlight(false),
    );
  }

  function clearAutoEnd() {
    if (endTimeoutRef.current) {
      clearTimeout(endTimeoutRef.current);
      endTimeoutRef.current = null;
    }
    if (endIntervalRef.current) {
      clearInterval(endIntervalRef.current);
      endIntervalRef.current = null;
    }
    setEndCountdown(null);
  }

  useEffect(() => {
    if (cue?.kind !== "swap") return;
    const aKey = `${cue.a.playerId}-${cue.a.cardIndex}`;
    const bKey = `${cue.b.playerId}-${cue.b.cardIndex}`;
    const aPos = rectCenter(slotRefs.current.get(aKey) ?? null);
    const bPos = rectCenter(slotRefs.current.get(bKey) ?? null);
    if (!aPos || !bPos) return;

    setHiddenSlots((prev) => new Set([...prev, aKey, bKey]));

    const idA = `swap-${cue.nonce}-a`;
    const idB = `swap-${cue.nonce}-b`;

    const reveal = (key: string) =>
      setHiddenSlots((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });

    const flightA: Flight = {
      id: idA,
      card: null,
      from: aPos,
      to: bPos,
      arcLift: 80,
      onComplete: () => {
        setFlights((prev) => prev.filter((f) => f.id !== idA));
        reveal(bKey);
      },
    };
    const flightB: Flight = {
      id: idB,
      card: null,
      from: bPos,
      to: aPos,
      arcLift: 30,
      onComplete: () => {
        setFlights((prev) => prev.filter((f) => f.id !== idB));
        reveal(aKey);
      },
    };
    setFlights((prev) => [...prev, flightA, flightB]);
  }, [cue]);

  // Surface the server's peek result to the player who triggered it.
  useEffect(() => {
    if (!peekResult) return;
    const target = visible.players.find((p) => p.id === peekResult.playerId);
    const targetName = playerNameFor(peekResult.playerId, playerId, displayNames, target?.name);
    setPeekDisplay({ playerName: targetName, cards: peekResult.cards });
    playPeek();
    clearPeek();
  }, [peekResult, visible.players, displayNames, clearPeek]);

  function callShowdown() {
    clearAutoEnd();
    send("CALL_SHOWDOWN", undefined);
    playShowdown();
  }

  const myMarkers = new Map(
    visible.lockMarkers.filter((lm) => lm.playerId === playerId).map((lm) => [lm.cardIndex, lm.markerCard]),
  );
  const handSize = me?.handSize ?? 4;

  const canDraw = validEvents.includes("DRAW_CARD");
  const canReplace = validEvents.includes("REPLACE_CARD");
  const canDiscardDrawn = validEvents.includes("DISCARD_DRAWN");
  const inPower = validEvents.includes("USE_POWER");
  const canEnd = validEvents.includes("END_TURN");
  const canShowdown = validEvents.includes("CALL_SHOWDOWN");

  // Auto-end the turn once we enter showdown_eligible. Waits 5s if showdown is a
  // legal call (so the player can decide), else just buffers long enough for
  // discard/power animations to land. Clicking Call Showdown cancels the timer.
  const peekOpen = !!peekDisplay;
  useEffect(() => {
    if (!canEnd || inPower || peekOpen) {
      clearAutoEnd();
      return;
    }
    if (endTimeoutRef.current) return; // already armed

    const windowMs = canShowdown ? SHOWDOWN_WINDOW_MS : AUTO_END_BUFFER_MS;
    const deadline = Date.now() + windowMs;

    if (canShowdown) {
      setEndCountdown(Math.ceil(windowMs / 1000));
      endIntervalRef.current = setInterval(() => {
        const remaining = Math.max(0, deadline - Date.now());
        setEndCountdown(Math.ceil(remaining / 1000));
      }, 200);
    }

    endTimeoutRef.current = setTimeout(() => {
      clearAutoEnd();
      dispatchRef.current("END_TURN", undefined);
    }, windowMs);

    return clearAutoEnd;
  }, [canEnd, canShowdown, inPower, peekOpen]);

  function shuffleNonceFor(handPlayerId: string): number | undefined {
    if (cue?.kind === "shuffle" && cue.targetPlayerId === handPlayerId) return cue.nonce;
    return undefined;
  }

  const renderedDiscardPile = hideDiscardTopForFlight ? visible.discardPile.slice(0, -1) : visible.discardPile;

  return (
    <div className="screen turn">
      <header className="turn-header">
        <h2>{meName}&rsquo;s turn</h2>
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
              Showdown called by{" "}
              {visible.callerId
                ? playerNameFor(
                    visible.callerId,
                    playerId,
                    displayNames,
                    visible.players.find((p) => p.id === visible.callerId)?.name,
                  )
                : "?"}
              .
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
                <span className="opponent-name">{playerNameFor(op.id, playerId, displayNames, op.name)}</span>
                <Hand className="hand small" shakeNonce={shuffleNonceFor(op.id)}>
                  {Array.from({ length: op.handSize }).map((_, i) => {
                    const marker = markers.get(i);
                    const locked = !!marker;
                    const sn = locked ? undefined : shuffleNonceFor(op.id);
                    const hidden = hiddenSlots.has(`${op.id}-${i}`);
                    const cardView = (
                      <CardView hidden lockMarker={marker} label={`#${i + 1}`} size="sm" tilt={tiltForSlot(op.id, i)} />
                    );
                    const inner = locked ? (
                      cardView
                    ) : (
                      <ShuffleSlot slotIndex={i} shuffleNonce={sn}>
                        {cardView}
                      </ShuffleSlot>
                    );
                    return (
                      <div key={i} ref={setSlotRef(op.id, i)} className={hidden ? "slot-hidden" : undefined}>
                        {inner}
                      </div>
                    );
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
      </section>

      <AnimatePresence>
        {drawn && (
          <motion.div
            key="drawn-closeup"
            className="drawn-closeup"
            initial={{ opacity: 0, y: 40, scale: 0.6 }}
            animate={{ opacity: drawnHiddenForFlight ? 0 : 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -40, scale: 0.8 }}
            transition={{ type: "spring", stiffness: 220, damping: 22 }}
          >
            <span className="pile-label">You drew</span>
            <div ref={drawnRef} className="drawn-closeup-card">
              <div className="drawn-closeup-scale" style={{ transform: `scale(${DRAWN_CLOSEUP_SCALE})` }}>
                <CardView card={drawn} size="md" />
              </div>
            </div>
            {canDiscardDrawn && (
              <button type="button" className="primary" onClick={discardDrawn}>
                Discard this card
              </button>
            )}
            {canReplace && !canDiscardDrawn && (
              <p className="muted small-note">Drawn from discard — must be placed into your hand.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <section className="my-hand">
        <h3>Your hand {canReplace && <span className="muted">— tap a slot to replace</span>}</h3>
        <Hand className="hand" shakeNonce={shuffleNonceFor(playerId)}>
          {Array.from({ length: handSize }).map((_, i) => {
            const marker = myMarkers.get(i);
            const locked = !!marker;
            const tilt = tiltForSlot(playerId, i);
            const sn = locked ? undefined : shuffleNonceFor(playerId);
            const hidden = hiddenSlots.has(`${playerId}-${i}`);
            const cardView = <CardView hidden lockMarker={marker} label={`#${i + 1}`} size="lg" tilt={tilt} />;
            const inner = locked ? (
              cardView
            ) : (
              <ShuffleSlot slotIndex={i} shuffleNonce={sn}>
                {cardView}
              </ShuffleSlot>
            );
            if (canReplace && !locked) {
              return (
                <button
                  key={i}
                  ref={setSlotRef(playerId, i)}
                  type="button"
                  className={hidden ? "slot-btn slot-hidden" : "slot-btn"}
                  onClick={() => replaceSlot(i)}
                >
                  {inner}
                </button>
              );
            }
            return (
              <div key={i} ref={setSlotRef(playerId, i)} className={hidden ? "slot-hidden" : undefined}>
                {inner}
              </div>
            );
          })}
        </Hand>
      </section>

      <Dialog open={inPower && !peekDisplay && flights.length === 0}>
        {inPower && !peekDisplay && <PowerView remote={remote} />}
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

      {canShowdown && endCountdown !== null && (
        <section className="end-actions">
          <button type="button" className="primary big" onClick={callShowdown}>
            Call showdown ({endCountdown})
          </button>
        </section>
      )}

      {lastError && <div className="error">{lastError}</div>}

      <FlightLayer flights={flights} />
    </div>
  );
}
