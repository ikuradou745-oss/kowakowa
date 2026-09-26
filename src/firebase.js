import { initializeApp, getApps, getApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs,
  onSnapshot, 
  serverTimestamp,
  updateDoc,
  deleteDoc,
  getDocFromServer
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize Firebase App
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore with the provisioned database ID
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Test connection on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.warn("[Firebase] Client is offline or check configuration.");
    }
  }
}
testConnection();

// Standard Error Handler
export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: true,
      tenantId: null,
      providerInfo: []
    },
    operationType,
    path
  };
  console.warn('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

// Local In-Memory & Storage Fallback for Instant Zero-Lag Reliability
const localRoomsMemory = new Map();

// Cross-tab broadcast channel for local peer sync
let roomBroadcastChannel = null;
if (typeof window !== "undefined" && window.BroadcastChannel) {
  try {
    roomBroadcastChannel = new BroadcastChannel("jinrou_rooms_channel");
  } catch (e) {
    roomBroadcastChannel = null;
  }
}

// Helper: safe promise with timeout so Firebase never freezes the UI
function withTimeout(promise, ms = 2500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
  ]);
}

// Helper: sync room state to localStorage
export function saveRoomLocally(roomData) {
  if (!roomData || !roomData.code) return;
  localRoomsMemory.set(roomData.code, roomData);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(`jinrou_room_${roomData.code}`, JSON.stringify(roomData));
    } catch (e) {}
  }
  if (roomBroadcastChannel) {
    try {
      roomBroadcastChannel.postMessage({ type: "ROOM_UPDATED", room: roomData });
    } catch (e) {}
  }
}

