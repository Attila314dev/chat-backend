import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";
import type { Room } from "./types";

const PORT       = process.env.PORT || 3000;
const ROOM_TTL   = 10 * 60 * 1000;
const MSG_TTL_MS = 5 * 60 * 1000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const rooms: Record<string, Room & { expiresAt?: number }> = {};
interface StoredMsg {
  roomId: string;
  username: string;
  content: string;
  sentAt: number;
}
const messages: StoredMsg[] = [];

const seg       = () => Math.random().toString(36).substring(2, 5).toUpperCase();
const genRoomId = () => `${seg()}-${seg()}-${seg()}`;
const sha256    = (s:string) => crypto.createHash("sha256").update(s).digest("hex");

/* GET available rooms */
app.get("/api/rooms", (_req, res) => {
  const now = Date.now();
  const list = Object.values(rooms).filter(r => r.isPublic).map(r => ({
    id: r.id,
    memberCount: Object.keys(r.members).length,
    maxUsers: r.maxUsers,
    ttl: r.expiresAt ? Math.max(0, r.expiresAt - now) : null
  }));
  res.json(list);
});

/* POST create room */
app.post("/api/rooms", (req, res) => {
  const { username, password, hidden = false, maxUsers } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });
  if (typeof password !== "string" || password.trim().length < 5)
    return res.status(400).json({ error: "password min 5 chars" });

  const cap = parseInt(maxUsers, 10);
  if (isNaN(cap) || cap < 2 || cap > 6)
    return res.status(400).json({ error: "maxUsers 2–6" });

  const roomId = genRoomId();
  const userId = uuid();
  const hashU  = sha256(username.trim().toLowerCase());

  rooms[roomId] = {
    id       : roomId,
    isPublic : !hidden,
    maxUsers : cap,
    hash     : sha256(password.trim().toLowerCase()),
    members  : { [userId]: username },
    loginHashes: [hashU]
  };

  res.status(201).json({ roomId, userId });
  if (!hidden) broadcastRooms();
});

/* POST join room */
app.post("/api/rooms/:roomId/join", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "room not found" });

  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });
  if (typeof password !== "string" || password.trim().length < 5)
    return res.status(400).json({ error: "password min 5 chars" });

  const uhash = sha256(username.trim().toLowerCase());

  // ha már bent van ilyen név → engedjük
  if (!room.loginHashes.includes(uhash)) {
    if (room.loginHashes.length >= room.maxUsers)
      return res.status(403).json({ error: "maximum number of users already joined" });
    room.loginHashes.push(uhash);
  }

  if (Object.values(room.members).includes(username))
    return res.status(409).json({ error: "username already taken" });

  if (room.hash !== sha256(password.trim().toLowerCase()))
    return res.status(403).json({ error: "invalid password" });

  const userId = uuid();
  room.members[userId] = username;
  delete room.expiresAt;

  res.json({ roomId: room.id, userId });
  broadcastUsers(room.id);
});

/* WebSocket kapcsolat */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

interface ClientData { roomId: string; userId: string; }

wss.on("connection", ws => {
  ws.once("message", raw => {
    try {
      const { type, roomId, userId } = JSON.parse(raw.toString());
      if (type !== "connect") throw 0;

      const room = rooms[roomId];
      if (!room || !room.members[userId]) return ws.close();

      (ws as any)._data = { roomId, userId } as ClientData;
      ws.on("message", handleMsg);
      ws.on("close",  () => handleClose(ws as any));

      ws.send(JSON.stringify({ type:"room.users", users:Object.values(room.members) }));
      ws.send(JSON.stringify({
        type:"room.history",
        messages: messages.filter(m=>m.roomId===roomId && Date.now()-m.sentAt<=MSG_TTL_MS)
      }));
    } catch { ws.close(); }
  });
});

/* Beérkező üzenet */
function handleMsg(this:any, raw:Buffer){
  const cd:ClientData = this._data; if(!cd) return;
  const room = rooms[cd.roomId];

  try {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "message") {
      const txt = (msg.content||"").toString().trim();
      if (!txt) return;

      const now = Date.now();
      const payload = { type:"room.message", username:room.members[cd.userId], content:txt, sentAt:now };

      broadcast(room.id, payload);
      messages.push({ roomId:room.id, username:payload.username, content:txt, sentAt:now });
    }
  } catch {}
}

/* Kilépés */
function handleClose(ws:any){
  const cd:ClientData = ws._data; if(!cd) return;
  const room = rooms[cd.roomId]; if(!room) return;

  delete room.members[cd.userId];
  broadcastUsers(room.id);

  if (Object.keys(room.members).length===0)
    room.expiresAt = Date.now() + ROOM_TTL;
}

/* Broadcast */
function broadcast(roomId:string,p:any){
  const txt = JSON.stringify(p);
  wss.clients.forEach((c:any)=>{
    const cd:ClientData|undefined = c._data;
    if (c.readyState===1 && cd?.roomId===roomId) c.send(txt);
  });
}
function broadcastUsers(roomId:string){
  broadcast(roomId,{ type:"room.users", users:Object.values(rooms[roomId]?.members||{}) });
}
function broadcastRooms(){
  const now=Date.now();
  const list = Object.values(rooms).filter(r=>r.isPublic).map(r=>({
    id:r.id,
    memberCount:Object.keys(r.members).length,
    maxUsers:r.maxUsers,
    ttl:r.expiresAt ? Math.max(0,r.expiresAt-now) : null
  }));
  const txt = JSON.stringify({ type:"rooms.list", rooms:list });
  wss.clients.forEach(c=>c.readyState===1&&c.send(txt));
}

/* GC időzítők */
setInterval(()=>{
  const now=Date.now();
  for(const [id,r] of Object.entries(rooms)){
    if(r.expiresAt && r.expiresAt<now){
      delete rooms[id];
      if(r.isPublic) broadcastRooms();
    }
  }
},60_000);

setInterval(()=>{
  const cutoff=Date.now()-MSG_TTL_MS;
  for(let i=messages.length-1;i>=0;i--)
    if(messages[i].sentAt<cutoff) messages.splice(i,1);
},60_000);

server.listen(PORT,()=>console.log(`🚀 listening on :${PORT}`));
