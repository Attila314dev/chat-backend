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
const ROOM_TTL   = 10 * 60 * 1000;   // 10 perc
const MSG_TTL_MS =  5 * 60 * 1000;   // 5 perc

const app = express();
app.use(express.json());

// ---------- statikus fájlok ----------
app.use(express.static(path.join(__dirname, "../public")));

// ---------- memóriatárolók ----------
const rooms: Record<string, Room & { expiresAt?: number }> = {};
const messages: { id:string; roomId:string; sentAt:number }[] = [];

// ---------- segédek ----------
const seg = () => Math.random().toString(36).substring(2, 5).toUpperCase();
const genRoomId = () => `${seg()}-${seg()}-${seg()}`;
const sha256 = (s:string) => crypto.createHash("sha256").update(s).digest("hex");

// ---------- REST ----------
app.get("/api/rooms", (_req, res) => {
  const list = Object.values(rooms)
    .filter(r => r.isPublic)          // csak a publikusakat listázzuk
    .map(r => ({
      id: r.id,
      memberCount: Object.keys(r.members).length,
      maxUsers: r.maxUsers
    }));
  res.json(list);
});

app.post("/api/rooms", (req, res) => {
  const { username, password, hidden = false, maxUsers } = req.body;
  if (!username)           return res.status(400).json({ error: "username required" });
  if (typeof password !== "string" || password.trim().length < 5)
    return res.status(400).json({ error: "password min 5 chars" });
  const cap = parseInt(maxUsers, 10);
  if (isNaN(cap) || cap < 2 || cap > 6)
    return res.status(400).json({ error: "maxUsers must be 2–6" });

  const roomId = genRoomId();
  const userId = uuid();

  rooms[roomId] = {
    id: roomId,
    isPublic: !hidden,
    maxUsers: cap,
    hash: sha256(password.trim().toLowerCase()),
    members: { [userId]: username }
  };

  res.status(201).json({ roomId, userId });
  if (!hidden) broadcastRooms();        // csak publikus listát frissítünk
});

app.post("/api/rooms/:roomId/join", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "room not found" });

  const { username, password } = req.body;
  if (!username)           return res.status(400).json({ error: "username required" });
  if (typeof password !== "string" || password.trim().length < 5)
    return res.status(400).json({ error: "password min 5 chars" });

  if (Object.keys(room.members).length >= room.maxUsers)
    return res.status(403).json({ error: "room full" });

  if (Object.values(room.members).includes(username))
    return res.status(409).json({ error: "username already taken" });

  if (room.hash !== sha256(password.trim().toLowerCase()))
    return res.status(403).json({ error: "invalid password" });

  const userId = uuid();
  room.members[userId] = username;
  delete room.expiresAt;                     // újra aktív
  res.json({ roomId: room.id, userId });
  broadcastUsers(room.id);
});

// ---------- HTTP + WebSocket ----------
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

interface CD { userId:string; roomId:string; }

wss.on("connection", ws => {
  ws.once("message", raw => {
    try {
      const { type, roomId, userId } = JSON.parse(raw.toString());
      if (type !== "connect") throw 0;
      const room = rooms[roomId];
      if (!room || !room.members[userId]) return ws.close();

      (ws as any)._data = { roomId, userId } as CD;
      ws.on("message", handleMsg);
      ws.on("close",  () => handleClose(ws as any));

      ws.send(JSON.stringify({ type:"room.users", users:Object.values(room.members) }));
    } catch { ws.close(); }
  });
});

function handleMsg(this:any, raw:Buffer){
  const ws=this, cd:CD=ws._data; if(!cd) return;
  const room=rooms[cd.roomId];
  try{
    const m=JSON.parse(raw.toString());
    if(m.type==="message"){
      const txt=(m.content||"").toString().trim(); if(!txt) return;
      const payload={type:"room.message", username:room.members[cd.userId], content:txt, sentAt:Date.now()};
      broadcast(room.id,payload);
      messages.push({id:uuid(),roomId:room.id,sentAt:Date.now()});
    }
  }catch{}
}

function handleClose(ws:any){
  const cd:CD=ws._data; if(!cd) return;
  const room=rooms[cd.roomId]; if(!room) return;
  delete room.members[cd.userId];
  broadcastUsers(room.id);

  if(Object.keys(room.members).length===0){
    room.expiresAt=Date.now()+ROOM_TTL;
  }
}

function broadcast(roomId:string,p:any){
  const txt=JSON.stringify(p);
  wss.clients.forEach((c:any)=>{
    const cd:CD|undefined=c._data;
    if(c.readyState===1&&cd?.roomId===roomId) c.send(txt);
  });
}
function broadcastUsers(roomId:string){
  broadcast(roomId,{type:"room.users", users:Object.values(rooms[roomId]?.members??{})});
}
function broadcastRooms(){
  const publicRooms=Object.values(rooms).filter(r=>r.isPublic).map(r=>({
    id:r.id,memberCount:Object.keys(r.members).length,maxUsers:r.maxUsers
  }));
  const txt=JSON.stringify({type:"rooms.list",rooms:publicRooms});
  wss.clients.forEach(c=>c.readyState===1&&c.send(txt));
}

// ---------- GC timers ----------
setInterval(()=>{                     // szobák lejárata
  const now=Date.now();
  for(const [id,r] of Object.entries(rooms)){
    if(r.expiresAt && r.expiresAt<now){
      delete rooms[id];
      if(r.isPublic) broadcastRooms();
    }
  }
},60_000);

setInterval(()=>{                     // üzenetek 5 perc után törlés
  const cutoff=Date.now()-MSG_TTL_MS;
  for(let i=messages.length-1;i>=0;i--){
    if(messages[i].sentAt<cutoff) messages.splice(i,1);
  }
},60_000);

server.listen(PORT,()=>console.log(`🚀 listening on :${PORT}`));
