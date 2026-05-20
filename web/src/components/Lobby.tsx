import { MIN_PLAYERS } from "../../../engine/types.js";
import { send } from "../net/socket.js";
import type { RemoteEngine } from "../net/useRemoteEngine.js";

interface Props {
  remote: RemoteEngine;
}

export function Lobby({ remote }: Props) {
  const { identity, lobby } = remote;
  if (!identity) return null;

  const isHost = identity.playerId === identity.hostPlayerId;
  const players = lobby?.players ?? [];
  const canStart = isHost && players.length >= MIN_PLAYERS;

  function start() {
    if (!identity) return;
    send({ kind: "START_GAME", gameId: identity.gameId });
  }

  const inviteUrl = typeof window === "undefined" ? "" : `${window.location.origin}/#/game/${identity.gameId}`;

  return (
    <div className="screen lobby">
      <h1>Blind Four</h1>
      <p className="muted">Game code: {identity.gameId}</p>

      {isHost && (
        <section className="form-block">
          <label htmlFor="invite">Invite link</label>
          <input id="invite" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
          <p className="muted small-note">Share this URL — others open it to join.</p>
        </section>
      )}

      <section className="form-block">
        <h2>Players ({players.length})</h2>
        <ul className="player-list">
          {players.map((p) => (
            <li key={p.playerId}>
              <span>
                {p.displayName}
                {p.playerId === identity.playerId && <span className="muted"> (you)</span>}
                {p.playerId === identity.hostPlayerId && <span className="badge caller">HOST</span>}
              </span>
            </li>
          ))}
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
