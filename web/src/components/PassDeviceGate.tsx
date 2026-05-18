interface Props {
  playerName: string;
  /** Short message shown above the player name (e.g. "Initial reveal", "Your turn"). */
  context: string;
  onReady: () => void;
}

export function PassDeviceGate({ playerName, context, onReady }: Props) {
  return (
    <div className="screen gate">
      <p className="gate-context">{context}</p>
      <h2 className="gate-name">Pass to {playerName}</h2>
      <p className="muted">Make sure no one else can see the screen before continuing.</p>
      <button type="button" className="primary big" onClick={onReady}>
        I&rsquo;m {playerName} — show me
      </button>
    </div>
  );
}
