import { useState } from "react";
import { startAudio, startBackgroundMusic } from "../audio/sound.js";

interface Props {
  onReady: () => void;
}

/**
 * First screen the user sees. Booting the AudioContext requires a user gesture
 * (browser policy), so the Start button awaits `Tone.start()` before handing
 * control to the lobby. Also kicks off the ambient background loop.
 */
export function Splash({ onReady }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await startAudio();
      startBackgroundMusic();
      onReady();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not start audio: ${msg}`);
      setBusy(false);
    }
  }

  return (
    <div className="screen splash">
      <h1>Blind Four</h1>
      <p className="muted">Hot-seat card game with synthesized sound.</p>
      <button type="button" className="primary big" onClick={start} disabled={busy}>
        {busy ? "Starting…" : "Start"}
      </button>
      {error && <div className="error">{error}</div>}
      <p className="muted small-note">Tap to enable audio. The browser requires a gesture before any sound can play.</p>
    </div>
  );
}