// Helper: retrieve room from local cache
export function getRoomLocally(code) {
  if (localRoomsMemory.has(code)) return localRoomsMemory.get(code);
  if (typeof localStorage !== "undefined") {
    try {
      const saved = localStorage.getItem(`jinrou_room_${code}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        localRoomsMemory.set(code, parsed);
        return parsed;
      }
    } catch (e) {}
  }
  return null;
}

// User Profile Helpers
export async function savePlayerProfile(playerId, nickname, vcVolume = 100, coins = 0, unlockedRoles = []) {
  if (!playerId || !nickname) return;
  try {
    const userRef = doc(db, "players", playerId);
    await setDoc(userRef, {
      nickname: nickname.trim(),
      vcVolume: Number(vcVolume) || 100,
      coins: typeof coins === 'number' ? coins : 0,
      unlockedRoles: Array.isArray(unlockedRoles) ? unlockedRoles : [],
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `players/${playerId}`);
  }
}

export async function fetchPlayerProfile(playerId) {
  if (!playerId) return null;
  try {
    const userRef = doc(db, "players", playerId);
    const snap = await getDoc(userRef);
    if (snap && snap.exists()) {
      return snap.data();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `players/${playerId}`);
  }
  return null;
}

// --- Online Werewolf Room Management Helpers ---

export async function createFirestoreRoom(roomCode, hostId, hostNickname, settings = {}) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃]/, '').trim();
  const maxPlayers = Number(settings.maxPlayers) || 5;
  const roleMode = settings.roleMode || 'normal';
  const rolesConfig = settings.rolesConfig || {};
  const rolesList = settings.rolesList || [];
  const discussionTime = Number(settings.discussionTime) || 60;

  const roomData = {
    code: cleanCode,
    hostId,
    hostNickname,
    maxPlayers,
    discussionTime,
    roleMode,
    rolesConfig,
    rolesList,
    status: "waiting", // waiting | in_game | finished
    phase: "day", // day | vote | night
    dayCount: 1,
    createdAt: Date.now(),
    players: {
      [hostId]: {
        id: hostId,
        nickname: hostNickname,
        isHost: true,
        isLeader: true,
        role: null,
        isAlive: true,
        isVcOn: true,
        isMuted: false,
        isSpeaking: false,
        joinedAt: Date.now()
      }
    }
  };

  // 1. Immediately store in local memory & storage so UI is INSTANTANEOUS
  saveRoomLocally(roomData);

  // 2. Synchronously notify Express server API
  try {
    await fetch('/api/jinrou/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomData)
    });
  } catch (e) {
    console.warn("[Server Sync] Notice on room create:", e.message);
  }

  // 3. Save to Firebase Firestore
  try {
    const roomRef = doc(db, "jinrou_rooms", cleanCode);
    await setDoc(roomRef, {
      ...roomData,
      createdAt: serverTimestamp()
    });
    console.log("[Firebase] Room created successfully in Firestore:", cleanCode);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `jinrou_rooms/${cleanCode}`);
  }

  return roomData;
}

export async function joinFirestoreRoom(roomCode, playerId, playerNickname, isVcOn = true) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃]/, '').trim();
  let roomData = null;

  // 1. Check Firebase Firestore directly first
  try {
    const roomRef = doc(db, "jinrou_rooms", cleanCode);
    const snap = await withTimeout(getDoc(roomRef), 2000);
    if (snap && snap.exists()) {
      roomData = snap.data();
    }
  } catch (e) {
    handleFirestoreError(e, OperationType.GET, `jinrou_rooms/${cleanCode}`);
  }

  // 2. Check Express server API if not found or offline
  if (!roomData) {
    try {
      const res = await withTimeout(fetch(`/api/jinrou/rooms/${cleanCode}`), 1500);
      if (res.ok) {
        roomData = await res.json();
      }
    } catch (e) {}
  }

  // 3. Fallback: check local cache
  if (!roomData) {
    roomData = getRoomLocally(cleanCode);
  }

  if (!roomData) {
    throw new Error(`部屋（#${cleanCode}）が見つかりませんでした。コードをご確認ください。`);
  }

  if (roomData.status !== "waiting") {
    throw new Error("この部屋は既にゲームが開始されているか、終了しています。");
  }

  const playerEntries = Object.keys(roomData.players || {});
  const maxAllowed = roomData.maxPlayers || 12;
  if (playerEntries.length >= maxAllowed && !roomData.players[playerId]) {
    throw new Error(`部屋が満員です（定員: ${maxAllowed}人）`);
  }

  const updatedPlayers = {
    ...(roomData.players || {}),
    [playerId]: {
      id: playerId,
      nickname: playerNickname,
      isHost: (roomData.hostId === playerId),
      isLeader: (roomData.hostId === playerId),
      role: null,
      isAlive: true,
      isVcOn: isVcOn !== false,
      isMuted: false,
      isSpeaking: false,
      joinedAt: Date.now()
    }
  };

  const updatedRoom = {
    ...roomData,
    players: updatedPlayers
  };

  // Save locally
  saveRoomLocally(updatedRoom);

  // Sync to Express Server API
  try {
    fetch(`/api/jinrou/rooms/${cleanCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, playerNickname, isVcOn, roomData: updatedRoom })
    }).catch(() => {});
  } catch (e) {}

  // Sync to Firebase Firestore
  try {
    const roomRef = doc(db, "jinrou_rooms", cleanCode);
    await setDoc(roomRef, {
      players: updatedPlayers
    }, { merge: true });
    console.log("[Firebase] Player joined room in Firestore:", cleanCode);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `jinrou_rooms/${cleanCode}`);
  }

  return updatedRoom;
}

export async function fetchActiveFirestoreRooms() {
  const roomsList = [];
  try {
    const q = collection(db, "jinrou_rooms");
    const snapshot = await withTimeout(getDocs(q), 2500);
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data && data.code && data.status !== 'finished') {
        const count = data.players ? Object.keys(data.players).length : 0;
        roomsList.push({
          code: data.code,
          hostNickname: data.hostNickname || 'ホスト',
          playerCount: count,
          maxPlayers: data.maxPlayers || 5,
          roleMode: data.roleMode || 'normal',
          discussionTime: data.discussionTime || 60,
          status: data.status || 'waiting'
        });
      }
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, "jinrou_rooms");
  }
  return roomsList;
}

export function subscribeToRoom(roomCode, onUpdate, onError) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃]/, '').trim();
  let isUnsubscribed = false;

  // 1. Initial fire from local cache
  const initialLocal = getRoomLocally(cleanCode);
  if (initialLocal) {
    onUpdate(initialLocal);
  }

  // 2. Listen to cross-tab BroadcastChannel
  const handleBroadcast = (evt) => {
    if (isUnsubscribed) return;
    if (evt.data && evt.data.type === "ROOM_UPDATED" && evt.data.room && evt.data.room.code === cleanCode) {
      onUpdate(evt.data.room);
    }
  };

  if (roomBroadcastChannel) {
    roomBroadcastChannel.addEventListener("message", handleBroadcast);
  }

  // 3. Periodic poll from Express server API
  const pollTimer = setInterval(async () => {
    if (isUnsubscribed) return;
    try {
      const res = await fetch(`/api/jinrou/rooms/${cleanCode}`);
      if (res.ok) {
        const data = await res.json();
        saveRoomLocally(data);
        onUpdate(data);
      }
    } catch (e) {}
  }, 2000);

  // 4. Firestore onSnapshot real-time subscription
  let firestoreUnsub = () => {};
  try {
    const roomRef = doc(db, "jinrou_rooms", cleanCode);
    firestoreUnsub = onSnapshot(roomRef, (docSnap) => {
      if (isUnsubscribed) return;
      if (docSnap.exists()) {
        const data = docSnap.data();
        saveRoomLocally(data);
        onUpdate(data);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `jinrou_rooms/${cleanCode}`);
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `jinrou_rooms/${cleanCode}`);
  }

  return () => {
    isUnsubscribed = true;
    clearInterval(pollTimer);
    if (roomBroadcastChannel) {
      roomBroadcastChannel.removeEventListener("message", handleBroadcast);
    }
    if (typeof firestoreUnsub === "function") {
      firestoreUnsub();
    }
  };
}

export async function leaveFirestoreRoom(roomCode, playerId) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃]/, '').trim();
  const room = getRoomLocally(cleanCode);
  if (room && room.players) {
    delete room.players[playerId];
    if (Object.keys(room.players).length === 0) {
      localRoomsMemory.delete(cleanCode);
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(`jinrou_room_${cleanCode}`);
      }
    } else {
      if (room.hostId === playerId) {
        const remaining = Object.keys(room.players);
        room.hostId = remaining[0];
        room.players[remaining[0]].isHost = true;
        room.players[remaining[0]].isLeader = true;
      }
      saveRoomLocally(room);
    }
  }

  // Call Express API
  try {
    fetch(`/api/jinrou/rooms/${cleanCode}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
    }).catch(() => {});
  } catch (e) {}

  // Call Firestore
  try {
    const roomRef = doc(db, "jinrou_rooms", cleanCode);
    const snap = await getDoc(roomRef);
    if (snap && snap.exists()) {
      const data = snap.data();
      const players = { ...(data.players || {}) };
      delete players[playerId];
      if (Object.keys(players).length === 0) {
        await deleteDoc(roomRef);
      } else {
        let hostId = data.hostId;
        if (hostId === playerId) {
          const remainingIds = Object.keys(players);
          hostId = remainingIds[0];
          players[hostId].isHost = true;
          players[hostId].isLeader = true;
        }
        await updateDoc(roomRef, { hostId, players });
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `jinrou_rooms/${cleanCode}`);
  }
}
