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
type CopyState = "idle" | "copied" | "failed";

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
  const [copyState, setCopyState] = useState<CopyState>("idle");

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

  async function copyCode() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(gameId);
        setCopyState("copied");
      } else {
        setCopyState("failed");
      }
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  const copyAriaLabel =
    copyState === "copied" ? "Game code copied" : copyState === "failed" ? "Copy failed" : "Copy game code";

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
        <div className="game-code-row">
          <span className="game-code">{identity.gameId}</span>
          <button
            type="button"
            className="ghost small game-code-copy"
            onClick={copyCode}
            aria-label={copyAriaLabel}
            data-state={copyState}
          >
            {copyState === "copied" ? (
              <svg className="copy-icon" viewBox="0 0 20 20" width="28" height="28" aria-hidden="true" focusable="false">
                <path
                  d="M4 10.5l4 4 8-9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg
                className="copy-icon"
                viewBox="0 0 640 640"
                width="28"
                height="28"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  fill="currentColor"
                  d="M480 400L288 400C279.2 400 272 392.8 272 384L272 128C272 119.2 279.2 112 288 112L421.5 112C425.7 112 429.8 113.7 432.8 116.7L491.3 175.2C494.3 178.2 496 182.3 496 186.5L496 384C496 392.8 488.8 400 480 400zM288 448L480 448C515.3 448 544 419.3 544 384L544 186.5C544 169.5 537.3 153.2 525.3 141.2L466.7 82.7C454.7 70.7 438.5 64 421.5 64L288 64C252.7 64 224 92.7 224 128L224 384C224 419.3 252.7 448 288 448zM160 192C124.7 192 96 220.7 96 256L96 512C96 547.3 124.7 576 160 576L352 576C387.3 576 416 547.3 416 512L416 496L368 496L368 512C368 520.8 360.8 528 352 528L160 528C151.2 528 144 520.8 144 512L144 256C144 247.2 151.2 240 160 240L176 240L176 192L160 192z"
                />
              </svg>
            )}
          </button>
        </div>
      </section>

      {isHost && (
        <div className="lobby-share">
          <button type="button" className="primary big share-btn" onClick={share}>
            <span className="share-icon" aria-hidden="true">
              ↗
            </span>
            {shareLabel}
          </button>
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
