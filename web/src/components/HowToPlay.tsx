import { useState } from "react";
import { Dialog } from "./Dialog.js";
import { playButton, startAudio } from "../audio/sound.js";

function clickSound(): void {
  void startAudio().then(playButton);
}

/**
 * Floating "?" button (top-right) that opens a how-to-play dialog.
 * Mount on pre-game screens (splash, join-code entry, name prompt).
 */
export function HowToPlay() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="how-to-play-btn"
        aria-label="How to play"
        onClick={() => {
          clickSound();
          setOpen(true);
        }}
      >
        <span className="how-to-play-btn__icon" aria-hidden="true">
          ?
        </span>
        <span className="how-to-play-btn__label">How to play</span>
      </button>
      <Dialog open={open} dismissable>
        <div className="how-to-play-dialog">
          <h2>How to play</h2>
          <div className="how-to-play-body">
            <p className="how-to-play-tagline">Memory + bluff card game for 2–6 players. Lowest total hand wins.</p>

            <section>
              <h3>The goal</h3>
              <p>
                Each player is dealt four face-down cards. You peek at them once at the start, then they stay hidden — even
                from you. End the round with the lowest total to win.
              </p>
            </section>

            <section>
              <h3>Card values</h3>
              <ul className="how-to-play-values">
                <li>
                  <span>A</span> 1
                </li>
                <li>
                  <span>2–6</span> face value
                </li>
                <li>
                  <span>7</span> 0
                </li>
                <li>
                  <span>8–10</span> face value
                </li>
                <li>
                  <span>J</span> 11
                </li>
                <li>
                  <span>Q</span> 12
                </li>
                <li>
                  <span>K</span> 13
                </li>
                <li>
                  <span>Joker</span> 20
                </li>
              </ul>
            </section>

            <section>
              <h3>Your turn</h3>
              <ol>
                <li>
                  <strong>Draw</strong> the top card of the deck (private) or the top of the discard pile (public).
                </li>
                <li>
                  <strong>Decide.</strong> If drawn from the deck, either replace one of your hand cards (the displaced
                  card goes to discard) or discard the drawn card directly. If drawn from the discard, you must replace a
                  hand card.
                </li>
                <li>
                  Any card that lands on the discard pile may trigger a <strong>power</strong> — see below.
                </li>
              </ol>
              <p className="how-to-play-note">
                Locked cards can&apos;t be replaced or swapped. A card drawn straight from the discard pile doesn&apos;t
                trigger its power.
              </p>
            </section>

            <section>
              <h3>Powers (on discard)</h3>
              <ul className="how-to-play-powers">
                <li>
                  <strong>10 — Peek.</strong> View all four of your own cards, or one chosen opponent card.
                </li>
                <li>
                  <strong>J — Shuffle.</strong> Randomly shuffle another player&apos;s unlocked card positions. Cards stay
                  hidden.
                </li>
                <li>
                  <strong>Q — Swap.</strong> Swap one unlocked card between two different players (you can be one of them).
                </li>
                <li>
                  <strong>K — Lock.</strong> Lock any one card (yours or an opponent&apos;s). The King flips face-up as a
                  lock marker and leaves play.
                </li>
                <li>
                  <strong>Joker — Wild.</strong> Mimics any power above. Still scores 20 if it stays in your hand.
                </li>
              </ul>
            </section>

            <section>
              <h3>Calling showdown</h3>
              <p>
                Once every player has taken at least 2 turns, you may call <strong>showdown</strong> at the end of your
                turn instead of passing. Everyone else gets one final turn, then all hands are revealed.
              </p>
              <p>
                The caller wins only with the <em>strictly</em> lowest total. Tie the caller and the caller loses — the
                tied non-caller(s) win.
              </p>
            </section>
          </div>
          <div className="how-to-play-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                clickSound();
                setOpen(false);
              }}
            >
              Got it
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
