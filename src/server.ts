import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import type { Room, Message } from "./types";

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// Statikus SPA kiszolgálása
const staticPath = path.join(__dirname, "../public");
app.use(express.static(staticPath));

// ===== In-memory tárolók (MVP) =====
const rooms: Record<string, Room> = {};
const messages: Message[] = [];

// ----- Segédfüggvények -----
function generateRoomId(): string {
  const seg = () => Math.random().toString(36).substring(2, 5); // 3 karakter
  return `${seg()}-${seg()}-${seg()}`;
}

// ===== REST végpontok =====

// Szoba létrehozás
app.post("/api/rooms", (req, res) => {
  const { username, password = "", isPublic = false } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });

  const roomId = generateRoomId();
  const userId = uuid();

  rooms[roomId] = {
    id: roomId,
    isPublic,
    password: password.trim(),        // <── trim!
    members: { [userId]: username }
  };

  res.status(201).json({ roomId, userId });
});

// Szobához csatlakozás
app.post("/api/rooms/:roomId/join", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "room not found" });

  const { username, password = "" } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });

  const pass = (password || "").trim();          // <── trim!
  if (room.password && room.password !== pass) {
    return res.status(403).json({ error: "invalid password" });
  }

  if (Object.values(room.members).includes(username)) {
    return res.status(409).json({ error: "username already taken" });
  }

  const userId = uuid();
  room.members[userId] = username;

  res.json({ roomId: room.id, userId });
});

// ===== HTTP + WebSocket =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

interface ClientData {
  userId: string;
  roomId: string;
}

wss.on("connection", (ws) => {
  // első üzenetnek jönnie kell: {type:"connect", roomId, userId}
  ws.once("message", (raw) => {
    try {
      const init = JSON.parse(raw.toString());
      if (init.type !== "connect") throw new Error();
      const { roomId, userId } = init;
      const room = rooms[roomId];
      if (!room || !room.members[userId]) {
        ws.close();
        return;
      }
      (ws as any)._data = { roomId, userId } as ClientData;
      ws.on("message", handleWsMessage);
      ws.send(JSON.stringify({ type: "system", msg: "connected" }));
    } catch {
      ws.close();
    }
  });
});

function handleWsMessage(this: any, raw: Buffer) {
  const ws: any = this;
  const data: ClientData = ws._data;
  if (!data) return;
  const room = rooms[data.roomId];

  try {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "message") {
      const text = (msg.content || "").toString().trim();
      if (!text) return;
      const message: Message = {
        id: uuid(),
        roomId: room.id,
        authorId: data.userId,
        username: room.members[data.userId],
        content: text,
        sentAt: new Date().toISOString()
      };
      messages.push(message);
      broadcast(room.id, { type: "room.message", ...message });
    }
  } catch { /* rossz formátum: ignoráljuk */ }
}

function broadcast(roomId: string, payload: any) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client: any) => {
    const cd: ClientData | undefined = client._data;
    if (client.readyState === 1 && cd?.roomId === roomId) {
      client.send(msg);
    }
  });
}

server.listen(PORT, () => {
  console.log(`🚀 Server listening on :${PORT}`);
});
