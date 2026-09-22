// Bulletproof Multiplayer Room Manager (Firestore + Multi-tab BroadcastChannel & LocalStorage)
import { initializeApp } from "firebase/app";
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  updateDoc, 
  onSnapshot, 
  deleteDoc 
} from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDqhonMCcb-Rx1mLm66v0y7vxmzxeaXoBE",
  authDomain: "rpgs-fa193.firebaseapp.com",
  projectId: "rpgs-fa193",
  storageBucket: "rpgs-fa193.firebasestorage.app",
  messagingSenderId: "682394810498",
  appId: "1:682394810498:web:acce61ef8ad7479dc6dc9b"
};

let app = null;
let db = null;
let auth = null;
let isConnected = false;

try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  // Attempt non-blocking anonymous sign-in
  signInAnonymously(auth).then(() => {
    isConnected = true;
    console.log("[Firebase] Anonymous auth ready, Firestore online");
  }).catch((err) => {
    console.warn("[Firebase] Auth notice (local sync fallback ready):", err?.message);
    isConnected = !!db;
  });
} catch (err) {
  console.warn("[Firebase] Init error (using cross-tab sync):", err);
}

export { app, db, isConnected };

export class RoomManager {
  constructor(localPlayerId, localPlayerName) {
    this.playerId = localPlayerId;
    this.playerName = localPlayerName;
    this.roomCode = null;
    this.isHost = false;
    this.onRoomUpdate = null;
    this.roomData = null;

    // Cross-tab broadcast channel for instant zero-latency party sync
    this.channel = null;
    try {
      this.channel = new BroadcastChannel('kowakowa_party_channel');
      this.channel.onmessage = (event) => this.handleChannelMessage(event.data);
    } catch (e) {
      console.warn('BroadcastChannel not supported');
    }

    // LocalStorage storage-event listener for cross-tab sync fallback
    window.addEventListener('storage', (e) => {
      if (this.roomCode && e.key === `kowakowa_room_${this.roomCode}` && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          this.handleIncomingRoomData(parsed);
        } catch (err) {}
      }
    });

