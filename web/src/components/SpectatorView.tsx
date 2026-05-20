import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { CardView } from "./CardView.js";
import { DeckStack, DiscardStack } from "./Pile.js";
import { Hand } from "./Hand.js";
import { ShuffleSlot } from "./ShuffleSlot.js";
import { FlightLayer, type Flight } from "./FlightLayer.js";
import { tiltForSlot } from "../util/rand.js";

interface Props {
  remote: RemoteEngine;
}

function rectCenter(el: HTMLElement | null): { x: number; y: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function SpectatorView({ remote }: Props) {
  const { identity, visibleState, displayNames, cue } = remote;
  const slotRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const [flights, setFlights] = useState<Flight[]>([]);
  const [hiddenSlots, setHiddenSlots] = useState<Set<string>>(new Set());

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

  if (!identity || !visibleState) return null;
  const visible = visibleState;
  const myId = identity.playerId;
  const currentPlayer = visible.players[visible.currentTurn];
  const currentName = currentPlayer ? (displayNames[currentPlayer.id] ?? currentPlayer.name) : "—";

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
    <div className="screen turn">
      <header className="turn-header">
        <h2>Waiting on {currentName}…</h2>
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
              Showdown called by {visible.callerId ? (displayNames[visible.callerId] ?? visible.callerId) : "?"}.
            </strong>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="opponents">
        <h3>Other players</h3>
        <div className="opponent-list">
          {others.map((op) => {
            const markers = new Map(
              visible.lockMarkers.filter((lm) => lm.playerId === op.id).map((lm) => [lm.cardIndex, lm.markerCard]),
            );
            return (
              <div key={op.id} className="opponent">
                <span className="opponent-name">
                  {displayNames[op.id] ?? op.name}
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
          <DeckStack size={visible.deckSize} />
        </div>
        <div className="pile">
          <span className="pile-label">Discard ({visible.discardPile.length})</span>
          <DiscardStack cards={visible.discardPile} />
        </div>
        <div className="pile drawn placeholder-slot" aria-hidden="true" />
      </section>

      <section className="my-hand">
        <h3>Your hand</h3>
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
