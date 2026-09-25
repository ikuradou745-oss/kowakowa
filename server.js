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

// Enable CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Never cache index.html or game.js
app.use((req, res, next) => {
  if (req.path === '/game.js' || req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/game.js', (req, res) => {
  const bundlePath = path.join(__dirname, 'game.js');
  if (fs.existsSync(bundlePath)) {
    res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(bundlePath);
  } else {
    ensureGameBundle();
    if (fs.existsSync(bundlePath)) {
      res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
      res.sendFile(bundlePath);
    } else {
      res.status(500).send('console.error("game.js bundle failed to build");');
    }
  }
});

app.use(express.static(__dirname));

// --- In-Memory Room Management ---
// roomCode -> { code, hostId, hostNickname, status, maxPlayers, roleMode, rolesConfig, rolesList, players: Map<id, player>, sockets: Map<id, ws>, game: {...}, chatHistory: [] }
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function getRoomSnapshot(room) {
  if (!room) return null;
  const playersObj = {};
  for (const [id, p] of room.players.entries()) {
    playersObj[id] = {
      id: p.id,
      nickname: p.nickname || p.name || 'プレイヤー',
      isHost: !!p.isHost,
      isLeader: !!p.isHost,
      isAlive: p.isAlive !== false,
      isVcOn: p.isVcOn !== false,
      isMuted: !!p.isMuted,
      isSpeaking: !!p.isSpeaking,
      joinedAt: p.joinedAt || Date.now()
    };
  }
  return {
    code: room.code,
    hostId: room.hostId,
    hostNickname: room.hostNickname || 'ホスト',
    status: room.status || 'waiting',
    phase: room.game ? room.game.phase : 'waiting',
    dayCount: room.game ? room.game.dayCount : 1,
    maxPlayers: room.maxPlayers || 5,
    roleMode: room.roleMode || 'normal',
    rolesConfig: room.rolesConfig || {},
    rolesList: room.rolesList || [],
    players: playersObj,
    playerCount: room.players.size,
    chatHistory: (room.chatHistory || []).slice(-30),
    game: room.game ? {
      phase: room.game.phase,
      dayCount: room.game.dayCount,
      timerSec: room.game.timerSec,
      lastExiled: room.game.lastExiled,
      lastVictim: room.game.lastVictim,
      winner: room.game.winner,
      seerResult: room.game.seerResult
    } : null
  };
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of room.sockets.values()) {
    if (client && client.readyState === WebSocket.OPEN && client !== excludeWs) {
      try { client.send(payload); } catch (e) {}
    }
  }
}

function sendToPlayer(roomCode, playerId, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const ws = room.sockets.get(playerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    try { ws.send(payload); } catch (e) {}
  }
}

// Role distribution helper (Guarantees at least 3 players and 1 Werewolf)
function assignRoles(playerIds, configuredRolesList) {
  const shuffledIds = [...playerIds].sort(() => Math.random() - 0.5);
  let pool = [...(configuredRolesList || [])];

  // If pool does not match player count, create standard balanced pool
  if (pool.length < shuffledIds.length) {
    const count = shuffledIds.length;
    if (count === 3) {
      pool = ['werewolf', 'seer', 'villager'];
    } else if (count === 4) {
      pool = ['werewolf', 'seer', 'hunter_guard', 'villager'];
    } else if (count === 5) {
      pool = ['werewolf', 'traitor', 'seer', 'hunter_guard', 'villager'];
    } else {
      pool = ['werewolf', 'werewolf', 'traitor', 'seer', 'hunter_guard', 'medium'];
      while (pool.length < count) {
        pool.push('villager');
      }
    }
  }

  // Ensure there is at least one werewolf
  if (!pool.includes('werewolf')) {
    pool[0] = 'werewolf';
  }

  // Shuffle roles
  const shuffledRoles = [...pool].sort(() => Math.random() - 0.5);
  const assignments = {};
  shuffledIds.forEach((pid, idx) => {
    assignments[pid] = shuffledRoles[idx] || 'villager';
  });
  return assignments;
}

