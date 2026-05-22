import * as Tone from "tone";
import type { AnimationCue } from "../game/cue.js";

/**
 * Synthesized sound effects + ambient background music using Tone.js.
 *
 * The browser requires a user gesture before AudioContext can start, so all
 * synth construction is deferred until `startAudio()` runs (it awaits
 * `Tone.start()` first). Calls to play* functions before audio has been started
 * are no-ops, not errors.
 *
 * No samples — every sound is synthesized from oscillators / noise / envelopes.
 */

interface Voices {
  master: Tone.Gain;
  reverb: Tone.Reverb;
  noise: Tone.NoiseSynth;
  shuffleFilter: Tone.AutoFilter;
  shuffleNoise: Tone.NoiseSynth;
  thump: Tone.MembraneSynth;
  pluck: Tone.PluckSynth;
  bell: Tone.MetalSynth;
  tone: Tone.Synth;
  chord: Tone.PolySynth;
  pad: Tone.PolySynth;
  padReverb: Tone.Reverb;
  padGain: Tone.Gain;
  yourTurn: Tone.Player;
  chooseLock: Tone.Player;
  sad: Tone.MonoSynth;
}

let voices: Voices | null = null;
let started = false;
let bgmLoop: Tone.Loop | null = null;

/**
 * Per-voice last scheduled time. Tone's Source-based synths (NoiseSynth,
 * MetalSynth, …) throw "Start time must be strictly greater than previous
 * start time" if two triggerAttack calls land at the same audio time, which
 * happens easily under React StrictMode double-mounts or rapid retriggers.
 *
 * `nextTime(key)` returns max(now, prev + epsilon) and remembers it, so each
 * voice's start times are strictly monotonic regardless of caller cadence.
 */
const lastTime = new Map<string, number>();
const TIME_EPSILON = 0.02;

function nextTime(key: string): number {
  const now = Tone.now();
  const prev = lastTime.get(key) ?? 0;
  const t = Math.max(now, prev + TIME_EPSILON);
  lastTime.set(key, t);
  return t;
}

export function isAudioStarted(): boolean {
  return started;
}

/** Boots Tone.js (requires user gesture) and constructs all voices once. */
export async function startAudio(): Promise<void> {
  if (started) return;
  await Tone.start();

  const master = new Tone.Gain(0.85).toDestination();
  const reverb = new Tone.Reverb({ decay: 2.2, wet: 0.18 }).connect(master);

  // ── shuffle: noise pushed through an auto-sweeping bandpass for "riffle"
  const shuffleFilter = new Tone.AutoFilter({
    frequency: "8n",
    baseFrequency: 600,
    octaves: 3,
    depth: 1,
    filter: { type: "bandpass", Q: 2, rolloff: -12 },
  })
    .connect(reverb)
    .start();
  const shuffleNoise = new Tone.NoiseSynth({
    noise: { type: "pink" },
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.3, release: 0.2 },
    volume: -18,
  }).connect(shuffleFilter);

  // ── deal: short noise tick
  const noise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 },
    volume: -22,
  }).connect(reverb);

  // ── discard/replace thump
  const thump = new Tone.MembraneSynth({
    pitchDecay: 0.04,
    octaves: 4,
    envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.18 },
    volume: -14,
  }).connect(reverb);

  // ── draw / peek pluck
  const pluck = new Tone.PluckSynth({
    attackNoise: 0.7,
    dampening: 3800,
    resonance: 0.7,
    volume: -10,
  }).connect(reverb);

  // ── lock chime (metallic)
  const bell = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.4, release: 0.4 },
    harmonicity: 5.1,
    modulationIndex: 18,
    resonance: 3200,
    octaves: 1.2,
    volume: -28,
  }).connect(reverb);

  // ── general tonal voice (swap, ui)
  const tone = new Tone.Synth({
    oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.12, sustain: 0.04, release: 0.18 },
    volume: -16,
  }).connect(reverb);

  // ── chord stab (showdown, win)
  const chord = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.01, decay: 0.35, sustain: 0.1, release: 0.6 },
    volume: -20,
  }).connect(reverb);

  // ── ambient pad (background music) — its own deeper reverb + low gain
  const padGain = new Tone.Gain(0.5).connect(master);
  const padReverb = new Tone.Reverb({ decay: 8, wet: 0.7 }).connect(padGain);
  const pad = new Tone.PolySynth(Tone.AMSynth, {
    harmonicity: 1.5,
    oscillator: { type: "sine" },
    envelope: { attack: 1.2, decay: 0.6, sustain: 0.6, release: 4 },
    modulation: { type: "triangle" },
    modulationEnvelope: { attack: 1.6, decay: 0.4, sustain: 0.7, release: 3 },
    volume: -22,
  }).connect(padReverb);

  // ── sampled "your turn" cue (bypasses reverb so the spoken cue stays crisp)
  const yourTurn = new Tone.Player({ url: "/your-turn.mp3", volume: -4 }).connect(master);

  // ── spoken nag urging the player to pick a card for the lock power
  const chooseLock = new Tone.Player({ url: "/choose-card-to-lock.mp3", volume: -2 }).connect(master);

  // ── sad trombone: brassy sawtooth through a lowpass + portamento so notes
  // glide into each other (the slide is what makes "wah-wah-waaah" register
  // as a trombone rather than a series of bell pings). Extra reverb tail to
  // exaggerate the dejected, drawn-out feel.
  const sad = new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    filter: { Q: 2.4, type: "lowpass", rolloff: -24 },
    filterEnvelope: {
      attack: 0.04,
      decay: 0.35,
      sustain: 0.45,
      release: 0.8,
      baseFrequency: 220,
      octaves: 2.2,
    },
    envelope: {
      attack: 0.05,
      decay: 0.2,
      sustain: 0.85,
      release: 0.7,
    },
    portamento: 0.12,
    volume: -10,
  }).connect(reverb);

  voices = {
    master,
    reverb,
    noise,
    shuffleFilter,
    shuffleNoise,
    thump,
    pluck,
    bell,
    tone,
    chord,
    pad,
    padReverb,
    padGain,
    yourTurn,
    chooseLock,
    sad,
  };
  // Wait for sampled buffers (yourTurn) to finish loading before reporting ready,
  // so the first turn-start fires audibly instead of being silently dropped.
  await Tone.loaded();
  started = true;
}

