import { useState } from "react";
import type { BasePowerAction, PowerAction, Rank, VisibleGameState } from "../../../engine/types.js";
import { HAND_SIZE } from "../../../engine/types.js";
import type { RemoteEngine } from "../net/useRemoteEngine.js";
import { CardView } from "./CardView.js";
import { tiltForSlot } from "../util/rand.js";

interface Props {
  remote: RemoteEngine;
}

type Stage =
  | { kind: "pick-joker-rank" }
  | { kind: "power"; rank: "10" | "J" | "Q" | "K"; wrap: (a: BasePowerAction) => PowerAction };

const POWER_LABEL: Record<"10" | "J" | "Q" | "K", string> = {
  "10": "Peek",
  J: "Shuffle",
  Q: "Swap",
  K: "Lock",
};

export function PowerView({ remote }: Props) {
  const { identity, visibleState, dispatch, lastError } = remote;
  if (!identity || !visibleState) return null;
  const visible = visibleState;
  const playerId = identity.playerId;
  const discardTop = visible.discardPile.at(-1);
  const topRank: Rank | undefined = discardTop?.rank;

  const [stage, setStage] = useState<Stage>(() => {
    if (topRank === "JOKER") return { kind: "pick-joker-rank" };
    if (topRank === "10" || topRank === "J" || topRank === "Q" || topRank === "K") {
      return { kind: "power", rank: topRank, wrap: (a) => a };
    }
    return { kind: "power", rank: "10", wrap: (a) => a };
  });

  function submit(action: BasePowerAction, wrap: (a: BasePowerAction) => PowerAction) {
    dispatch("USE_POWER", wrap(action));
    // Peek result is delivered via the next STATE push (peekResult field).
    // TurnView observes that and shows the peek dialog.
  }

  if (stage.kind === "pick-joker-rank") {
    return (
      <section className="power">
        <h3>Joker — pick a power to mimic</h3>
        <div className="power-rank-picker">
          {(["10", "J", "Q", "K"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className="primary"
              onClick={() =>
                setStage({
                  kind: "power",
                  rank: r,
                  wrap: (a) => {
                    if (r === "10" && a.power === "peek") return { power: "joker", mimicRank: r, action: a };
                    if (r === "J" && a.power === "shuffle") return { power: "joker", mimicRank: r, action: a };
                    if (r === "Q" && a.power === "swap") return { power: "joker", mimicRank: r, action: a };
                    if (r === "K" && a.power === "lock") return { power: "joker", mimicRank: r, action: a };
                    throw new Error("Joker wrap mismatch");
                  },
                })
              }
            >
              {r} — {POWER_LABEL[r]}
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="power">
      <h3>
        Resolve power: {stage.rank} ({POWER_LABEL[stage.rank]})
      </h3>
      {stage.rank === "10" && <PeekForm visible={visible} playerId={playerId} onSubmit={(a) => submit(a, stage.wrap)} />}
      {stage.rank === "J" && <ShuffleForm visible={visible} playerId={playerId} onSubmit={(a) => submit(a, stage.wrap)} />}
      {stage.rank === "Q" && <SwapForm visible={visible} onSubmit={(a) => submit(a, stage.wrap)} />}
      {stage.rank === "K" && <LockForm visible={visible} onSubmit={(a) => submit(a, stage.wrap)} />}
      {lastError && <div className="error">{lastError}</div>}
    </section>
  );
}

// ────────────────────────────── Peek ──────────────────────────────

function PeekForm({
  visible,
  playerId,
  onSubmit,
}: {
  visible: VisibleGameState;
  playerId: string;
  onSubmit: (a: BasePowerAction & { power: "peek" }) => void;
}) {
  const [mode, setMode] = useState<"choose" | "opponent">("choose");
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const opponents = visible.players.filter((p) => p.id !== playerId);

  if (mode === "choose") {
    return (
      <div className="power-form">
        <p className="muted">Peek your own four cards, or one opponent card.</p>
        <div className="power-actions">
          <button type="button" className="primary" onClick={() => onSubmit({ power: "peek", target: "own" })}>
            Peek my hand
          </button>
          <button type="button" className="ghost" onClick={() => setMode("opponent")}>
            Peek an opponent
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="power-form">
      <p className="muted">Choose an opponent, then tap a card to peek.</p>
      <PlayerPicker label="Opponent" players={opponents} value={opponentId} onChange={setOpponentId} />
      {opponentId && (
        <CardSlotPicker
          visible={visible}
          targetPlayerId={opponentId}
          onPick={(cardIndex) => onSubmit({ power: "peek", target: "opponent", opponentId, opponentCardIndex: cardIndex })}
        />
      )}
      <button type="button" className="ghost small" onClick={() => setMode("choose")}>
        Back
      </button>
    </div>
  );
}

// ────────────────────────────── Shuffle ──────────────────────────────

function ShuffleForm({
  visible,
  playerId,
  onSubmit,
}: {
  visible: VisibleGameState;
  playerId: string;
  onSubmit: (a: BasePowerAction & { power: "shuffle" }) => void;
}) {
  const [targetPlayerId, setTargetPlayerId] = useState<string | null>(null);
  const opponents = visible.players.filter((p) => p.id !== playerId);
  return (
    <div className="power-form">
      <p className="muted">Shuffle an opponent&rsquo;s unlocked card positions. Locked positions stay put.</p>
      <PlayerPicker label="Target" players={opponents} value={targetPlayerId} onChange={setTargetPlayerId} />
      <button
        type="button"
        className="primary"
        disabled={!targetPlayerId}
        onClick={() => {
          if (targetPlayerId) onSubmit({ power: "shuffle", targetPlayerId });
        }}
      >
        Shuffle
      </button>
    </div>
  );
}

// ────────────────────────────── Swap ──────────────────────────────

function SwapForm({
  visible,
  onSubmit,
}: {
  visible: VisibleGameState;
  onSubmit: (a: BasePowerAction & { power: "swap" }) => void;
}) {
  const [a, setA] = useState<{ playerId: string | null; cardIndex: number | null }>({ playerId: null, cardIndex: null });
  const [b, setB] = useState<{ playerId: string | null; cardIndex: number | null }>({ playerId: null, cardIndex: null });

  const samePlayer = a.playerId !== null && a.playerId === b.playerId;
  const ready = a.playerId && b.playerId && a.cardIndex !== null && b.cardIndex !== null && !samePlayer;

  function submit() {
    if (!ready || !a.playerId || !b.playerId || a.cardIndex === null || b.cardIndex === null) return;
    onSubmit({
      power: "swap",
      sourcePlayerId: a.playerId,
      sourceCardIndex: a.cardIndex,
      targetPlayerId: b.playerId,
      targetCardIndex: b.cardIndex,
    });
  }

  return (
    <div className="power-form">
      <p className="muted">Swap one card between two different players. Locked cards cannot swap.</p>
      <div className="swap-row">
        <SwapSide label="Player A" visible={visible} value={a} onChange={setA} />
        <SwapSide label="Player B" visible={visible} value={b} onChange={setB} />
      </div>
      {samePlayer && <div className="error">Swap requires two different players.</div>}
      <button type="button" className="primary" disabled={!ready} onClick={submit}>
        Swap
      </button>
    </div>
  );
}

function SwapSide({
  label,
  visible,
  value,
  onChange,
}: {
  label: string;
  visible: VisibleGameState;
  value: { playerId: string | null; cardIndex: number | null };
  onChange: (v: { playerId: string | null; cardIndex: number | null }) => void;
}) {
  return (
    <div className="swap-side">
      <PlayerPicker
        label={label}
        players={visible.players}
        value={value.playerId}
        onChange={(playerId) => onChange({ playerId, cardIndex: null })}
      />
      {value.playerId && (
        <CardSlotPicker
          visible={visible}
          targetPlayerId={value.playerId}
          selectedIndex={value.cardIndex}
          onPick={(cardIndex) => onChange({ ...value, cardIndex })}
          disableLocked
        />
      )}
    </div>
  );
}

// ────────────────────────────── Lock ──────────────────────────────

function LockForm({
  visible,
  onSubmit,
}: {
  visible: VisibleGameState;
  onSubmit: (a: BasePowerAction & { power: "lock" }) => void;
}) {
  const [targetPlayerId, setTargetPlayerId] = useState<string | null>(null);
  return (
    <div className="power-form">
      <p className="muted">Lock a card. Locked cards cannot be replaced or swapped.</p>
      <PlayerPicker label="Target" players={visible.players} value={targetPlayerId} onChange={setTargetPlayerId} />
      {targetPlayerId && (
        <CardSlotPicker
          visible={visible}
          targetPlayerId={targetPlayerId}
          onPick={(cardIndex) => onSubmit({ power: "lock", targetPlayerId, cardIndex })}
          disableLocked
        />
      )}
    </div>
  );
}

// ────────────────────────────── Shared pickers ──────────────────────────────

function PlayerPicker({
  label,
  players,
  value,
  onChange,
}: {
  label: string;
  players: VisibleGameState["players"];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <div className="player-picker">
      <span className="muted">{label}:</span>
      <div className="player-picker-row">
        {players.map((p) => (
          <button key={p.id} type="button" className={value === p.id ? "primary" : "ghost"} onClick={() => onChange(p.id)}>
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function CardSlotPicker({
  visible,
  targetPlayerId,
  selectedIndex,
  onPick,
  disableLocked,
}: {
  visible: VisibleGameState;
  targetPlayerId: string;
  selectedIndex?: number | null;
  onPick: (cardIndex: number) => void;
  disableLocked?: boolean;
}) {
  const target = visible.players.find((p) => p.id === targetPlayerId);
  if (!target) return null;
  const markers = new Map(target.lockedCards.map((lc) => [lc.index, lc.markerCard]));
  return (
    <div className="slot-picker">
      {Array.from({ length: HAND_SIZE }).map((_, i) => {
        const marker = markers.get(i);
        const disabled = disableLocked && !!marker;
        const selected = selectedIndex === i;
        return (
          <button
            key={i}
            type="button"
            className={selected ? "slot-btn slot-selected" : "slot-btn"}
            disabled={disabled}
            onClick={() => onPick(i)}
          >
            <CardView hidden lockMarker={marker} label={`#${i + 1}`} size="md" tilt={tiltForSlot(targetPlayerId, i)} />
          </button>
        );
      })}
    </div>
  );
}
