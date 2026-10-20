import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS = 8;
const rooms = new Map();
const clients = new Map();

const json = (socket, payload) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
};
const broadcast = (room, payload, except = null) => {
  for (const player of room.players.values()) if (player.socket !== except) json(player.socket, payload);
};
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const cleanName = (name) => typeof name === 'string' ? name.trim().slice(0, 24) : 'Player';

function leave(socket) {
  const player = clients.get(socket);
  if (!player) return;
  clients.delete(socket);
  const room = rooms.get(player.roomId);
  if (!room) return;
  room.players.delete(player.id);
  broadcast(room, { type: 'player_left', id: player.id });
  if (room.players.size === 0) rooms.delete(room.id);
}
function join(socket, message) {
  leave(socket);
  const worldId = Number(message.worldId);
  if (!Number.isSafeInteger(worldId) || worldId < 0 || worldId > 1000000) return json(socket, { type: 'error', message: 'Invalid worldId' });
  const userId = typeof message.userId === 'string' && /^[a-f0-9-]{36}$/i.test(message.userId) ? message.userId : randomUUID();
  // Development server: userId is not authenticated. Add token validation before production.
  for (const p of clients.values()) if (p.id === userId) return json(socket, { type: 'error', message: 'User already connected' });
  let room = [...rooms.values()].find(r => r.worldId === worldId && r.players.size < MAX_PLAYERS);
  if (!room) { room = { id: randomUUID(), worldId, players: new Map() }; rooms.set(room.id, room); }
  const player = { id: userId, name: cleanName(message.username) || 'Player', roomId: room.id, socket, pose: { x: 0, y: 0, z: 0, rotation: 0 }, lastMove: 0 };
  room.players.set(player.id, player);
  clients.set(socket, player);
  json(socket, { type: 'joined', id: player.id, roomId: room.id, worldId, maxPlayers: MAX_PLAYERS, players: [...room.players.values()].filter(p => p !== player).map(p => ({ id: p.id, username: p.name, transform: p.pose })) });
  broadcast(room, { type: 'player_joined', id: player.id, username: player.name, transform: player.pose }, socket);
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, name: 'Classic Worlds Game Server', rooms: rooms.size, players: clients.size, maxPlayersPerRoom: MAX_PLAYERS }));
  } else { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); }
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
wss.on('connection', socket => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'join') return join(socket, msg);
    if (msg.type === 'leave') return leave(socket);
    const player = clients.get(socket);
    if (!player) return;
    if (msg.type === 'move') {
      const t = msg.transform;
      if (!t || !finite(t.x, -100000, 100000) || !finite(t.y, -100000, 100000) || !finite(t.z, -100000, 100000) || !finite(t.rotation, -1000, 1000)) return;
      const now = Date.now();
      if (now - player.lastMove < 35) return; // at most ~28 updates/s per player
      player.lastMove = now;
      player.pose = { x: t.x, y: t.y, z: t.z, rotation: t.rotation };
      const room = rooms.get(player.roomId);
      if (room) broadcast(room, { type: 'move', id: player.id, transform: player.pose }, socket);
    }
  });
  socket.on('close', () => leave(socket));
  socket.on('error', () => leave(socket));
});
const interval = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, 25000);
wss.on('close', () => clearInterval(interval));
server.listen(PORT, '0.0.0.0', () => console.log(`Classic Worlds server listening on ${PORT}`));
