import { useEffect, useState } from "react";
import { startAudio, startBackgroundMusic } from "../audio/sound.js";
import { ALL_CARD_IMAGE_URLS, preloadCardImages } from "../util/cardAssets.js";

interface Props {
  onReady: () => void;
}

/**
 * First screen the user sees. Booting the AudioContext requires a user gesture
 * (browser policy), so the Start button awaits `Tone.start()` before handing
 * control to the lobby. Also kicks off the ambient background loop.
 *
 * While the user is reading the splash we warm the browser cache for every
 * card-face SVG — by the time they reach the deal animation the assets are
 * already on disk and render without a flicker.
 */
export function Splash({ onReady }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const total = ALL_CARD_IMAGE_URLS.length;
  const preloadDone = loaded === total;

  useEffect(() => {
    let cancelled = false;
    preloadCardImages((n) => {
      if (!cancelled) setLoaded(n);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function start() {
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
      onReady();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not start audio: ${msg}`);
      setBusy(false);
    }
  }

  const buttonLabel = busy ? "Starting…" : preloadDone ? "Start" : `Loading cards (${loaded}/${total})…`;

  return (
    <div className="screen splash">
      <h1>Blind Four</h1>
      <p className="muted">Hot-seat card game with synthesized sound.</p>
      <button type="button" className="primary big" onClick={start} disabled={busy || !preloadDone}>
        {buttonLabel}
      </button>
      {error && <div className="error">{error}</div>}
      <p className="muted small-note">Tap to enable audio. The browser requires a gesture before any sound can play.</p>
    </div>
  );
}
