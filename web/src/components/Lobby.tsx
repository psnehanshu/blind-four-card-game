import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MAX_PLAYERS, MIN_PLAYERS } from "../../../engine/types.js";
import { send } from "../net/socket.js";
import type { RemoteEngine } from "../net/useRemoteEngine.js";

interface Props {
  remote: RemoteEngine;
}

const SEAT_COLORS = ["#3d8bff", "#5cd99a", "#f5c542", "#ff8a8a", "#c084fc", "#22d3ee"];
const INVITE_MESSAGE = "Join my Blind Four game";

type ShareState = "idle" | "shared" | "copied" | "failed";

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function Lobby({ remote }: Props) {
  const { identity, lobby } = remote;
  const [shareState, setShareState] = useState<ShareState>("idle");

  if (!identity) return null;

  const isHost = identity.playerId === identity.hostPlayerId;
  const players = lobby?.players ?? [];
  const canStart = isHost && players.length >= MIN_PLAYERS;
  const inviteUrl = typeof window === "undefined" ? "" : `${window.location.origin}/#/game/${identity.gameId}`;
  // Show one dashed placeholder seat when below the minimum to make the "needs
  // more players" state obvious, and one when above the minimum to hint that
  // there's room for another invite. None once the table is full.
  const placeholders = Math.max(MIN_PLAYERS - players.length, players.length < MAX_PLAYERS ? 1 : 0);

  const gameId = identity.gameId;

  function start() {
    send({ kind: "START_GAME", gameId });
  }

  async function share() {
    const clipboardMessage = `${INVITE_MESSAGE}: ${inviteUrl}`;
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ title: "Blind Four", text: INVITE_MESSAGE, url: inviteUrl });
        setShareState("shared");
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(clipboardMessage);
        setShareState("copied");
      } else {
        setShareState("failed");
      }
    } catch {
      // User dismissed the share sheet, or clipboard was blocked — reset
      // silently so the button stays clickable.
      setShareState("idle");
      return;
    }
    window.setTimeout(() => setShareState("idle"), 2200);
  }

  const shareLabel =
    shareState === "shared"
      ? "Shared!"
      : shareState === "copied"
        ? "Link copied!"
        : shareState === "failed"
          ? "Sharing not supported"
          : "Share invite";

  return (
    <div className="screen lobby">
      <h1 className="splash-title">
        <img src="/logo.png" alt="Blind Four" className="splash-logo lobby-logo" />
      </h1>

      <section className="game-code-display lobby-code">
        <span className="muted small-note">Game code</span>
        <span className="game-code">{identity.gameId}</span>
      </section>

      {isHost && (
        <div className="lobby-share">
          <button type="button" className="primary big share-btn" onClick={share}>
            <span className="share-icon" aria-hidden="true">
              ↗
            </span>
            {shareLabel}
          </button>
          <p className="muted small-note">Sends &ldquo;{INVITE_MESSAGE}&rdquo; with the invite link.</p>
        </div>
      )}

      <section className="lobby-players">
        <h2>
          Players{" "}
          <span className="muted lobby-count">
            ({players.length}/{MAX_PLAYERS})
          </span>
        </h2>
        <ul className="lobby-seats">
          <AnimatePresence initial={false}>
            {players.map((p, i) => {
              const color = SEAT_COLORS[i % SEAT_COLORS.length] ?? SEAT_COLORS[0];
              const isYou = p.playerId === identity.playerId;
              const isHostSeat = p.playerId === identity.hostPlayerId;
              return (
                <motion.li
                  key={p.playerId}
                  layout
                  initial={{ opacity: 0, y: 10, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 320, damping: 26 }}
                  className="lobby-seat filled"
                >
                  <span className="seat-avatar" style={{ background: color }}>
                    {initials(p.displayName)}
                  </span>
                  <span className="seat-name">
                    {p.displayName}
                    {isYou && <span className="muted seat-you"> (you)</span>}
                  </span>
                  {isHostSeat && <span className="badge caller">HOST</span>}
                </motion.li>
              );
            })}
            {Array.from({ length: placeholders }, (_, i) => (
              <motion.li
                key={`empty-${i}`}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="lobby-seat empty"
              >
                <span className="seat-avatar seat-avatar-empty">?</span>
                <span className="seat-name muted">Waiting for a player…</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </section>

      {remote.lastError && <div className="error">{remote.lastError}</div>}

      {isHost ? (
        <button type="button" className="primary big" disabled={!canStart} onClick={start}>
          {canStart ? "Start game" : `Waiting for ${MIN_PLAYERS - players.length} more player(s)`}
        </button>
      ) : (
        <p className="muted">Waiting for the host to start the game…</p>
      )}
    </div>
  );
}