// ──────────────────── SFX ────────────────────

export function playShuffle(): void {
  if (!voices) return;
  voices.shuffleNoise.triggerAttackRelease(0.75, nextTime("shuffle"));
}

export function playDeal(): void {
  if (!voices) return;
  voices.noise.triggerAttackRelease("32n", nextTime("deal-noise"));
  voices.tone.triggerAttackRelease("A5", "64n", nextTime("tone"), 0.4);
}

export function playDraw(): void {
  if (!voices) return;
  voices.pluck.triggerAttackRelease("D4", "8n", nextTime("pluck"));
}

export function playDiscard(): void {
  if (!voices) return;
  voices.thump.triggerAttackRelease("C2", "16n", nextTime("thump"));
}

export function playReplace(): void {
  if (!voices) return;
  voices.thump.triggerAttackRelease("E2", "16n", nextTime("thump"));
  voices.tone.triggerAttackRelease("E5", "32n", nextTime("tone"), 0.5);
}

export function playSwap(): void {
  if (!voices) return;
  const t0 = nextTime("tone");
  voices.tone.triggerAttackRelease("G4", "16n", t0, 0.7);
  voices.tone.triggerAttackRelease("C5", "16n", nextTime("tone"), 0.7);
  // The second pair lands ~140 ms later for the "crossing" feel.
  voices.tone.triggerAttackRelease("E5", "16n", t0 + 0.18, 0.6);
  voices.tone.triggerAttackRelease("A4", "16n", t0 + 0.22, 0.6);
  lastTime.set("tone", t0 + 0.22);
}

export function playLock(): void {
  if (!voices) return;
  voices.bell.triggerAttackRelease("C6", "8n", nextTime("bell"));
}

export function playPeek(): void {
  if (!voices) return;
  const t0 = nextTime("pluck");
  voices.pluck.triggerAttackRelease("E5", "8n", t0);
  voices.pluck.triggerAttackRelease("A5", "8n", t0 + 0.08);
  voices.pluck.triggerAttackRelease("D6", "8n", t0 + 0.16);
  lastTime.set("pluck", t0 + 0.16);
}

