import { useEffect, useState } from "react";
import { startAudio, startBackgroundMusic } from "../audio/sound.js";
import { ALL_CARD_IMAGE_URLS, preloadCardImages } from "../util/cardAssets.js";
import { HowToPlay } from "./HowToPlay.js";

interface Props {
  onReady: () => void;
}

function gameIdFromHash(): string | null {
  const m = /^#\/game\/([A-Z0-9]+)$/i.exec(window.location.hash);
  return m && m[1] ? m[1] : null;
}

/**
 * First screen the user sees. Browsers require a user gesture before audio,
 * fullscreen, and (on iOS) any sound at all, so the routing fork — create
 * vs. join — is also gated behind the same click that initializes them.
 *
 * Card-face SVGs are preloaded in the background; the action buttons stay
 * disabled until the cache is warm so the deal animation never waits.
 */
export function Splash({ onReady }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const total = ALL_CARD_IMAGE_URLS.length;
  const preloadDone = loaded === total;

  const presetCode = gameIdFromHash();
  const [mode, setMode] = useState<"menu" | "joining">(presetCode ? "joining" : "menu");
  const [joinCode, setJoinCode] = useState<string>(presetCode ?? "");

  useEffect(() => {
    let cancelled = false;
    preloadCardImages((n) => {
      if (!cancelled) setLoaded(n);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function activate(targetGameId: string | null) {
    setBusy(true);
    setError(null);
    try {
      await startAudio();
      startBackgroundMusic();
      // Fullscreen must be requested from the same user gesture; ignore
      // rejection (Safari iOS doesn't support it on document elements).
      try {
        await document.documentElement.requestFullscreen?.();
      } catch {
        /* not supported / user denied — game still runs windowed */
      }
      if (targetGameId) {
        window.location.hash = `#/game/${targetGameId}`;
      } else if (window.location.hash) {
        // Clear any stale hash so a fresh "Create" doesn't accidentally join.
        history.replaceState(null, "", window.location.pathname);
      }
      onReady();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not start audio: ${msg}`);
      setBusy(false);
    }
  }

  const disabled = !preloadDone || busy;
  const hint = busy ? "Starting…" : !preloadDone ? `Loading cards (${loaded}/${total})…` : null;

  return (
    <div className="screen splash">
      <HowToPlay />
      <h1 className="splash-title">
        <img src="/logo.png" alt="Blind Four" className="splash-logo" />
      </h1>

      {mode === "menu" && (
        <div className="splash-actions">
          <button type="button" className="primary big" disabled={disabled} onClick={() => activate(null)}>
            Create game
          </button>
          <button type="button" className="primary big" disabled={disabled} onClick={() => setMode("joining")}>
            Join game
          </button>
        </div>
      )}

      {mode === "joining" && (
        <form
          className="form-block"
          onSubmit={(e) => {
            e.preventDefault();
            const code = joinCode.trim();
            if (!disabled && code.length > 0) activate(code);
          }}
        >
          <label htmlFor="joincode">Game code</label>
          <input
            id="joincode"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            placeholder="e.g. BLIND7"
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="splash-actions row">
            <button type="submit" className="primary big" disabled={disabled || joinCode.trim().length === 0}>
              Join
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setMode("menu");
                setJoinCode("");
                if (window.location.hash) history.replaceState(null, "", window.location.pathname);
              }}
            >
              Back
            </button>
          </div>
        </form>
      )}

      {hint && <p className="muted small-note">{hint}</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
