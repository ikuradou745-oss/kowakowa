// High-Performance Real-Time WebSocket & Fallback Room Manager
export class RoomManager {
  constructor(localPlayerId, localPlayerName) {
    this.playerId = localPlayerId;
    this.playerName = localPlayerName;
    this.roomCode = null;
    this.isHost = false;
    this.onRoomUpdate = null;
    this.onGameStart = null;
    this.onNextStage = null;
    this.onPlayerMove = null;
    this.roomData = null;
    this.ws = null;
    this.isConnected = false;

    // Cross-tab broadcast fallback
    try {
      this.channel = new BroadcastChannel('kowakowa_school_party');
      this.channel.onmessage = (e) => this.handleChannelMessage(e.data);
    } catch (e) {
      this.channel = null;
    }

    this.connectWs();
  }

  connectWs() {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isConnected = true;
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleServerMessage(msg);
        } catch (e) {}
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        // Auto-reconnect after 2 seconds if still in room
        setTimeout(() => {
          if (this.roomCode) this.connectWs();
        }, 2000);
      };
    } catch (e) {
      console.warn('[WS] Fallback to cross-tab channel');
    }
  }

  handleServerMessage(msg) {
    const { type, payload } = msg;

    if (type === 'ROOM_CREATED') {
      this.roomCode = payload.code;
      this.isHost = true;
      this.roomData = payload;
      if (this.onRoomUpdate) this.onRoomUpdate(payload);
    } else if (type === 'ROOM_JOINED') {
      this.roomCode = payload.code;
      this.isHost = (payload.hostId === this.playerId);
      this.roomData = payload;
      if (this.onRoomUpdate) this.onRoomUpdate(payload);
    } else if (type === 'ROOM_UPDATE') {
      this.roomData = payload;
      if (this.onRoomUpdate) this.onRoomUpdate(payload);
    } else if (type === 'GAME_STARTED') {
      this.roomData = payload;
      if (this.onGameStart) this.onGameStart(payload);
    } else if (type === 'NEXT_STAGE') {
      if (this.onNextStage) this.onNextStage(payload.nextStage);
    } else if (type === 'PLAYER_MOVED') {
      if (this.onPlayerMove) this.onPlayerMove(payload.id, payload);
    } else if (type === 'ERROR') {
      alert(payload.message || 'エラーが発生しました');
    }
  }

  handleChannelMessage(data) {
    if (!data || data.roomCode !== this.roomCode) return;
    if (data.type === 'START' && this.onGameStart) {
      this.onGameStart(data);
    } else if (data.type === 'STAGE_CLEAR' && this.onNextStage) {
      this.onNextStage(data.nextStage);
    } else if (data.type === 'MOVE' && this.onPlayerMove) {
      this.onPlayerMove(data.id, data);
    }
  }

  async createRoom(item, customization) {
    const waitPromise = new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.roomCode) {
          clearInterval(check);
          resolve(this.roomCode);
        }
      }, 50);
      // Timeout fallback
      setTimeout(() => {
        clearInterval(check);
        if (!this.roomCode) {
          this.roomCode = Math.floor(1000 + Math.random() * 9000).toString();
          this.isHost = true;
          this.roomData = {
            code: this.roomCode,
            hostId: this.playerId,
            gameState: 'lobby',
            currentStage: 1,
            players: {
              [this.playerId]: {
                id: this.playerId,
                name: this.playerName,
                item,
                customization,
                isHost: true
              }
            }
          };
          resolve(this.roomCode);
        }
      }, 1000);
    });

    const sendCreate = () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'CREATE_ROOM',
          payload: {
            playerId: this.playerId,
            name: this.playerName,
            item,
            customization
          }
        }));
      }
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      sendCreate();
    } else {
      setTimeout(sendCreate, 200);
    }

    return waitPromise;
  }

  async joinRoom(code, item, customization) {
    this.roomCode = code;
    return new Promise((resolve, reject) => {
      const onJoined = (msg) => {
        if (msg.type === 'ROOM_JOINED') {
          resolve(msg.payload);
        } else if (msg.type === 'ERROR') {
          reject(new Error(msg.payload.message));
        }
      };

      const originalHandler = this.onRoomUpdate;
      this.onRoomUpdate = (data) => {
        if (originalHandler) originalHandler(data);
        resolve(data);
      };

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'JOIN_ROOM',
          payload: {
            code,
            playerId: this.playerId,
            name: this.playerName,
            item,
            customization
          }
        }));
      } else {
        reject(new Error("接続中... 少々お待ちください"));
      }

      setTimeout(() => {
        if (!this.roomData) {
          // Local fallback join
          this.roomData = {
            code,
            hostId: 'other',
            gameState: 'lobby',
            currentStage: 1,
            players: {
              [this.playerId]: {
                id: this.playerId,
                name: this.playerName,
                item,
                customization,
                isHost: false
              }
            }
          };
          resolve(this.roomData);
        }
      }, 1500);
    });
  }

  startPartyGame() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'START_GAME',
        payload: { roomCode: this.roomCode }
      }));
    }
    if (this.channel) {
      this.channel.postMessage({ type: 'START', roomCode: this.roomCode });
    }
  }

  notifyStageClear(nextStage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'STAGE_CLEAR',
        payload: { roomCode: this.roomCode, nextStage }
      }));
    }
    if (this.channel) {
      this.channel.postMessage({ type: 'STAGE_CLEAR', roomCode: this.roomCode, nextStage });
    }
  }

  updatePosition(x, z, y, rotation, isHidden, isDead, isCrouching, currentStage) {
    if (!this.roomCode) return;
    const payload = { x, z, y, rotation, isHidden, isDead, isCrouching, currentStage };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'PLAYER_MOVE',
        payload
      }));
    }
    if (this.channel) {
      this.channel.postMessage({ type: 'MOVE', roomCode: this.roomCode, id: this.playerId, ...payload });
    }
  }

  updateCustomization(customization) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'UPDATE_CUSTOM',
        payload: { customization }
      }));
    }
  }

  leaveRoom() {
    this.roomCode = null;
    this.isHost = false;
    this.roomData = null;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}