export function playShowdown(): void {
  if (!voices) return;
  voices.chord.triggerAttackRelease(["A3", "C4", "E4"], "2n", nextTime("chord"));
}

export function playWin(): void {
  if (!voices) return;
  const t0 = nextTime("chord");
  voices.chord.triggerAttackRelease(["C4", "E4", "G4"], "4n", t0);
  voices.chord.triggerAttackRelease(["E4", "G4", "B4"], "4n", t0 + 0.25);
  voices.chord.triggerAttackRelease(["G4", "B4", "D5", "G5"], "2n", t0 + 0.5);
  lastTime.set("chord", t0 + 0.5);
}

export function playButton(): void {
  if (!voices) return;
  voices.tone.triggerAttackRelease("C5", "32n", nextTime("tone"), 0.4);
}

/**
 * Classic "wah-wah-waaaaah" sad trombone. Two short hits, then a held final
 * note that sags down a tritone via portamento — the bend is what sells the
 * dejection, vs. discrete notes which read as chime/bell.
 */
export function playSadTrombone(): void {
  if (!voices) return;
  const s = voices.sad;
  const t0 = nextTime("sad");
  // "wah"
  s.triggerAttack("G4", t0, 0.9);
  s.triggerRelease(t0 + 0.22);
  // "wah"
  s.triggerAttack("F4", t0 + 0.34, 0.85);
  s.triggerRelease(t0 + 0.56);
  // "waaaaaaaaah" — held while the pitch slumps down two more half-steps,
  // then deflates an extra step before release.
  s.triggerAttack("Eb4", t0 + 0.7, 0.8);
  s.setNote("D4", t0 + 1.1);
  s.setNote("B3", t0 + 1.55);
  s.triggerRelease(t0 + 1.95);
  lastTime.set("sad", t0 + 1.95);
}

/** Plays the clip and returns its duration in milliseconds (0 if not loaded
 *  or already playing). Callers schedule their next nag relative to the
 *  returned end time so prompts don't talk over each other. */
export function playYourTurn(): number {
  if (!voices || !voices.yourTurn.loaded) return 0;
  if (voices.yourTurn.state === "started") return 0;
  voices.yourTurn.start();
  return voices.yourTurn.buffer.duration * 1000;
}

/** Plays the clip and returns its duration in milliseconds (0 if not loaded
 *  or already playing). Callers schedule their next nag relative to the
 *  returned end time so prompts don't talk over each other. */
export function playChooseLock(): number {
  if (!voices || !voices.chooseLock.loaded) return 0;
  if (voices.chooseLock.state === "started") return 0;
  voices.chooseLock.start();
  return voices.chooseLock.buffer.duration * 1000;
}

// ──────────────────── Background music ────────────────────

/** Slow ambient pad loop — a 4-chord progression in A minor, very faint. */
export function startBackgroundMusic(): void {
  if (!voices || bgmLoop) return;
  const pad = voices.pad;
  const progression: string[][] = [
    ["A2", "C3", "E3", "G3"],
    ["F2", "A2", "C3", "E3"],
    ["D2", "F2", "A2", "C3"],
    ["E2", "G2", "B2", "D3"],
  ];
  let step = 0;
  bgmLoop = new Tone.Loop((time) => {
    const idx = step % progression.length;
    const chordNotes = progression[idx];
    if (chordNotes) pad.triggerAttackRelease(chordNotes, "1m", time);
    step += 1;
  }, "1m").start(0);

  if (Tone.getTransport().state !== "started") {
    Tone.getTransport().bpm.value = 60;
    Tone.getTransport().start();
  }
}

export function stopBackgroundMusic(): void {
  if (bgmLoop) {
    bgmLoop.stop();
    bgmLoop.dispose();
    bgmLoop = null;
  }
}

// ──────────────────── Cue dispatch ────────────────────

/** Play the SFX appropriate to a freshly-fired animation cue. */
export function playForCue(cue: AnimationCue): void {
  if (!cue) return;
  switch (cue.kind) {
    case "draw":
      playDraw();
      return;
    case "discard":
      playDiscard();
      return;
    case "replace":
      playReplace();
      return;
    case "shuffle":
      playShuffle();
      return;
    case "swap":
      playSwap();
      return;
    case "lock":
      playLock();
      return;
  }
}