// --- REST Endpoints for compatibility ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'jinrou-online', activeRooms: rooms.size });
});

app.get('/api/jinrou/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: '部屋が見つかりませんでした' });
  res.json(getRoomSnapshot(room));
});

app.post('/api/jinrou/rooms', (req, res) => {
  const data = req.body || {};
  const code = (data.code || generateRoomCode()).toString();
  const hostId = data.hostId || 'host_' + Date.now();
  const hostNickname = data.hostNickname || 'ホスト';

  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      hostId,
      hostNickname,
      status: 'waiting',
      maxPlayers: Number(data.maxPlayers) || 5,
      roleMode: data.roleMode || 'normal',
      rolesConfig: data.rolesConfig || {},
      rolesList: data.rolesList || [],
      players: new Map(),
      sockets: new Map(),
      chatHistory: [],
      game: null
    };
    rooms.set(code, room);
  }

  room.players.set(hostId, {
    id: hostId,
    nickname: hostNickname,
    isHost: true,
    isAlive: true,
    isVcOn: true,
    isMuted: false,
    isSpeaking: false,
    joinedAt: Date.now()
  });

  res.json(getRoomSnapshot(room));
});

app.post('/api/jinrou/rooms/:code/join', (req, res) => {
  const { playerId, playerNickname } = req.body;
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: '部屋が見つかりませんでした' });
  if (room.status !== 'waiting') return res.status(400).json({ error: 'ゲームが既に開始されています' });
  if (room.players.size >= (room.maxPlayers || 12) && !room.players.has(playerId)) {
    return res.status(400).json({ error: `部屋が満員です（定員: ${room.maxPlayers}人）` });
  }

  room.players.set(playerId, {
    id: playerId,
    nickname: playerNickname || 'プレイヤー',
    isHost: room.hostId === playerId,
    isAlive: true,
    isVcOn: true,
    isMuted: false,
    isSpeaking: false,
    joinedAt: Date.now()
  });

  res.json(getRoomSnapshot(room));
});

