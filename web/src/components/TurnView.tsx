import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type {
  BasePowerAction,
  Card,
  EventPayloadMap,
  PeekResult,
  PowerAction,
  ProposedEventType,
  Rank,
} from "../../../engine/types.js";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { CardView } from "./CardView.js";
import { PowerView } from "./PowerView.js";
import { Dialog } from "./Dialog.js";
import { ScalableContent } from "./ScalableContent.js";
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

/** One-line hint shown under "You drew" for cards with special meaning —
 *  the four power ranks, the wild Joker, and 7 (which is worth zero). All
 *  other ranks return null and no hint is rendered. */
function drawnCardHint(rank: Rank): string | null {
  switch (rank) {
    case "10":
      return "Peek";
    case "J":
      return "Shuffle";
    case "Q":
      return "Swap";
    case "K":
      return "Lock";
    case "JOKER":
      return "Wild — mimic any power";
    case "7":
      return "Value 0";
    default:
      return null;
  }
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

  // Set to true the moment we dispatch a power that was driven by an in-place
  // picker (lock or opponent-peek). Stays true until the server confirms
  // (inPower flips false), at which point the cleanup effect resets it.
  // Two jobs: (1) prevent double-click from sending duplicate USE_POWERs, and
  // (2) let us keep lockPickWrap / opponentPeekWrap set after the click so
  // the Dialog doesn't briefly reopen with a stale PowerView (joker picker /
  // peek form) while we wait for STATE.
  const dispatchedRef = useRef(false);

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
  // Countdown shown on the "Done" button after a peek; auto-dismisses when 0.
  const [peekCountdown, setPeekCountdown] = useState<number | null>(null);
  // True while a freshly discarded power card is being spotlighted on the
  // discard pile. Holds the PowerView dialog closed so the player can register
  // what they just discarded before the picker appears.
  const [powerSpotlight, setPowerSpotlight] = useState(false);
  const powerSpotlightArmedRef = useRef(false);
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

  // Auto-dismiss the peek display after 5s so the turn proceeds even if the
  // player doesn't tap Done. Countdown re-armed whenever a new peek arrives.
  useEffect(() => {
    if (!peekDisplay) {
      setPeekCountdown(null);
      return;
    }
    const deadline = Date.now() + 5000;
    setPeekCountdown(5);
    const interval = setInterval(() => {
      const remaining = Math.max(0, deadline - Date.now());
      setPeekCountdown(Math.ceil(remaining / 1000));
    }, 200);
    const timeout = setTimeout(() => setPeekDisplay(null), 5000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [peekDisplay]);

  function pickOpponentPeek(opponentId: string, cardIndex: number) {
    if (dispatchedRef.current) return;
    const wrap = opponentPeekWrap?.fn;
    if (!wrap) return;
    dispatchedRef.current = true;
    // Intentionally don't clear opponentPeekWrap here — the cleanup effect
    // does that when the server confirms the power. Clearing now would let
    // the Dialog re-evaluate with !awaitingOpponentPick=true while inPower is
    // still true (no STATE yet), briefly remounting PowerView's peek form.
    dispatch("USE_POWER", wrap({ power: "peek", target: "opponent", opponentId, opponentCardIndex: cardIndex }));
  }

  function pickLockTarget(targetPlayerId: string, cardIndex: number) {
    if (dispatchedRef.current) return;
    const wrap = lockPickWrap?.fn;
    if (!wrap) return;
    dispatchedRef.current = true;
    // Same rationale as pickOpponentPeek: leave lockPickWrap set so the
    // Dialog doesn't briefly reopen with the (stale) Joker rank picker or K
    // resolve header while we wait for the server STATE response.
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
      // Power phase ended — server confirmed the action (or it never started).
      // Tear down any in-place picker state. Keeping wraps set across the
      // user-click → server-STATE gap is what prevents the Dialog flicker;
      // this is where we release them once it's safe.
      lockArmedRef.current = false;
      dispatchedRef.current = false;
      setLockPickWrap(null);
      setOpponentPeekWrap(null);
      return;
    }
    if (lockArmedRef.current) return;
    if (lockPickWrap || opponentPeekWrap || peekDisplay) return;
    if (topRank !== "K") return;
    lockArmedRef.current = true;
    setLockPickWrap({ fn: (a) => a });
  }, [inPowerNow, topRank, lockPickWrap, opponentPeekWrap, peekDisplay]);

  // When the engine reports a power phase AND the discard pile has finished
  // revealing its new top, give the player ~1.1s with the just-discarded card
  // spotlighted before opening the PowerView dialog. Armed once per power
  // phase; the !inPower branch disarms when the phase ends.
  const spotlightReady = inPowerNow && !hideDiscardTopForFlight;
  useEffect(() => {
    if (!inPowerNow) {
      powerSpotlightArmedRef.current = false;
      setPowerSpotlight(false);
      return;
    }
    if (!spotlightReady) return;
    if (powerSpotlightArmedRef.current) return;
    powerSpotlightArmedRef.current = true;
    setPowerSpotlight(true);
    const t = setTimeout(() => setPowerSpotlight(false), 1100);
    return () => clearTimeout(t);
  }, [inPowerNow, spotlightReady]);

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
    <div className="screen screen--locked turn">
      <header className="turn-header">
        <h2>Your turn</h2>
        <div className="turn-header-actions">
          {awaitingOpponentPick && (
            <div className="peek-chip">
              <span className="peek-chip-note">Tap an opponent card</span>
              <button type="button" className="ghost small" onClick={() => setOpponentPeekWrap(null)}>
                Cancel
              </button>
            </div>
          )}
          {awaitingLockPick && (
            <div className="peek-chip">
              <span className="peek-chip-note">Tap any unlocked card to lock</span>
            </div>
          )}
          {peekDisplay && (
            <div className="peek-chip">
              <span className="peek-chip-note">
                {peekDisplay.kind === "own" ? "Memorize your cards" : `Peeking ${peekDisplay.playerName}`}
              </span>
              <button type="button" className="primary small" onClick={() => setPeekDisplay(null)}>
                Done{peekCountdown !== null ? ` (${peekCountdown})` : ""}
              </button>
            </div>
          )}
          {canShowdown && endCountdown !== null && (
            <button type="button" className="primary small showdown-btn" onClick={callShowdown}>
              Showdown ({endCountdown})
            </button>
          )}
        </div>
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
        <div className={`pile${canDraw && (visible.deckSize > 0 || visible.discardPile.length > 1) ? " is-active" : ""}`}>
          <span className="pile-label">Deck ({visible.deckSize})</span>
          <button
            ref={deckRef}
            type="button"
            className="slot-btn"
            // Engine recycles the discard pile (minus its top) into a fresh
            // deck on the next deck-draw, so the button stays clickable while
            // the discard still has reshufflable cards. Only disabled when
            // truly nothing is drawable.
            disabled={!canDraw || (visible.deckSize === 0 && visible.discardPile.length <= 1)}
            onClick={() => drawFrom("deck")}
            aria-label="Draw from deck"
            title={
              visible.deckSize === 0 && visible.discardPile.length > 1
                ? "Deck is empty — drawing reshuffles the discard pile"
                : undefined
            }
          >
            <DeckStack size={visible.deckSize} />
          </button>
        </div>

        <div
          className={`pile${canDraw && visible.discardPile.length > 0 && !allMyCardsLocked ? " is-active" : ""}${powerSpotlight ? " is-spotlight" : ""}`}
        >
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
                {drawn && drawnCardHint(drawn.rank) && (
                  <span className="drawn-closeup-hint">{drawnCardHint(drawn.rank)}</span>
                )}
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
        {canReplace && <p className="my-hand-hint muted">Tap a slot to replace.</p>}
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

      <Dialog
        open={
          inPower && !peekDisplay && flights.length === 0 && !awaitingOpponentPick && !awaitingLockPick && !powerSpotlight
        }
      >
        {inPower && !peekDisplay && !awaitingOpponentPick && !awaitingLockPick && (
          <ScalableContent>
            <PowerView
              remote={remote}
              onChooseOpponentPeek={(wrap) => setOpponentPeekWrap({ fn: wrap })}
              onChooseLock={(wrap) => setLockPickWrap({ fn: wrap })}
            />
          </ScalableContent>
        )}
      </Dialog>

      {lastError && <div className="error">{lastError}</div>}

      <FlightLayer flights={flights} />
    </div>
  );
}
