// Future Ready - live classroom demo server
// Serves the web app and relays WebRTC signaling + chat/state over WebSocket.
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 25;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/class/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'class.html')));
app.get('/healthz', (_req, res) => res.send('ok'));
// Optional TURN support: set ICE_SERVERS='[{"urls":"stun:..."},{"urls":"turn:...","username":"u","credential":"p"}]'
app.get('/api/config', (_req, res) => {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  try { if (process.env.ICE_SERVERS) iceServers = JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.error('Bad ICE_SERVERS', e.message); }
  res.json({ iceServers });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // roomId -> { hostKey, clients: Map<id, ws> }

const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);
const newId = () => Math.random().toString(36).slice(2, 10);
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const info = (ws) => ({ id: ws.id, name: ws.name, role: ws.role, state: ws.state });
function broadcast(room, obj, exceptId) {
  room.clients.forEach((c, id) => { if (id !== exceptId) send(c, obj); });
}

function leave(ws) {
  const room = ws.room && rooms.get(ws.room);
  if (!room || !room.clients.has(ws.id)) return;
  room.clients.delete(ws.id);
  broadcast(room, { t: 'peer-left', id: ws.id });
  if (room.clients.size === 0) rooms.delete(ws.room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join' && !ws.room) {
      const roomId = clean(m.room, 40).toLowerCase();
      if (!roomId) return send(ws, { t: 'error', message: 'Missing class code.' });
      let room = rooms.get(roomId);
      if (!room) { room = { hostKey: null, clients: new Map() }; rooms.set(roomId, room); }
      if (room.clients.size >= MAX_PER_ROOM) return send(ws, { t: 'error', message: 'This class is full.' });
      if (!room.hostKey && m.hostKey) room.hostKey = String(m.hostKey).slice(0, 64);
      ws.id = newId();
      ws.room = roomId;
      ws.name = clean(m.name, 30) || 'Guest';
      ws.role = room.hostKey && m.hostKey === room.hostKey ? 'teacher' : 'student';
      ws.state = { mic: false, cam: false, screen: false, hand: false, audioId: null, camId: null, screenId: null };
      send(ws, { t: 'welcome', id: ws.id, role: ws.role, peers: [...room.clients.values()].map(info) });
      room.clients.set(ws.id, ws);
      broadcast(room, { t: 'peer-joined', peer: info(ws) }, ws.id);
      return;
    }

    const room = ws.room && rooms.get(ws.room);
    if (!room) return;

    switch (m.t) {
      case 'signal': {
        const target = room.clients.get(m.to);
        if (target) send(target, { t: 'signal', from: ws.id, data: m.data });
        break;
      }
      case 'state': {
        const s = m.state || {};
        ws.state = {
          mic: !!s.mic, cam: !!s.cam, screen: ws.role === 'teacher' && !!s.screen, hand: !!s.hand,
          audioId: s.audioId || null, camId: s.camId || null, screenId: ws.role === 'teacher' ? s.screenId || null : null,
        };
        broadcast(room, { t: 'state', from: ws.id, state: ws.state }, ws.id);
        break;
      }
      case 'chat': {
        const text = clean(m.text, 500);
        if (text) broadcast(room, { t: 'chat', from: ws.id, name: ws.name, role: ws.role, text, ts: Date.now() });
        break;
      }
      case 'mute-all':
      case 'end':
        if (ws.role === 'teacher') broadcast(room, { t: m.t }, ws.id);
        break;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);

if (require.main === module) server.listen(PORT, () => console.log(`Future Ready live demo on http://localhost:${PORT}`));
module.exports = { server };