app.post('/api/jinrou/rooms/:code/leave', (req, res) => {
  const { playerId } = req.body;
  const room = rooms.get(req.params.code);
  if (room) {
    room.players.delete(playerId);
    room.sockets.delete(playerId);
    if (room.players.size === 0) {
      rooms.delete(req.params.code);
    } else if (room.hostId === playerId) {
      const firstId = room.players.keys().next().value;
      room.hostId = firstId;
      const newHost = room.players.get(firstId);
      if (newHost) {
        newHost.isHost = true;
        room.hostNickname = newHost.nickname;
      }
    }
  }
  res.json({ success: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let clientRoomCode = null;
  let clientPlayerId = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type, payload } = msg;

      switch (type) {
        // --- Room Creation & Joining ---
        case 'CREATE_ROOM': {
          const code = (payload.code || generateRoomCode()).toString();
          clientRoomCode = code;
          clientPlayerId = payload.playerId;

          const room = {
            code,
            hostId: payload.playerId,
            hostNickname: payload.nickname || 'ホスト',
            status: 'waiting',
            maxPlayers: Number(payload.maxPlayers) || 5,
            roleMode: payload.roleMode || 'normal',
            rolesConfig: payload.rolesConfig || {},
            rolesList: payload.rolesList || [],
            players: new Map(),
            sockets: new Map(),
            chatHistory: [],
            game: null
          };

          room.players.set(payload.playerId, {
            id: payload.playerId,
            nickname: payload.nickname || 'ホスト',
            isHost: true,
            isAlive: true,
            isVcOn: payload.isVcOn !== false,
            isMuted: false,
            isSpeaking: false,
            joinedAt: Date.now()
          });
          room.sockets.set(payload.playerId, ws);
          rooms.set(code, room);

          ws.send(JSON.stringify({
            type: 'ROOM_CREATED',
            payload: getRoomSnapshot(room)
          }));
          break;
        }

        case 'JOIN_ROOM': {
          const code = (payload.code || '').toString().trim();
          const room = rooms.get(code);
          if (!room) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: `部屋（#${code}）が見つかりません。コードを確認してください。` }
            }));
          }
          if (room.status !== 'waiting') {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: 'ゲームが既に開始されているか、終了しています。' }
            }));
          }
          if (room.players.size >= (room.maxPlayers || 12) && !room.players.has(payload.playerId)) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: `部屋が満員です（定員: ${room.maxPlayers}人）` }
            }));
          }

          clientRoomCode = code;
          clientPlayerId = payload.playerId;

          room.players.set(payload.playerId, {
            id: payload.playerId,
            nickname: payload.nickname || 'プレイヤー',
            isHost: room.hostId === payload.playerId,
            isAlive: true,
            isVcOn: payload.isVcOn !== false,
            isMuted: false,
            isSpeaking: false,
            joinedAt: Date.now()
          });
          room.sockets.set(payload.playerId, ws);

          const snap = getRoomSnapshot(room);
          ws.send(JSON.stringify({ type: 'ROOM_JOINED', payload: snap }));
          broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: snap }, ws);

          // Notify existing peers to initiate WebRTC audio connection
          broadcastToRoom(code, {
            type: 'PEER_JOINED',
            payload: {
              peerId: payload.playerId,
              nickname: payload.nickname,
              isVcOn: payload.isVcOn !== false
            }
          }, ws);
          break;
        }

        // --- Start Game (Requires at least 3 players) ---
        case 'START_GAME': {
          if (!clientRoomCode) return;
          const room = rooms.get(clientRoomCode);
          if (!room) return;

          if (room.hostId !== clientPlayerId) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: 'ゲームを開始できるのはホストのみです。' }
            }));
          }

          // Strict Requirement: Minimum 3 players required to start!
          const currentCount = room.players.size;
          if (currentCount < 3) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: {
                message: `ゲームを開始するには最低3人のプレイヤーが必要です（現在: ${currentCount}/3人）`
              }
            }));
          }

          // Assign secret roles
          const playerIds = Array.from(room.players.keys());
          const roleAssignments = assignRoles(playerIds, room.rolesList);

          for (const [pid, p] of room.players.entries()) {
            p.role = roleAssignments[pid] || 'villager';
            p.isAlive = true;
          }

          room.status = 'in_game';
          room.game = {
            phase: 'night', // Start at night
            dayCount: 1,
            timerSec: 30,
            targets: {}, // role actions: werewolf -> target, seer -> target, hunter -> target
            votes: {}, // playerId -> targetId
            lastExiled: null,
            lastVictim: null,
            seerResult: null,
            winner: null
          };

          // Send game start to all with personalized role information
          for (const [pid, client] of room.sockets.entries()) {
            if (client && client.readyState === WebSocket.OPEN) {
              const myRole = roleAssignments[pid] || 'villager';
              client.send(JSON.stringify({
                type: 'GAME_STARTED',
                payload: {
                  ...getRoomSnapshot(room),
                  myRole
                }
              }));
            }
          }
          break;
        }

        // --- Game Actions (Night target, Day vote, Phase transitions) ---
        case 'GAME_ACTION': {
          if (!clientRoomCode || !clientPlayerId) return;
          const room = rooms.get(clientRoomCode);
          if (!room || !room.game) return;

          const { action, targetId } = payload;
          const p = room.players.get(clientPlayerId);
          if (!p || !p.isAlive) return;

          if (action === 'NIGHT_TARGET') {
            room.game.targets[clientPlayerId] = {
              role: p.role,
              targetId
            };

            // If Seer, compute result immediately for them
            if (p.role === 'seer' && targetId) {
              const targetPlayer = room.players.get(targetId);
              const isWolf = targetPlayer && targetPlayer.role === 'werewolf';
              ws.send(JSON.stringify({
                type: 'SEER_RESULT',
                payload: {
                  targetId,
                  targetNickname: targetPlayer ? targetPlayer.nickname : '対象',
                  isWerewolf: isWolf
                }
              }));
            }
          } else if (action === 'CAST_VOTE') {
            room.game.votes[clientPlayerId] = targetId;
            broadcastToRoom(clientRoomCode, {
              type: 'VOTE_RECORDED',
              payload: { voterId: clientPlayerId, totalVotes: Object.keys(room.game.votes).length }
            });
          } else if (action === 'NEXT_PHASE') {
            // Host or system advancing phase
            if (room.hostId === clientPlayerId) {
              handlePhaseAdvance(room);
            }
          }
          break;
        }

        // --- Top-Left Chat Messages (Max 20 chars, format: [User]: [Content]) ---
        case 'CHAT_MESSAGE': {
          if (!clientRoomCode) return;
          const room = rooms.get(clientRoomCode);
          if (!room) return;

          let rawText = String(payload.text || '').trim();
          if (!rawText) return;
          if (rawText.length > 20) {
            rawText = rawText.slice(0, 20); // Strict 20 char max
          }

          const senderName = payload.senderName || (room.players.get(clientPlayerId)?.nickname) || 'プレイヤー';
          const chatMsg = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            senderId: clientPlayerId,
            senderName,
            text: rawText,
            timestamp: Date.now()
          };

          room.chatHistory = room.chatHistory || [];
          room.chatHistory.push(chatMsg);
          if (room.chatHistory.length > 50) room.chatHistory.shift();

          // Broadcast chat message to everyone in room
          broadcastToRoom(clientRoomCode, {
            type: 'CHAT_MESSAGE',
            payload: chatMsg
          });
          break;
        }

        // --- WebRTC Audio Signaling (Mesh / P2P Audio Voice Chat) ---
        case 'WEBRTC_SIGNAL': {
          if (!clientRoomCode) return;
          const room = rooms.get(clientRoomCode);
          if (!room) return;

          const { targetId, signal } = payload;
          if (targetId) {
            // Forward signal directly to target peer
            sendToPlayer(clientRoomCode, targetId, {
              type: 'WEBRTC_SIGNAL',
              payload: {
                senderId: clientPlayerId,
                senderName: room.players.get(clientPlayerId)?.nickname || 'プレイヤー',
                signal
              }
            });
          } else {
            // Broadcast signal to everyone else
            broadcastToRoom(clientRoomCode, {
              type: 'WEBRTC_SIGNAL',
              payload: {
                senderId: clientPlayerId,
                senderName: room.players.get(clientPlayerId)?.nickname || 'プレイヤー',
                signal
              }
            }, ws);
          }
          break;
        }

        // --- Voice State Update (VC ON/OFF, Mic Muted, Speaking) ---
        case 'VOICE_STATE': {
          if (!clientRoomCode || !clientPlayerId) return;
          const room = rooms.get(clientRoomCode);
          if (!room) return;

          const p = room.players.get(clientPlayerId);
          if (p) {
            if (payload.isVcOn !== undefined) p.isVcOn = !!payload.isVcOn;
            if (payload.isMuted !== undefined) p.isMuted = !!payload.isMuted;
            if (payload.isSpeaking !== undefined) p.isSpeaking = !!payload.isSpeaking;

            broadcastToRoom(clientRoomCode, {
              type: 'VOICE_STATE_UPDATE',
              payload: {
                playerId: clientPlayerId,
                isVcOn: p.isVcOn,
                isMuted: p.isMuted,
                isSpeaking: p.isSpeaking
              }
            }, ws);
          }
          break;
        }

        case 'LEAVE_ROOM': {
          handleLeave(ws, clientRoomCode, clientPlayerId);
          clientRoomCode = null;
          clientPlayerId = null;
          break;
        }
      }
    } catch (err) {
      console.error('[WS Error]', err);
    }
  });

  ws.on('close', () => {
    handleLeave(ws, clientRoomCode, clientPlayerId);
  });
});

