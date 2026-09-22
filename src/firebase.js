// High-Performance Real-Time WebSocket & Online Room Manager
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
    this.reconnectTimer = null;

    this.pendingCreate = null;
    this.pendingJoin = null;

    // Cross-tab broadcast fallback for local testing
    try {
      this.channel = new BroadcastChannel('kowakowa_school_party');
      this.channel.onmessage = (e) => this.handleChannelMessage(e.data);
    } catch (e) {
      this.channel = null;
    }

    this.connectWs();
  }

  getWsUrl() {
    const customServer = typeof localStorage !== 'undefined' ? localStorage.getItem('kowakowa_ws_server') : null;
    if (customServer) {
      return customServer;
    }

    // When running on GitHub Pages (static hosting), connect to the online server
    if (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io')) {
      return 'wss://ais-pre-ccr76yifecwoho2eqvooyw-571243515947.asia-northeast1.run.app';
    }

    // Standard self-hosted / Cloud Run / dev server
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
    return `${protocol}//${host}`;
  }

  connectWs() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      const wsUrl = this.getWsUrl();
      console.log('[Kowakowa WS] Connecting to:', wsUrl);
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[Kowakowa WS] Connected successfully');
        this.isConnected = true;
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleServerMessage(msg);
        } catch (e) {
          console.error('[Kowakowa WS] Parse error:', e);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('[Kowakowa WS] Connection error:', err);
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        // Auto-reconnect after 2.5 seconds
        this.reconnectTimer = setTimeout(() => {
          this.connectWs();
        }, 2500);
      };
    } catch (e) {
      console.warn('[Kowakowa WS] Setup failed:', e);
    }
  }

  async waitForConnection(timeoutMs = 4000) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.isConnected = true;
      return true;
    }

    this.connectWs();

    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.isConnected = true;
          resolve(true);
        } else if (Date.now() - start >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, 60);
        }
      };
      check();
    });
  }

  handleServerMessage(msg) {
    const { type, payload } = msg;

    if (type === 'ROOM_CREATED') {
      this.roomCode = payload.code;
      this.isHost = true;
      this.roomData = payload;
      if (this.pendingCreate) {
        this.pendingCreate.resolve(payload.code);
        this.pendingCreate = null;
      }
      if (this.onRoomUpdate) this.onRoomUpdate(payload);
    } else if (type === 'ROOM_JOINED') {
      this.roomCode = payload.code;
      this.isHost = (payload.hostId === this.playerId);
      this.roomData = payload;
      if (this.pendingJoin) {
        this.pendingJoin.resolve(payload);
        this.pendingJoin = null;
      }
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
      const errorMsg = payload.message || '通信エラーが発生しました';
      if (this.pendingJoin) {
        this.pendingJoin.reject(new Error(errorMsg));
        this.pendingJoin = null;
      }
      if (this.pendingCreate) {
        this.pendingCreate.reject(new Error(errorMsg));
        this.pendingCreate = null;
      }
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
    const connected = await this.waitForConnection(3500);

    if (connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pendingCreate) {
            this.pendingCreate = null;
            // Fallback to offline room if server didn't respond in time
            this.createLocalFallbackRoom(item, customization);
            resolve(this.roomCode);
          }
        }, 4000);

        this.pendingCreate = {
          resolve: (code) => {
            clearTimeout(timer);
            resolve(code);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          }
        };

        this.ws.send(JSON.stringify({
          type: 'CREATE_ROOM',
          payload: {
            playerId: this.playerId,
            name: this.playerName,
            item,
            customization
          }
        }));
      });
    }

    // Offline / local fallback when server is unreachable
    console.warn('[Kowakowa] Server unreachable. Creating local room fallback.');
    this.createLocalFallbackRoom(item, customization);
    return this.roomCode;
  }

  createLocalFallbackRoom(item, customization) {
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
  }

  async joinRoom(code, item, customization) {
    const cleanCode = (code || '').trim();
    if (!cleanCode) {
      throw new Error('部屋コードを入力してください');
    }

    const connected = await this.waitForConnection(3500);
    if (!connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('サーバーに接続できませんでした。通信環境を確認してください。');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingJoin) {
          this.pendingJoin = null;
          reject(new Error('部屋への参加がタイムアウトしました。部屋コードを確認してください。'));
        }
      }, 5000);

      this.pendingJoin = {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      };

      this.ws.send(JSON.stringify({
        type: 'JOIN_ROOM',
        payload: {
          code: cleanCode,
          playerId: this.playerId,
          name: this.playerName,
          item,
          customization
        }
      }));
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.roomCode) {
      this.ws.send(JSON.stringify({
        type: 'LEAVE_ROOM',
        payload: { roomCode: this.roomCode, playerId: this.playerId }
      }));
    }
    this.roomCode = null;
    this.isHost = false;
    this.roomData = null;
    this.pendingCreate = null;
    this.pendingJoin = null;
  }
}

