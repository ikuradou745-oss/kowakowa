import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

function ensureGameBundle() {
  const bundlePath = path.join(__dirname, 'game.js');
  if (!fs.existsSync(bundlePath)) {
    console.log('[jinrou-online] game.js not found. Bundling src/main.js with esbuild...');
    try {
      execSync('npx esbuild src/main.js --bundle --outfile=game.js --format=esm', {
        cwd: __dirname,
        stdio: 'inherit'
      });
      console.log('[jinrou-online] Successfully bundled game.js');
    } catch (e) {
      console.error('[jinrou-online] Failed to build game.js:', e);
    }
  }
}
ensureGameBundle();

app.use(express.json());

// Enable CORS so client can connect from any origin (including GitHub Pages)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Never cache index.html or game.js so client always loads fresh code
app.use((req, res, next) => {
  if (req.path === '/game.js' || req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Explicit favicon handler returning 204 No Content so it never produces 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Explicit game.js handler ensuring the bundle exists and is served with proper content-type
app.get('/game.js', (req, res) => {
  ensureGameBundle();
  const bundlePath = path.join(__dirname, 'game.js');
  if (fs.existsSync(bundlePath)) {
    res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(bundlePath);
  } else {
    res.status(500).send('console.error("game.js bundle failed to build");');
  }
});

app.use(express.static(__dirname));

// In-memory room storage for instant online multiplayer
const rooms = new Map(); // roomCode -> { code, hostId, gameState: 'lobby'|'playing', currentStage: 1, players: Map<id, player>, sockets: Set<ws> }

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function broadcastToRoom(roomCode, message, senderWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const client of room.sockets) {
    if (client.readyState === WebSocket.OPEN && client !== senderWs) {
      try { client.send(payload); } catch (e) {}
    }
  }
}

function broadcastToAllInRoom(roomCode, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const client of room.sockets) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (e) {}
    }
  }
}

function getRoomSnapshot(room) {
  const playersObj = {};
  for (const [id, p] of room.players.entries()) {
    playersObj[id] = p;
  }
  return {
    code: room.code,
    hostId: room.hostId,
    gameState: room.gameState,
    currentStage: room.currentStage,
    players: playersObj
  };
}

// REST APIs
const jinrouRooms = new Map(); // roomCode -> roomData

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'jinrou-online', activeRooms: jinrouRooms.size });
});

app.post('/api/jinrou/rooms', (req, res) => {
  const roomData = req.body;
  if (!roomData || !roomData.code) {
    return res.status(400).json({ error: 'Invalid room data' });
  }
  jinrouRooms.set(roomData.code, {
    ...roomData,
    updatedAt: Date.now()
  });
  console.log(`[jinrou-online] Room #${roomData.code} created on server.`);
  res.json(roomData);
});

app.get('/api/jinrou/rooms/:code', (req, res) => {
  const room = jinrouRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

app.post('/api/jinrou/rooms/:code/join', (req, res) => {
  const { playerId, playerNickname } = req.body;
  const room = jinrouRooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: '部屋が見つかりませんでした' });

  if (room.status && room.status !== 'waiting') {
    return res.status(400).json({ error: 'ゲームが既に開始されています' });
  }

  const currentCount = Object.keys(room.players || {}).length;
  const max = room.maxPlayers || 12;
  if (currentCount >= max && !room.players[playerId]) {
    return res.status(400).json({ error: `部屋が満員です（定員: ${max}人）` });
  }

  room.players = room.players || {};
  room.players[playerId] = {
    id: playerId,
    nickname: playerNickname,
    isHost: (room.hostId === playerId),
    isLeader: (room.hostId === playerId),
    role: null,
    isAlive: true,
    joinedAt: Date.now()
  };
  room.updatedAt = Date.now();
  res.json(room);
});

app.post('/api/jinrou/rooms/:code/leave', (req, res) => {
  const { playerId } = req.body;
  const room = jinrouRooms.get(req.params.code);
  if (!room) return res.json({ success: true });

  if (room.players && room.players[playerId]) {
    delete room.players[playerId];
    if (Object.keys(room.players).length === 0) {
      jinrouRooms.delete(req.params.code);
      console.log(`[jinrou-online] Room #${req.params.code} closed (empty).`);
    } else if (room.hostId === playerId) {
      const remaining = Object.keys(room.players);
      room.hostId = remaining[0];
      room.players[remaining[0]].isHost = true;
      room.players[remaining[0]].isLeader = true;
    }
  }
  res.json({ success: true });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(getRoomSnapshot(room));
});

// Fallback to index.html for client routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);

