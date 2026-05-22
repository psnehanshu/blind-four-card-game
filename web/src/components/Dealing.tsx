import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { CardView } from "./CardView.js";
import { DeckStack } from "./Pile.js";
import { FlightLayer, type Flight } from "./FlightLayer.js";
import { playDeal, playShuffle } from "../audio/sound.js";

interface Props {
  players: { id: string; name: string }[];
  handSize: number;
  onComplete: () => void;
}

const SHUFFLE_MS = 1400;
const DEAL_INTERVAL_MS = 170;
const SETTLE_PAUSE_MS = 500;
const FULL_DECK = 54;

/**
 * Intro animation played once when the game starts. Shows the deck shuffling
 * for a beat, then deals face-down cards from the deck to each player's slots
 * in round-robin order. Cards visibly "land" in their player's hand area.
 *
 * The engine has already done the actual deal — this is purely cosmetic and
 * runs before the first PassDeviceGate.
 */
export function Dealing({ players, handSize, onComplete }: Props) {
  const totalCards = players.length * handSize;
  const [phase, setPhase] = useState<"shuffle" | "deal" | "settle">("shuffle");
  const [flights, setFlights] = useState<Flight[]>([]);
  const [settled, setSettled] = useState(0);
  const [dispatched, setDispatched] = useState(0);
  const flightIdRef = useRef(0);
  const deckRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Shuffle → deal handoff.
  useEffect(() => {
    if (phase !== "shuffle") return;
    playShuffle();
    const t = setTimeout(() => setPhase("deal"), SHUFFLE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Schedule each successive deal. Each tick measures the deck and target
  // slot, spawns a face-down flight, and bumps `dispatched` so the next tick
  // can run. Flights land in dispatch order (same duration, FIFO), so the
  // settled count maps 1:1 to dealOrder.
  useEffect(() => {
    if (phase !== "deal") return;
    if (dispatched >= totalCards) return;
    const delay = dispatched === 0 ? 80 : DEAL_INTERVAL_MS;
    const t = setTimeout(() => {
      const playerIndex = dispatched % players.length;
      const slotIndex = Math.floor(dispatched / players.length);
      const fromEl = deckRef.current;
      const toEl = slotRefs.current.get(`${playerIndex}-${slotIndex}`);
      if (fromEl && toEl) {
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        const id = `deal-${++flightIdRef.current}`;
        const flight: Flight = {
          id,
          card: null,
          from: { x: fromRect.x + fromRect.width / 2, y: fromRect.y + fromRect.height / 2 },
          to: { x: toRect.x + toRect.width / 2, y: toRect.y + toRect.height / 2 },
          onComplete: () => {
            setFlights((prev) => prev.filter((f) => f.id !== id));
            setSettled((s) => s + 1);
            playDeal();
          },
        };
        setFlights((prev) => [...prev, flight]);
      } else {
        // Refs not available — advance anyway so we don't deadlock.
        setSettled((s) => s + 1);
      }
      setDispatched((n) => n + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [phase, dispatched, totalCards, players.length]);

  // All cards settled → brief pause, then hand off to the game shell.
  useEffect(() => {
    if (settled < totalCards) return;
    setPhase("settle");
    const t = setTimeout(onComplete, SETTLE_PAUSE_MS);
    return () => clearTimeout(t);
  }, [settled, totalCards, onComplete]);

  const title = phase === "shuffle" ? "Shuffling…" : phase === "deal" ? "Dealing…" : "Ready";

  return (
    <div className="screen dealing">
      <h2>{title}</h2>

      <div className="dealing-deck" ref={deckRef}>
        {phase === "shuffle" ? <ShufflingDeck /> : <DeckStack size={Math.max(0, FULL_DECK - settled)} />}
      </div>

      <div className="dealing-players">
        {players.map((p, pi) => (
          <div key={p.id} className="dealing-player">
            <span className="opponent-name">{p.name}</span>
            <div className="hand small">
              {Array.from({ length: handSize }).map((_, si) => {
                const orderForThisSlot = si * players.length + pi;
                const isSettled = orderForThisSlot < settled;
                return (
                  <div
                    key={si}
                    ref={(el) => {
                      slotRefs.current.set(`${pi}-${si}`, el);
                    }}
                    className="dealing-slot"
                  >
                    {isSettled && <CardView hidden size="md" />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <FlightLayer flights={flights} />
    </div>
  );
}

/**
 * Riffle-style shuffle: two halves of the deck lift up, arc to the side, and
 * meet in the middle, repeatedly. Each card has a phase-shifted loop so the
 * stack reads as cards crossing past each other, not as a single shake.
 */
function ShufflingDeck() {
  const cards = 8;
  return (
    <div className="shuffling-deck" aria-hidden="true">
      {Array.from({ length: cards }).map((_, i) => {
        const side = i % 2 === 0 ? -1 : 1;
        // Stagger each card's loop so the two halves visibly interleave —
        // the eye sees them crossing rather than moving in unison.
        const delay = (i * 0.07) % 0.55;
        return (
          <motion.div
            key={i}
            className="shuffling-card"
            style={{ zIndex: i }}
            animate={{
              x: [0, side * 46, side * 14, 0, side * -8, 0],
              y: [0, -34, -18, -6, -22, 0],
              rotate: [0, side * 18, side * 6, 0, side * -4, 0],
            }}
            transition={{
              duration: 1.05,
              delay,
              repeat: Infinity,
              ease: "easeInOut",
              times: [0, 0.2, 0.42, 0.6, 0.8, 1],
            }}
          />
        );
      })}
    </div>
  );
}
