import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Card } from "../../../engine/types.js";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { CardView } from "./CardView.js";
import { DeckStack, DiscardStack } from "./Pile.js";
import { Hand } from "./Hand.js";
import { ShuffleSlot } from "./ShuffleSlot.js";
import { FlightLayer, type Flight } from "./FlightLayer.js";
import { Cheatsheet } from "./Cheatsheet.js";
import { tiltForSlot } from "../util/rand.js";
import { playerNameFor } from "../util/playerName.js";

interface Props {
  remote: RemoteEngine;
}

function rectCenter(el: HTMLElement | null): { x: number; y: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function SpectatorView({ remote }: Props) {
  const { identity, visibleState, displayNames, onlinePlayerIds, cue } = remote;
  const slotRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const deckRef = useRef<HTMLDivElement | null>(null);
  const discardRef = useRef<HTMLDivElement | null>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [hiddenSlots, setHiddenSlots] = useState<Set<string>>(new Set());
  const [hideDiscardTopForFlight, setHideDiscardTopForFlight] = useState(false);
  // Captures the discard top from the previous render so opponent draws from
  // the discard pile can fly face-up — the new state has already removed it.
  const prevDiscardTopRef = useRef<Card | null>(null);

  // Swap animation when watching from the sidelines.
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
    setFlights((prev) => [
      ...prev,
      {
        id: idA,
        card: null,
        from: aPos,
        to: bPos,
        arcLift: 80,
        onComplete: () => {
          setFlights((p) => p.filter((f) => f.id !== idA));
          reveal(bKey);
        },
      },
      {
        id: idB,
        card: null,
        from: bPos,
        to: aPos,
        arcLift: 30,
        onComplete: () => {
          setFlights((p) => p.filter((f) => f.id !== idB));
          reveal(aKey);
        },
      },
    ]);
  }, [cue]);

  const myId = identity?.playerId;

  // Opponent discards (REPLACE_CARD + DISCARD_DRAWN): fly a card from the
  // actor's hand area to the discard pile. Skips the current player — their
  // own TurnView already ran the local handler before we got the STATE push.
  useEffect(() => {
    if (!cue || !visibleState || !myId) return;
    if (cue.kind !== "replace" && cue.kind !== "discard") return;
    if (cue.actorId === myId) return;

    const toCenter = rectCenter(discardRef.current);
    if (!toCenter) return;
    const discardedCard = visibleState.discardPile.at(-1) ?? null;

    let fromCenter: { x: number; y: number } | null = null;
    if (cue.kind === "replace") {
      fromCenter = rectCenter(slotRefs.current.get(`${cue.actorId}-${cue.handIndex}`) ?? null);
    } else {
      // No specific slot for DISCARD_DRAWN — synthesize a source above the
      // actor's hand center, mimicking where the held card would have been.
      const slot0 = rectCenter(slotRefs.current.get(`${cue.actorId}-0`) ?? null);
      if (slot0) fromCenter = { x: slot0.x, y: slot0.y - 80 };
    }
    if (!fromCenter) return;

    const id = `op-discard-${cue.nonce}`;
    setHideDiscardTopForFlight(true);
    setFlights((prev) => [
      ...prev,
      {
        id,
        card: discardedCard,
        from: fromCenter,
        to: toCenter,
        onComplete: () => {
          setFlights((p) => p.filter((f) => f.id !== id));
          setHideDiscardTopForFlight(false);
        },
      },
    ]);
  }, [cue, visibleState, myId]);

  // Opponent draws (DRAW_CARD): fly a card from the deck or discard pile to a
  // "holding" position above the actor's hand. Skips the local player — their
  // own TurnView shows the drawn card directly. For deck source the card flies
  // face-down (its identity is private); for discard source we fly face-up
  // using the captured previous-top, since the new state has already removed
  // it from the pile.
  useEffect(() => {
    if (!cue || !visibleState || !myId) return;
    if (cue.kind !== "draw") return;
    if (cue.actorId === myId) return;

    const fromEl = cue.source === "deck" ? deckRef.current : discardRef.current;
    const fromCenter = rectCenter(fromEl);
    if (!fromCenter) return;
    const slot0 = rectCenter(slotRefs.current.get(`${cue.actorId}-0`) ?? null);
    if (!slot0) return;
    const toCenter = { x: slot0.x, y: slot0.y - 80 };

    const flyingCard = cue.source === "discard" ? prevDiscardTopRef.current : null;
    const id = `op-draw-${cue.nonce}`;
    setFlights((prev) => [
      ...prev,
      {
        id,
        card: flyingCard,
        from: fromCenter,
        to: toCenter,
        onComplete: () => {
          setFlights((p) => p.filter((f) => f.id !== id));
        },
      },
    ]);
  }, [cue, visibleState, myId]);

  // Track previous discard-pile top. Placed *after* the draw effect so that
  // effect reads the prior-render value before this one overwrites it.
  useEffect(() => {
    prevDiscardTopRef.current = visibleState?.discardPile.at(-1) ?? null;
  }, [visibleState]);

  if (!identity || !visibleState || !myId) return null;
  const visible = visibleState;
  const currentPlayer = visible.players[visible.currentTurn];
  const currentName = currentPlayer ? playerNameFor(currentPlayer.id, myId, displayNames, currentPlayer.name) : "—";

  function setSlotRef(handPlayerId: string, cardIndex: number) {
    return (el: HTMLElement | null) => {
      slotRefs.current.set(`${handPlayerId}-${cardIndex}`, el);
    };
  }

  function shuffleNonceFor(handPlayerId: string): number | undefined {
    if (cue?.kind === "shuffle" && cue.targetPlayerId === handPlayerId) return cue.nonce;
    return undefined;
  }

  const myMarkers = new Map(
    visible.lockMarkers.filter((lm) => lm.playerId === myId).map((lm) => [lm.cardIndex, lm.markerCard]),
  );
  const me = visible.players.find((p) => p.id === myId);
  const myHandSize = me?.handSize ?? 4;
  const others = visible.players.filter((p) => p.id !== myId);

  return (
    <div className="screen screen--locked turn">
      <header className="turn-header">
        <h2>
          <span
            className={`presence-dot${onlinePlayerIds.has(myId) ? " is-online" : " is-offline"}`}
            aria-label={onlinePlayerIds.has(myId) ? "Online" : "Offline"}
          />
          Waiting on {currentName}…
        </h2>
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
              Showdown called by {visible.callerId ? playerNameFor(visible.callerId, myId, displayNames) : "?"}.
            </strong>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="opponents">
        <div className="opponent-list">
          {others.map((op) => {
            const markers = new Map(
              visible.lockMarkers.filter((lm) => lm.playerId === op.id).map((lm) => [lm.cardIndex, lm.markerCard]),
            );
            return (
              <div key={op.id} className={`opponent${op.id === currentPlayer?.id ? " is-current" : ""}`}>
                <span className="opponent-name">
                  <span
                    className={`presence-dot${onlinePlayerIds.has(op.id) ? " is-online" : " is-offline"}`}
                    aria-label={onlinePlayerIds.has(op.id) ? "Online" : "Offline"}
                  />
                  {playerNameFor(op.id, myId, displayNames, op.name)}
                  {op.id === currentPlayer?.id && <span className="badge caller">TURN</span>}
                </span>
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
        </div>
        <div className="pile">
          <span className="pile-label">Discard ({visible.discardPile.length})</span>
          <div ref={discardRef}>
            <DiscardStack cards={hideDiscardTopForFlight ? visible.discardPile.slice(0, -1) : visible.discardPile} />
          </div>
        </div>
        <div className="pile drawn placeholder-slot" aria-hidden="true" />
        <Cheatsheet />
      </section>

      <section className="my-hand">
        <Hand className="hand" shakeNonce={shuffleNonceFor(myId)}>
          {Array.from({ length: myHandSize }).map((_, i) => {
            const marker = myMarkers.get(i);
            const locked = !!marker;
            const sn = locked ? undefined : shuffleNonceFor(myId);
            const hidden = hiddenSlots.has(`${myId}-${i}`);
            const cardView = (
              <CardView hidden lockMarker={marker} label={`#${i + 1}`} size="lg" tilt={tiltForSlot(myId, i)} />
            );
            const inner = locked ? (
              cardView
            ) : (
              <ShuffleSlot slotIndex={i} shuffleNonce={sn}>
                {cardView}
              </ShuffleSlot>
            );
            return (
              <div key={i} ref={setSlotRef(myId, i)} className={hidden ? "slot-hidden" : undefined}>
                {inner}
              </div>
            );
          })}
        </Hand>
      </section>

      <FlightLayer flights={flights} />
    </div>
  );
}
