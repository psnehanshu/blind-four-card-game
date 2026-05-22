import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type {
  BasePowerAction,
  Card,
  EventPayloadMap,
  PeekResult,
  PowerAction,
  ProposedEventType,
} from "../../../engine/types.js";
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
import { playPeek, playShowdown, playYourTurn } from "../audio/sound.js";
import { isPowerCard } from "../../../engine/cards.js";

type PeekDisplay =
  | { kind: "own"; cards: PeekResult["cards"] }
  | { kind: "opponent"; playerId: string; playerName: string; cards: PeekResult["cards"] };

type PowerWrap = (a: BasePowerAction) => PowerAction;

const DRAWN_CLOSEUP_SCALE = 2.6;
// After entering showdown_eligible, give the player a window before auto-ending.
// Longer when showdown is a real choice; shorter buffer otherwise so animations land.
const SHOWDOWN_WINDOW_MS = 3000;
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
  // When set, the player has opted to peek an opponent and we're awaiting a
  // card click in the opponents' hands. Holds the Joker-wrap function so the
  // eventual USE_POWER dispatch packages correctly for both raw 10 and Joker.
  const [opponentPeekWrap, setOpponentPeekWrap] = useState<{ fn: PowerWrap } | null>(null);
  // Same shape, for the lock power — awaits a click on any unlocked card.
  const [lockPickWrap, setLockPickWrap] = useState<{ fn: PowerWrap } | null>(null);

  // ───── Flight refs + state ─────
  const deckRef = useRef<HTMLButtonElement | null>(null);
  const discardRef = useRef<HTMLButtonElement | null>(null);
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

  // TurnView only mounts when control passes to this client, so a mount-only
  // effect is the right hook for the "your turn" cue.
  useEffect(() => {
    playYourTurn();
  }, []);

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

  // Surface the server's peek result to the player who triggered it. Both own
  // and opponent peeks reveal cards in place (the opponent variant inside the
  // opponent's hand row); no dialog is involved.
  useEffect(() => {
    if (!peekResult) return;
    if (peekResult.playerId === playerId) {
      setPeekDisplay({ kind: "own", cards: peekResult.cards });
    } else {
      const target = visible.players.find((p) => p.id === peekResult.playerId);
      const targetName = playerNameFor(peekResult.playerId, playerId, displayNames, target?.name);
      setPeekDisplay({
        kind: "opponent",
        playerId: peekResult.playerId,
        playerName: targetName,
        cards: peekResult.cards,
      });
    }
    playPeek();
    clearPeek();
  }, [peekResult, visible.players, displayNames, clearPeek, playerId]);

  function pickOpponentPeek(opponentId: string, cardIndex: number) {
    const wrap = opponentPeekWrap?.fn;
    if (!wrap) return;
    setOpponentPeekWrap(null);
    dispatch("USE_POWER", wrap({ power: "peek", target: "opponent", opponentId, opponentCardIndex: cardIndex }));
  }

  function pickLockTarget(targetPlayerId: string, cardIndex: number) {
    const wrap = lockPickWrap?.fn;
    if (!wrap) return;
    setLockPickWrap(null);
    dispatch("USE_POWER", wrap({ power: "lock", targetPlayerId, cardIndex }));
  }

  // Direct K on discard: skip the PowerView dialog entirely and go straight
  // to the in-hand picker. The Joker→K path is handled inside PowerView's
  // rank picker, which fires onChooseLock with the Joker wrap.
  const inPowerNow = validEvents.includes("USE_POWER");
  const topRank = visible.discardPile.at(-1)?.rank;
  // Arm once per power phase. Without this guard, picking a card clears
  // lockPickWrap while inPower is still true (the STATE response hasn't
  // arrived), and this effect would re-fire and re-arm lock-pick — trapping
  // the user instead of letting the turn proceed.
  const lockArmedRef = useRef(false);
  useEffect(() => {
    if (!inPowerNow) {
      lockArmedRef.current = false;
      return;
    }
    if (lockArmedRef.current) return;
    if (lockPickWrap || opponentPeekWrap || peekDisplay) return;
    if (topRank !== "K") return;
    lockArmedRef.current = true;
    setLockPickWrap({ fn: (a) => a });
  }, [inPowerNow, topRank, lockPickWrap, opponentPeekWrap, peekDisplay]);

  function callShowdown() {
    clearAutoEnd();
    send("CALL_SHOWDOWN", undefined);
    playShowdown();
  }

  const myMarkers = new Map(
    visible.lockMarkers.filter((lm) => lm.playerId === playerId).map((lm) => [lm.cardIndex, lm.markerCard]),
  );
  const handSize = me?.handSize ?? 4;
  // Discard-pile draws must be placed into the hand, so they're impossible
  // when every own slot is already locked.
  const allMyCardsLocked = me ? me.lockedCards.length >= me.handSize : false;

  const canDraw = validEvents.includes("DRAW_CARD");
  const canReplace = validEvents.includes("REPLACE_CARD");
  const canDiscardDrawn = validEvents.includes("DISCARD_DRAWN");
  const inPower = validEvents.includes("USE_POWER");
  const canEnd = validEvents.includes("END_TURN");
  const canShowdown = validEvents.includes("CALL_SHOWDOWN");

  // Auto-end the turn once we enter showdown_eligible. Waits 5s if showdown is a
  // legal call (so the player can decide), else just buffers long enough for
  // discard/power animations to land. Clicking Call Showdown cancels the timer.
  const peekOpen = !!peekDisplay || !!opponentPeekWrap || !!lockPickWrap;
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

  // Map of own hand indices currently revealed by the in-place own peek.
  const ownPeekMap = new Map<number, Card>();
  if (peekDisplay?.kind === "own") {
    for (const c of peekDisplay.cards) ownPeekMap.set(c.index, c.card);
  }
  // Map of opponent (playerId, index) → card revealed by an opponent peek.
  const opponentPeekMap = new Map<string, Card>();
  if (peekDisplay?.kind === "opponent") {
    for (const c of peekDisplay.cards) opponentPeekMap.set(`${peekDisplay.playerId}-${c.index}`, c.card);
  }
  const awaitingOpponentPick = !!opponentPeekWrap;
  const awaitingLockPick = !!lockPickWrap;

  return (
    <div className="screen turn">
      <header className="turn-header">
        <h2>Your turn</h2>
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
                    const peekedOpCard = opponentPeekMap.get(`${op.id}-${i}`);
                    const cardView = peekedOpCard ? (
                      <PeekCardFlip card={peekedOpCard} index={i} ownerName={op.id} lockMarker={marker} size="sm" />
                    ) : (
                      <CardView hidden lockMarker={marker} label={`#${i + 1}`} size="sm" tilt={tiltForSlot(op.id, i)} />
                    );
                    const inner = locked ? (
                      cardView
                    ) : (
                      <ShuffleSlot slotIndex={i} shuffleNonce={sn}>
                        {cardView}
                      </ShuffleSlot>
                    );
                    if (awaitingOpponentPick) {
                      return (
                        <button
                          key={i}
                          ref={setSlotRef(op.id, i)}
                          type="button"
                          className={hidden ? "slot-btn slot-actionable slot-hidden" : "slot-btn slot-actionable"}
                          onClick={() => pickOpponentPeek(op.id, i)}
                        >
                          {inner}
                        </button>
                      );
                    }
                    if (awaitingLockPick && !locked) {
                      return (
                        <button
                          key={i}
                          ref={setSlotRef(op.id, i)}
                          type="button"
                          className={hidden ? "slot-btn slot-actionable slot-hidden" : "slot-btn slot-actionable"}
                          onClick={() => pickLockTarget(op.id, i)}
                        >
                          {inner}
                        </button>
                      );
                    }
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
        <div className={`pile${canDraw && visible.deckSize > 0 ? " is-active" : ""}`}>
          <span className="pile-label">Deck ({visible.deckSize})</span>
          <button
            ref={deckRef}
            type="button"
            className="slot-btn"
            disabled={!canDraw || visible.deckSize === 0}
            onClick={() => drawFrom("deck")}
            aria-label="Draw from deck"
          >
            <DeckStack size={visible.deckSize} />
          </button>
        </div>

        <div className={`pile${canDraw && visible.discardPile.length > 0 && !allMyCardsLocked ? " is-active" : ""}`}>
          <span className="pile-label">Discard ({visible.discardPile.length})</span>
          <button
            ref={discardRef}
            type="button"
            className="slot-btn"
            disabled={!canDraw || visible.discardPile.length === 0 || allMyCardsLocked}
            onClick={() => drawFrom("discard")}
            aria-label="Draw from discard"
            title={allMyCardsLocked ? "All your cards are locked — draw from the deck instead" : undefined}
          >
            <DiscardStack cards={renderedDiscardPile} />
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
            <div ref={drawnRef} className="drawn-closeup-card">
              <div className="drawn-closeup-scale" style={{ transform: `scale(${DRAWN_CLOSEUP_SCALE})` }}>
                <CardView card={drawn} size="md" />
              </div>
              <div className="drawn-closeup-banner">
                <span className="drawn-closeup-caption">You drew</span>
                {canDiscardDrawn && (
                  <button type="button" className="primary small" onClick={discardDrawn}>
                    {drawn && isPowerCard(drawn.rank) ? "Use power" : "Discard this card"}
                  </button>
                )}
                {canReplace && !canDiscardDrawn && (
                  <p className="drawn-closeup-note">Drawn from discard — must be placed into your hand.</p>
                )}
              </div>
            </div>
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
            const peekedCard = ownPeekMap.get(i);
            const cardView = peekedCard ? (
              <PeekCardFlip card={peekedCard} index={i} ownerName={playerId} lockMarker={marker} />
            ) : (
              <CardView hidden lockMarker={marker} label={`#${i + 1}`} size="lg" tilt={tilt} />
            );
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
                  className={hidden ? "slot-btn slot-actionable slot-hidden" : "slot-btn slot-actionable"}
                  onClick={() => replaceSlot(i)}
                >
                  {inner}
                </button>
              );
            }
            if (awaitingLockPick && !locked) {
              return (
                <button
                  key={i}
                  ref={setSlotRef(playerId, i)}
                  type="button"
                  className={hidden ? "slot-btn slot-actionable slot-hidden" : "slot-btn slot-actionable"}
                  onClick={() => pickLockTarget(playerId, i)}
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

      {awaitingOpponentPick && (
        <section className="peek-in-hand-prompt">
          <p className="muted small-note">Tap any opponent card to peek it.</p>
          <button type="button" className="ghost small" onClick={() => setOpponentPeekWrap(null)}>
            Cancel
          </button>
        </section>
      )}

      {awaitingLockPick && (
        <section className="peek-in-hand-prompt">
          <p className="muted small-note">Tap any unlocked card — yours or an opponent&rsquo;s — to lock it.</p>
        </section>
      )}

      {peekDisplay && (
        <section className="peek-in-hand-prompt">
          <p className="muted small-note">
            {peekDisplay.kind === "own"
              ? "Memorize your cards — they’ll flip face-down when you click Done."
              : `Peeking ${peekDisplay.playerName}’s card — click Done when you’ve memorized it.`}
          </p>
          <button type="button" className="primary big" onClick={() => setPeekDisplay(null)}>
            Done
          </button>
        </section>
      )}

      <Dialog open={inPower && !peekDisplay && flights.length === 0 && !awaitingOpponentPick && !awaitingLockPick}>
        {inPower && !peekDisplay && !awaitingOpponentPick && !awaitingLockPick && (
          <PowerView
            remote={remote}
            onChooseOpponentPeek={(wrap) => setOpponentPeekWrap({ fn: wrap })}
            onChooseLock={(wrap) => setLockPickWrap({ fn: wrap })}
          />
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
