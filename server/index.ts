import { createServer } from "node:http";
import { resolve } from "node:path";
import { Server } from "socket.io";
import { GameManager } from "./game-manager.js";
import { attachSocketHandlers } from "./socket.js";
import { Store } from "./store.js";

const PORT = Number(process.env.PORT ?? 3001);
const DB_PATH = process.env.DB_PATH ?? resolve("server/data/blind-four.db");

const store = await Store.open(DB_PATH);
const manager = new GameManager(store);

const http = createServer();
const io = new Server(http, {
  cors: { origin: true, credentials: true },
});

attachSocketHandlers(io, store, manager);

http.listen(PORT, () => {
  console.log(`blind-four server listening on :${PORT} (db=${DB_PATH})`);
});
