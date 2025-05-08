import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import type { Room, Message } from "./types";

const PORT = process.env.PORT || 3000;
const app  = express();
app.use(express.json());

// ------ statikus fájlok ------
const staticPath = path.join(__dirname, "../public");
app.use(express.static(staticPath));

// ------ in-memory tárolók ------
const rooms: Record<string, Room> = {};
const messages: Message[] = [];

// ------ segédek ------
const seg = () => Math.random().toString(36).substring(2, 5);
const genRoomId = () => `${seg()}-${seg()}-${seg()}`;

// ------ REST ------
app.get("/api/rooms", (_req, res) => {
  // szobák listája a landinghez
  const list = Object.values(rooms).map(r => ({
    id: r.id,
    memberCount: Object.keys(r.members).length,
    isPublic: r.isPublic
  }));
  res.json(list);
});

app.get("/api/rooms/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "room not found" });
  res.json({ members: Object.values(room.members) });
});

app.post("/api/rooms", (req, res) => {
  const { username, password = "", isPublic = false } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });

  const roomId = genRoomId();
  const userId = uuid();

  rooms[roomId] = {
    id: roomId,
    isPublic,
    password: password.trim(),
    members: { [userId]: username }
  };

  res.status(201).json({ roomId, userId });
  broadcastRooms();                    // új szoba → friss listát küldünk
});

app.post("/api/rooms/:roomId/join", (req, res) => {
  const room   = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "room not found" });

  const { username, password = "" } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });

  const pass = password.trim();
  if (room.password && room.password !== pass) {
    return res.status(403).json({ error: "invalid password" });
  }

  if (Object.values(room.members).includes(username)) {
    return res.status(409).json({ error: "username already taken" });
  }

  const userId = uuid();
  room.members[userId] = username;

  res.json({ roomId: room.id, userId });
  broadcastUsers(room.id);             // új tag → user-lista frissítés
});

// ------ HTTP + WebSocket ------
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

interface ClientData {
  userId: string;
  roomId: string;
}

wss.on("connection", ws => {
  // első üzenet: {type:"connect", roomId, userId}
  ws.once("message", raw => {
    try {
      const init = JSON.parse(raw.toString());
      if (init.type !== "connect") throw new Error();
      const { roomId, userId } = init;
      const room = rooms[roomId];
      if (!room || !room.members[userId]) {
        ws.close(); return;
      }
      (ws as any)._data = { roomId, userId } as ClientData;

      ws.on("message", handleMessage);
      ws.on("close",  () => handleClose(ws as any));

      ws.send(JSON.stringify({ type: "system", msg: "connected" }));
      // küldjük az aktuális user-listát
      ws.send(JSON.stringify({ type: "room.users", users: Object.values(room.members) }));
    } catch { ws.close(); }
  });
});

function handleMessage(this: any, raw: Buffer) {
  const ws   : any        = this;
  const data : ClientData = ws._data;
  if (!data) return;

  const room  = rooms[data.roomId];
  try {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "message") {
      const text = (msg.content ?? "").toString().trim();
      if (!text) return;

      const m: Message = {
        id: uuid(),
        roomId: room.id,
        authorId: data.userId,
        username: room.members[data.userId],
        content: text,
        sentAt: new Date().toISOString()
      };
      messages.push(m);
      broadcast(room.id, { type: "room.message", ...m });
    }
  } catch { /* malformed → ignoráljuk */ }
}

function handleClose(ws: any) {
  const cd: ClientData | undefined = ws._data;
  if (!cd) return;
  const room = rooms[cd.roomId];
  if (!room) return;

  delete room.members[cd.userId];
  broadcastUsers(room.id);

  // ha üres maradt a szoba, töröljük
  if (Object.keys(room.members).length === 0) {
    delete rooms[room.id];
    broadcastRooms();
  }
}

function broadcast(roomId: string, payload: any) {
  const txt = JSON.stringify(payload);
  wss.clients.forEach((c: any) => {
    const cd: ClientData | undefined = c._data;
    if (c.readyState === 1 && cd?.roomId === roomId) c.send(txt);
  });
}

function broadcastUsers(roomId: string) {
  const users = Object.values(rooms[roomId]?.members ?? {});
  broadcast(roomId, { type: "room.users", users });
}

function broadcastRooms() {
  const list = Object.values(rooms).map(r => ({
    id: r.id,
    memberCount: Object.keys(r.members).length,
    isPublic: r.isPublic
  }));
  const txt = JSON.stringify({ type: "rooms.list", rooms: list });
  wss.clients.forEach((c: any) => {
    if (c.readyState === 1) c.send(txt);
  });
}

server.listen(PORT, () => console.log(`🚀 listening on :${PORT}`));