function handleLeave(ws, roomCode, playerId) {
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  room.sockets.delete(playerId);
  if (playerId) {
    room.players.delete(playerId);
  }

  if (room.players.size === 0) {
    rooms.delete(roomCode);
    console.log(`[jinrou-online] Room #${roomCode} closed (empty).`);
  } else {
    // Notify peers that WebRTC connection can be closed
    broadcastToRoom(roomCode, {
      type: 'PEER_LEFT',
      payload: { peerId: playerId }
    });

    if (room.hostId === playerId) {
      const nextHostId = room.players.keys().next().value;
      room.hostId = nextHostId;
      const nextHost = room.players.get(nextHostId);
      if (nextHost) {
        nextHost.isHost = true;
        room.hostNickname = nextHost.nickname;
      }
    }
    broadcastToRoom(roomCode, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(room) });
  }
}

function handlePhaseAdvance(room) {
  if (!room || !room.game) return;
  const g = room.game;
  const players = Array.from(room.players.values());

  if (g.phase === 'night') {
    // Night resolved: determine attack victim and guard
    let attackedId = null;
    let guardedId = null;

    for (const [pid, targetInfo] of Object.entries(g.targets)) {
      if (targetInfo.role === 'werewolf') {
        attackedId = targetInfo.targetId;
      } else if (targetInfo.role === 'hunter_guard') {
        guardedId = targetInfo.targetId;
      }
    }

    let victim = null;
    if (attackedId && attackedId !== guardedId) {
      victim = room.players.get(attackedId);
      if (victim) victim.isAlive = false;
    }

    g.lastVictim = victim ? { id: victim.id, nickname: victim.nickname } : null;
    g.targets = {};
    g.phase = 'discussion';
    g.timerSec = 60;

    checkWinCondition(room);
  } else if (g.phase === 'discussion') {
    // Move to voting
    g.phase = 'voting';
    g.votes = {};
    g.timerSec = 30;
  } else if (g.phase === 'voting') {
    // Tally votes
    const voteCounts = {};
    for (const targetId of Object.values(g.votes)) {
      if (targetId) voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }

    let maxVotes = 0;
    let exiledId = null;
    for (const [tId, count] of Object.entries(voteCounts)) {
      if (count > maxVotes) {
        maxVotes = count;
        exiledId = tId;
      }
    }

    const exiled = exiledId ? room.players.get(exiledId) : null;
    if (exiled) {
      exiled.isAlive = false;
    }

    g.lastExiled = exiled ? { id: exiled.id, nickname: exiled.nickname, role: exiled.role } : null;
    g.votes = {};
    g.phase = 'execution';
    g.timerSec = 10;

    checkWinCondition(room);
  } else if (g.phase === 'execution') {
    if (!g.winner) {
      g.dayCount += 1;
      g.phase = 'night';
      g.timerSec = 30;
      g.targets = {};
    }
  }

  broadcastToRoom(room.code, {
    type: 'PHASE_CHANGED',
    payload: getRoomSnapshot(room)
  });
}

function checkWinCondition(room) {
  const g = room.game;
  const alivePlayers = Array.from(room.players.values()).filter(p => p.isAlive);
  const aliveWolves = alivePlayers.filter(p => p.role === 'werewolf');
  const aliveHumans = alivePlayers.filter(p => p.role !== 'werewolf');

  if (aliveWolves.length === 0) {
    g.winner = 'villager';
    g.phase = 'game_over';
  } else if (aliveWolves.length >= aliveHumans.length) {
    g.winner = 'werewolf';
    g.phase = 'game_over';
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[jinrou-online] Server running on http://${HOST}:${PORT}`);
});