// Real-time WebSocket Server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let clientRoomCode = null;
  let clientPlayerId = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type, payload } = msg;

      if (type === 'CREATE_ROOM') {
        const code = generateRoomCode();
        clientRoomCode = code;
        clientPlayerId = payload.playerId;

        const room = {
          code,
          hostId: payload.playerId,
          gameState: 'lobby',
          currentStage: 1,
          players: new Map(),
          sockets: new Set([ws])
        };

        room.players.set(payload.playerId, {
          id: payload.playerId,
          name: payload.name || '生徒',
          item: payload.item || 'flashlight',
          customization: payload.customization || {},
          isHost: true,
          x: 0,
          y: 1.6,
          z: 0,
          rotation: 0,
          isHidden: false,
          isCrouching: false,
          isDead: false
        });

        rooms.set(code, room);
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', payload: getRoomSnapshot(room) }));
      } else if (type === 'JOIN_ROOM') {
        const code = (payload.code || '').trim();
        const room = rooms.get(code);
        if (!room) {
          return ws.send(JSON.stringify({ type: 'ERROR', payload: { message: '部屋が見つかりません' } }));
        }
        if (room.players.size >= 4) {
          return ws.send(JSON.stringify({ type: 'ERROR', payload: { message: '部屋が満員です（最大4人）' } }));
        }

        clientRoomCode = code;
        clientPlayerId = payload.playerId;
        room.sockets.add(ws);

        room.players.set(payload.playerId, {
          id: payload.playerId,
          name: payload.name || '生徒',
          item: payload.item || 'flashlight',
          customization: payload.customization || {},
          isHost: false,
          x: 0,
          y: 1.6,
          z: 0,
          rotation: 0,
          isHidden: false,
          isCrouching: false,
          isDead: false
        });

        ws.send(JSON.stringify({ type: 'ROOM_JOINED', payload: getRoomSnapshot(room) }));
        broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(room) }, ws);
      } else if (type === 'START_GAME') {
        if (!clientRoomCode) return;
        const room = rooms.get(clientRoomCode);
        if (room && room.hostId === clientPlayerId) {
          room.gameState = 'playing';
          room.currentStage = 1;
          broadcastToAllInRoom(clientRoomCode, { type: 'GAME_STARTED', payload: getRoomSnapshot(room) });
        }
      } else if (type === 'STAGE_CLEAR') {
        if (!clientRoomCode) return;
        const room = rooms.get(clientRoomCode);
        if (room) {
          const nextStage = (room.currentStage || 1) + 1;
          room.currentStage = nextStage;
          broadcastToAllInRoom(clientRoomCode, { type: 'NEXT_STAGE', payload: { nextStage } });
        }
      } else if (type === 'PLAYER_MOVE') {
        if (!clientRoomCode || !clientPlayerId) return;
        const room = rooms.get(clientRoomCode);
        if (room && room.players.has(clientPlayerId)) {
          const p = room.players.get(clientPlayerId);
          Object.assign(p, payload);
          broadcastToRoom(clientRoomCode, { type: 'PLAYER_MOVED', payload: { id: clientPlayerId, ...payload } }, ws);
        }
      } else if (type === 'UPDATE_CUSTOM') {
        if (!clientRoomCode || !clientPlayerId) return;
        const room = rooms.get(clientRoomCode);
        if (room && room.players.has(clientPlayerId)) {
          const p = room.players.get(clientPlayerId);
          p.customization = payload.customization;
          broadcastToRoom(clientRoomCode, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(room) });
        }
      } else if (type === 'LEAVE_ROOM') {
        if (clientRoomCode && rooms.has(clientRoomCode)) {
          const room = rooms.get(clientRoomCode);
          room.sockets.delete(ws);
          if (clientPlayerId) {
            room.players.delete(clientPlayerId);
          }
          if (room.players.size === 0) {
            rooms.delete(clientRoomCode);
          } else {
            if (room.hostId === clientPlayerId) {
              const firstPlayerId = room.players.keys().next().value;
              room.hostId = firstPlayerId;
              const newHost = room.players.get(firstPlayerId);
              if (newHost) newHost.isHost = true;
            }
            broadcastToAllInRoom(clientRoomCode, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(room) });
          }
          clientRoomCode = null;
        }
      }
    } catch (e) {
      console.error('[WS Error]', e);
    }
  });

  ws.on('close', () => {
    if (clientRoomCode && rooms.has(clientRoomCode)) {
      const room = rooms.get(clientRoomCode);
      room.sockets.delete(ws);
      if (clientPlayerId) {
        room.players.delete(clientPlayerId);
      }
      if (room.players.size === 0) {
        rooms.delete(clientRoomCode);
      } else {
        // Transfer host if host left
        if (room.hostId === clientPlayerId) {
          const firstPlayerId = room.players.keys().next().value;
          room.hostId = firstPlayerId;
          const newHost = room.players.get(firstPlayerId);
          if (newHost) newHost.isHost = true;
        }
        broadcastToAllInRoom(clientRoomCode, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(room) });
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[jinrou-online] Werewolf Server running on http://${HOST}:${PORT}`);
});
