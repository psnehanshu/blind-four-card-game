import { io, type Socket } from "socket.io-client";
import { MSG_CHANNEL, type ClientMsg, type ServerMsg } from "../../../server/wire.js";

const URL = import.meta.env.VITE_SERVER_URL ?? "";
const SOCKET_PATH = import.meta.env.VITE_SOCKET_PATH ?? "/api/socket.io/";

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    socket = URL ? io(URL, { transports: ["websocket"] }) : io({ path: SOCKET_PATH, transports: ["websocket"] });
  }
  return socket;
}

export function send(msg: ClientMsg): void {
  getSocket().emit(MSG_CHANNEL, msg);
}

type Handler = (msg: ServerMsg) => void;

function isServerMsg(raw: unknown): raw is ServerMsg {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const kind: unknown = Reflect.get(raw, "kind");
  return kind === "WELCOME" || kind === "LOBBY" || kind === "STATE" || kind === "ERROR";
}

export function subscribe(handler: Handler): () => void {
  const s = getSocket();
  const wrapped = (raw: unknown): void => {
    if (isServerMsg(raw)) handler(raw);
  };
  s.on(MSG_CHANNEL, wrapped);
  return () => {
    s.off(MSG_CHANNEL, wrapped);
  };
}
