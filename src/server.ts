import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import type { Room, Message } from "./types";

const PORT = process.env.PORT || 3000;
const app  = express();
app.use(express.json());

// ---------- statikus fájlok ----------
const staticPath = path.join(__dirname, "../public");
app.use(express.static(staticPath));

// ---------- in-memory store ----------
const rooms: Record<string, Room & { hash: string; expiresAt?: number }> = {};
const messages: Message[] = [];

const ROOM_TTL   = 10 * 60 * 1000;   // 10 perc ms-ben
const MSG_TTL_MS = 5 * 60 * 1000;    // 5 perc

// ---------- segédek ----------
const seg = () => Math.random().toString(36).substring(2, 5).toUpperCase();
const genRoomId = () => `${seg()}-${seg()}-${seg()}`;
const sha256 = (s:string) => crypto.createHash("sha256").update(s).digest("hex");

// ---------- REST ----------
app.get("/api/rooms", (_req, res) => {
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
  const { username, password, isPublic = false } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });
  if (typeof password !== "string" || password.trim().length < 5) {
    return res.status(400).json({ error: "password min 5 chars" });
  }

  const roomId = genRoomId();
  const userId = uuid();

  rooms[roomId] = {
    id: roomId,
    isPublic,
    members: { [userId]: username },
    hash: sha256(password.trim().toLowerCase())
  };

  res.status(201).json({ roomId, userId });
  broadcastRooms();
});

app.post("/api/rooms/:roomId/join", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "room not found" });

  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });
  if (typeof password !== "string" || password.trim().length < 5) {
    return res.status(400).json({ error: "password min 5 chars" });
  }

  const passHash = sha256(password.trim().toLowerCase());
  if (room.hash !== passHash) return res.status(403).json({ error: "invalid password" });

  if (Object.values(room.members).includes(username)) {
    return res.status(409).json({ error: "username already taken" });
  }

  const userId = uuid();
  room.members[userId] = username;
  delete room.expiresAt;                 // szoba újra aktív

  res.json({ roomId: room.id, userId });
  broadcastUsers(room.id);
});

// ---------- HTTP + WebSocket ----------
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

interface ClientData { userId: string; roomId: string; }

wss.on("connection", ws => {
  ws.once("message", raw => {
    try {
      const init = JSON.parse(raw.toString());
      if (init.type !== "connect") throw 0;
      const { roomId, userId } = init;
      const room = rooms[roomId];
      if (!room || !room.members[userId]) return ws.close();

      (ws as any)._data = { roomId, userId } as ClientData;
      ws.on("message", handleMsg);
      ws.on("close",  () => handleClose(ws as any));

      ws.send(JSON.stringify({ type:"room.users", users:Object.values(room.members) }));
    } catch { ws.close(); }
  });
});

function handleMsg(this:any, raw:Buffer) {
  const ws = this, data:ClientData = ws._data; if(!data) return;
  const room = rooms[data.roomId];
  try {
    const m = JSON.parse(raw.toString());
    if (m.type === "message") {
      const txt = (m.content||"").toString().trim();
      if(!txt) return;
      const msg:Message = {
        id:uuid(), roomId:room.id, authorId:data.userId,
        username:room.members[data.userId], content:txt,
        sentAt:new Date().toISOString()
      };
      messages.push(msg);
      broadcast(room.id,{type:"room.message",...msg});
    }
  }catch{}
}

function handleClose(ws:any){
  const cd:ClientData|undefined=ws._data; if(!cd) return;
  const room=rooms[cd.roomId]; if(!room) return;
  delete room.members[cd.userId];
  broadcastUsers(room.id);

  if(Object.keys(room.members).length===0){
    room.expiresAt = Date.now()+ROOM_TTL;       // 10-perces türelmi idő
  }
}

function broadcast(roomId: string, payload: any) {
  const txt = JSON.stringify(payload);
  wss.clients.forEach((c: any) => {
    const cd: ClientData | undefined = c._data;   // ← itt volt a typo
    if (c.readyState === 1 && cd?.roomId === roomId) {
      c.send(txt);
    }
  });
}
function broadcastUsers(roomId:string){
  const users=Object.values(rooms[roomId]?.members??{});
  broadcast(roomId,{type:"room.users",users});
}
function broadcastRooms(){
  const list=Object.values(rooms).map(r=>({id:r.id,memberCount:Object.keys(r.members).length,isPublic:r.isPublic}));
  const txt=JSON.stringify({type:"rooms.list",rooms:list});
  wss.clients.forEach(c=>c.readyState===1&&c.send(txt));
}

// ---------- háttér-GC ----------
setInterval(()=>{                            // szobák
  const now=Date.now();
  Object.entries(rooms).forEach(([id,r])=>{
    if(r.expiresAt && r.expiresAt<now){
      delete rooms[id];
      broadcastRooms();
    }
  });
},30_000);
setInterval(()=>{                            // üzenetek
  const cutoff=Date.now()-MSG_TTL_MS;
  let n=messages.length;
  for(let i=n-1;i>=0;i--){
    if(new Date(messages[i].sentAt).getTime()<cutoff) messages.splice(i,1);
  }
},60_000);

server.listen(PORT,()=>console.log(`🚀 listening on :${PORT}`));