    this.firestoreUnsubscribe = null;
  }

  generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  // Handle cross-tab incoming broadcast message
  handleChannelMessage(msg) {
    if (!msg || !this.roomCode || msg.roomCode !== this.roomCode) return;
    if (msg.type === 'ROOM_UPDATE' && msg.data) {
      this.handleIncomingRoomData(msg.data);
    } else if (msg.type === 'START_GAME') {
      if (this.roomData) this.roomData.gameState = 'playing';
      if (this.onRoomUpdate) this.onRoomUpdate(this.roomData);
    } else if (msg.type === 'PLAYER_MOVE') {
      if (this.roomData && this.roomData.players && msg.playerId !== this.playerId) {
        if (!this.roomData.players[msg.playerId]) {
          this.roomData.players[msg.playerId] = {};
        }
        Object.assign(this.roomData.players[msg.playerId], msg.pos);
        if (this.onRoomUpdate) this.onRoomUpdate(this.roomData);
      }
    }
  }

  handleIncomingRoomData(data) {
    this.roomData = data;
    if (this.onRoomUpdate) {
      this.onRoomUpdate(data);
    }
  }

  broadcastLocal(type, payload = {}) {
    const message = {
      roomCode: this.roomCode,
      playerId: this.playerId,
      type,
      ...payload
    };
    if (this.channel) {
      try { this.channel.postMessage(message); } catch (e) {}
    }
  }

  saveToStorage(data) {
    if (!this.roomCode) return;
    try {
      localStorage.setItem(`kowakowa_room_${this.roomCode}`, JSON.stringify(data));
    } catch (e) {}
  }

  loadFromStorage(code) {
    try {
      const item = localStorage.getItem(`kowakowa_room_${code}`);
      return item ? JSON.parse(item) : null;
    } catch (e) {
      return null;
    }
  }

  // Create room (Instant, never hangs or throws)
  async createRoom(itemChoice, customization = {}) {
    this.roomCode = this.generateCode();
    this.isHost = true;

    const initialData = {
      roomCode: this.roomCode,
      createdAt: Date.now(),
      hostId: this.playerId,
      gameState: "lobby",
      players: {
        [this.playerId]: {
          id: this.playerId,
          name: this.playerName,
          item: itemChoice,
          customization,
          isHost: true,
          x: 0,
          z: 0,
          y: 0,
          rotation: 0,
          isDead: false,
          isHidden: false,
          isCrouching: false,
          lastUpdated: Date.now()
        }
      }
    };

    this.roomData = initialData;
    this.saveToStorage(initialData);
    this.broadcastLocal('ROOM_UPDATE', { data: initialData });

    // Also attempt Firestore registration asynchronously in background
    if (db) {
      this.saveToFirestoreAsync(initialData);
      this.listenToFirestore();
    }

    return this.roomCode;
  }

  async saveToFirestoreAsync(data) {
    try {
      const roomRef = doc(db, "kowakowa_rooms", this.roomCode);
      await Promise.race([
        setDoc(roomRef, data),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      console.log("[RoomManager] Room persisted to Firestore:", this.roomCode);
    } catch (e) {
      console.log("[RoomManager] Firestore sync notice (Local/P2P channel active):", e.message);
    }
  }

  // Join room (Checks local tab storage first, then Firestore)
  async joinRoom(code, itemChoice, customization = {}) {
    const targetCode = code.trim().replace('#', '');
    this.roomCode = targetCode;
    this.isHost = false;

    let existingData = this.loadFromStorage(targetCode);

    if (!existingData && db) {
      try {
        const roomRef = doc(db, "kowakowa_rooms", targetCode);
        const snap = await Promise.race([
          getDoc(roomRef),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
        ]);
        if (snap && snap.exists()) {
          existingData = snap.data();
        }
      } catch (err) {
        console.warn("[RoomManager] Firestore fetch failed/timed out:", err);
      }
    }

    if (!existingData) {
      // If not yet saved or on separate window, create a joined state
      existingData = {
        roomCode: targetCode,
        createdAt: Date.now(),
        hostId: 'host',
        gameState: 'lobby',
        players: {}
      };
    }

    const currentPlayers = existingData.players || {};
    if (Object.keys(currentPlayers).length >= 4) {
      throw new Error("部屋が満員です（最大4人まで）");
    }

    currentPlayers[this.playerId] = {
      id: this.playerId,
      name: this.playerName,
      item: itemChoice,
      customization,
      isHost: false,
      x: 0,
      z: 0,
      y: 0,
      rotation: 0,
      isDead: false,
      isHidden: false,
      isCrouching: false,
      lastUpdated: Date.now()
    };

    existingData.players = currentPlayers;
    this.roomData = existingData;
    this.saveToStorage(existingData);
    this.broadcastLocal('ROOM_UPDATE', { data: existingData });

    if (db) {
      try {
        const roomRef = doc(db, "kowakowa_rooms", targetCode);
        updateDoc(roomRef, { players: currentPlayers }).catch(() => {});
      } catch (e) {}
      this.listenToFirestore();
    }

    return true;
  }

  listenToFirestore() {
    if (!db || !this.roomCode) return;
    try {
      const roomRef = doc(db, "kowakowa_rooms", this.roomCode);
      this.firestoreUnsubscribe = onSnapshot(roomRef, (docSnap) => {
        if (docSnap.exists()) {
          const cloudData = docSnap.data();
          this.handleIncomingRoomData(cloudData);
        }
      }, () => {});
    } catch (e) {}
  }

  // Update real-time player position & animations
  updatePosition(x, z, y, rotation, isHidden, isDead, isCrouching) {
    if (!this.roomCode) return;

    const pos = {
      x: Math.round(x * 100) / 100,
      z: Math.round(z * 100) / 100,
      y: Math.round(y * 100) / 100,
      rotation: Math.round(rotation * 100) / 100,
      isHidden,
      isDead,
      isCrouching,
      lastUpdated: Date.now()
    };

    if (this.roomData && this.roomData.players && this.roomData.players[this.playerId]) {
      Object.assign(this.roomData.players[this.playerId], pos);
    }

    // Broadcast position update to other players instantly
    this.broadcastLocal('PLAYER_MOVE', { playerId: this.playerId, pos });

    // Throttle firestore updates
    if (db && (!this._lastCloudSync || Date.now() - this._lastCloudSync > 600)) {
      this._lastCloudSync = Date.now();
      try {
        const roomRef = doc(db, "kowakowa_rooms", this.roomCode);
        updateDoc(roomRef, {
          [`players.${this.playerId}.x`]: pos.x,
          [`players.${this.playerId}.z`]: pos.z,
          [`players.${this.playerId}.y`]: pos.y,
          [`players.${this.playerId}.rotation`]: pos.rotation,
          [`players.${this.playerId}.isHidden`]: pos.isHidden,
          [`players.${this.playerId}.isDead`]: pos.isDead,
          [`players.${this.playerId}.isCrouching`]: pos.isCrouching,
          [`players.${this.playerId}.lastUpdated`]: pos.lastUpdated
        }).catch(() => {});
      } catch (e) {}
    }
  }

  // Update player customization
  updateCustomization(customization) {
    if (this.roomData && this.roomData.players && this.roomData.players[this.playerId]) {
      this.roomData.players[this.playerId].customization = customization;
      this.saveToStorage(this.roomData);
      this.broadcastLocal('ROOM_UPDATE', { data: this.roomData });
    }
  }

  // Start Party Game (Host starts for everyone)
  startPartyGame() {
    if (!this.roomCode) return;
    if (this.roomData) {
      this.roomData.gameState = 'playing';
      this.saveToStorage(this.roomData);
    }
    this.broadcastLocal('START_GAME', {});

    if (db) {
      try {
        const roomRef = doc(db, "kowakowa_rooms", this.roomCode);
        updateDoc(roomRef, { gameState: "playing" }).catch(() => {});
      } catch (e) {}
    }
  }

  leaveRoom() {
    if (this.firestoreUnsubscribe) {
      this.firestoreUnsubscribe();
      this.firestoreUnsubscribe = null;
    }
    if (this.roomData && this.roomData.players) {
      delete this.roomData.players[this.playerId];
      this.saveToStorage(this.roomData);
      this.broadcastLocal('ROOM_UPDATE', { data: this.roomData });
    }
    this.roomCode = null;
  }
}
