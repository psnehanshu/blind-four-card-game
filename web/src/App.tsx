import { useEffect, useState } from "react";
import { Lobby } from "./components/Lobby.js";
import { GameShell } from "./components/GameShell.js";
import { Splash } from "./components/Splash.js";
import { useRemoteEngine } from "./net/useRemoteEngine.js";

/** Parses `#/game/<id>` out of the hash. Returns null if not present. */
function gameIdFromHash(): string | null {
  const h = window.location.hash;
  const m = /^#\/game\/([A-Z0-9]+)$/i.exec(h);
  return m && m[1] ? m[1] : null;
}

const DISPLAY_NAME_KEY = "blind-four:displayName";

function loadStoredName(): string {
  try {
    return window.localStorage.getItem(DISPLAY_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeName(name: string): void {
  try {
    window.localStorage.setItem(DISPLAY_NAME_KEY, name);
  } catch {
    // localStorage may be disabled; auto-fill simply won't carry across sessions.
  }
}

type Phase = { kind: "splash" } | { kind: "name" } | { kind: "active" };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "splash" });
  const [pendingName, setPendingName] = useState<string>("");
  const [joinTarget, setJoinTarget] = useState<string | null>(null);
  const [resumeToken, setResumeToken] = useState<string | null>(null);

  // On splash exit, decide whether we're creating or joining based on the URL.
  function onSplashReady() {
    const gid = gameIdFromHash();
    if (gid) {
      const stored = window.localStorage.getItem(`blind-four:${gid}`);
      if (stored) {
        setResumeToken(stored);
        setJoinTarget(gid);
        // We have a token — try to resume silently without a name prompt.
        setPendingName(""); // server ignores name on token resume
        setPhase({ kind: "active" });
        return;
      }
      setJoinTarget(gid);
    }
    setPhase({ kind: "name" });
  }

  if (phase.kind === "splash") {
    return <Splash onReady={onSplashReady} />;
  }
  if (phase.kind === "name") {
    return (
      <NamePrompt
        joinTarget={joinTarget}
        onSubmit={(name) => {
          storeName(name);
          setPendingName(name);
          setPhase({ kind: "active" });
        }}
      />
    );
  }
  return <ActiveSession displayName={pendingName} joinTarget={joinTarget} resumeToken={resumeToken} />;
}

function NamePrompt({ joinTarget, onSubmit }: { joinTarget: string | null; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(loadStoredName);
  const trimmed = name.trim();
  return (
    <form
      className="screen lobby"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed.length > 0) onSubmit(trimmed);
      }}
    >
      <h1>Blind Four</h1>
      <p className="muted">{joinTarget ? `Joining game ${joinTarget}` : "Create a new game"}</p>
      <section className="form-block">
        <label htmlFor="name">Your name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alice" autoFocus />
      </section>
      <button type="submit" className="primary big" disabled={trimmed.length === 0}>
        {joinTarget ? "Join game" : "Create game"}
      </button>
    </form>
  );
}

function ActiveSession({
  displayName,
  joinTarget,
  resumeToken,
}: {
  displayName: string;
  joinTarget: string | null;
  resumeToken: string | null;
}) {
  const initial: Parameters<typeof useRemoteEngine>[0] = joinTarget
    ? { type: "JOIN", gameId: joinTarget, displayName, ...(resumeToken ? { sessionToken: resumeToken } : {}) }
    : { type: "CREATE", displayName };
  const remote = useRemoteEngine(initial);

  // Once a game is created, sync the hash so the URL is shareable.
  useEffect(() => {
    if (remote.identity && !joinTarget) {
      const desired = `#/game/${remote.identity.gameId}`;
      if (window.location.hash !== desired) {
        window.location.hash = desired;
      }
    }
  }, [remote.identity, joinTarget]);

  if (!remote.identity) {
    return (
      <div className="screen lobby">
        <p className="muted">Connecting…</p>
        {remote.lastError && <div className="error">{remote.lastError}</div>}
      </div>
    );
  }

  if (!remote.visibleState) {
    return <Lobby remote={remote} />;
  }
  return <GameShell remote={remote} />;
}
