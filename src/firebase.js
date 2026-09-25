import { initializeApp, getApps, getApp } from "firebase/app";
import { getAnalytics, isSupported as isAnalyticsSupported } from "firebase/analytics";
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  serverTimestamp,
  updateDoc,
  deleteDoc
} from "firebase/firestore";

// Web app's Firebase configuration provided by user
const firebaseConfig = {
  apiKey: "AIzaSyDqhonMCcb-Rx1mLm66v0y7vxmzxeaXoBE",
  authDomain: "rpgs-fa193.firebaseapp.com",
  projectId: "rpgs-fa193",
  storageBucket: "rpgs-fa193.firebasestorage.app",
  messagingSenderId: "682394810498",
  appId: "1:682394810498:web:acce61ef8ad7479dc6dc9b",
  measurementId: "G-YFNKWHC5MZ"
};

// Initialize Firebase App
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore
export const db = getFirestore(app);

// Initialize Analytics (safely guarded for browser environments)
export let analytics = null;
if (typeof window !== "undefined") {
  isAnalyticsSupported().then((supported) => {
    if (supported) {
      try {
        analytics = getAnalytics(app);
      } catch (err) {
        console.warn("[Firebase Analytics] init notice:", err);
      }
    }
  }).catch(() => {});
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
function withTimeout(promise, ms = 1200) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
  ]);
}

// Helper: sync room state to localStorage
function saveRoomLocally(roomData) {
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
function getRoomLocally(code) {
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
    await withTimeout(setDoc(userRef, {
      nickname: nickname.trim(),
      vcVolume: Number(vcVolume) || 100,
      coins: typeof coins === 'number' ? coins : 0,
      unlockedRoles: Array.isArray(unlockedRoles) ? unlockedRoles : [],
      updatedAt: serverTimestamp()
    }, { merge: true }), 1000);
  } catch (err) {
    // Non-blocking warning
    console.warn("[Firebase] Could not save player profile to cloud:", err.message);
  }
}

export async function fetchPlayerProfile(playerId) {
  if (!playerId) return null;
  try {
    const userRef = doc(db, "players", playerId);
    const snap = await withTimeout(getDoc(userRef), 1000);
    if (snap && snap.exists()) {
      return snap.data();
    }
  } catch (err) {
    console.warn("[Firebase] Could not fetch player profile:", err.message);
  }
  return null;
}

// --- Online Werewolf Room Management Helpers ---

export async function createFirestoreRoom(roomCode, hostId, hostNickname, settings = {}) {
  const maxPlayers = Number(settings.maxPlayers) || 5;
  const roleMode = settings.roleMode || 'normal';
  const rolesConfig = settings.rolesConfig || {};
  const rolesList = settings.rolesList || [];

  const roomData = {
    code: roomCode,
    hostId,
    hostNickname,
    maxPlayers,
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
        joinedAt: Date.now()
      }
    }
  };

  // 1. Immediately store in local memory & storage so UI is INSTANTANEOUS
  saveRoomLocally(roomData);

  // 2. Asynchronously sync to local Express server API if running
  try {
    fetch('/api/jinrou/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomData)
    }).catch(() => {});
  } catch (e) {}

  // 3. Sync to Firebase Firestore in the background (fire-and-forget with timeout safeguard)
  try {
    const roomRef = doc(db, "jinrou_rooms", roomCode);
    withTimeout(setDoc(roomRef, {
      ...roomData,
      createdAt: serverTimestamp()
    }), 3000)
      .then(() => console.log("[Firebase] Room created successfully in Firestore:", roomCode))
      .catch((err) => console.warn("[Firebase] Firestore sync notice (hybrid mode active):", err.message));
  } catch (err) {
    console.warn("[Firebase] Firestore sync notice:", err);
  }

  // Return immediately so the user transitions to the lobby in 0ms!
  return roomData;
}

export async function joinFirestoreRoom(roomCode, playerId, playerNickname) {
  let roomData = null;

  // 1. Check local cache
  roomData = getRoomLocally(roomCode);

  // 2. Check Express server API if local not found or outdated
  if (!roomData) {
    try {
      const res = await withTimeout(fetch(`/api/jinrou/rooms/${roomCode}`), 1000);
      if (res.ok) {
        roomData = await res.json();
      }
    } catch (e) {}
  }

  // 3. Check Firestore
  if (!roomData) {
    try {
      const roomRef = doc(db, "jinrou_rooms", roomCode);
      const snap = await withTimeout(getDoc(roomRef), 1200);
      if (snap && snap.exists()) {
        roomData = snap.data();
      }
    } catch (e) {}
  }

  if (!roomData) {
    throw new Error(`部屋（#${roomCode}）が見つかりませんでした。コードをご確認ください。`);
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
      joinedAt: Date.now()
    }
  };

  const updatedRoom = {
    ...roomData,
    players: updatedPlayers
  };

  // Save locally
  saveRoomLocally(updatedRoom);

  // Sync to Express server API
  try {
    fetch(`/api/jinrou/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, playerNickname })
    }).catch(() => {});
  } catch (e) {}

  // Sync to Firestore (non-blocking)
  try {
    const roomRef = doc(db, "jinrou_rooms", roomCode);
    withTimeout(updateDoc(roomRef, {
      players: updatedPlayers
    }), 1200).catch(() => {});
  } catch (e) {}

  return updatedRoom;
}

export function subscribeToRoom(roomCode, onUpdate, onError) {
  let isUnsubscribed = false;

  // 1. Initial fire from local cache
  const initialLocal = getRoomLocally(roomCode);
  if (initialLocal) {
    onUpdate(initialLocal);
  }

  // 2. Listen to cross-tab BroadcastChannel
  const handleBroadcast = (evt) => {
    if (isUnsubscribed) return;
    if (evt.data && evt.data.type === "ROOM_UPDATED" && evt.data.room && evt.data.room.code === roomCode) {
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
      const res = await fetch(`/api/jinrou/rooms/${roomCode}`);
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
    const roomRef = doc(db, "jinrou_rooms", roomCode);
    firestoreUnsub = onSnapshot(roomRef, (docSnap) => {
      if (isUnsubscribed) return;
      if (docSnap.exists()) {
        const data = docSnap.data();
        saveRoomLocally(data);
        onUpdate(data);
      }
    }, (error) => {
      console.warn("[Firebase] Firestore subscription notice (using local/server sync):", error.message);
    });
  } catch (err) {
    console.warn("[Firebase] onSnapshot setup notice:", err);
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
  const room = getRoomLocally(roomCode);
  if (room && room.players) {
    delete room.players[playerId];
    if (Object.keys(room.players).length === 0) {
      localRoomsMemory.delete(roomCode);
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(`jinrou_room_${roomCode}`);
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
    fetch(`/api/jinrou/rooms/${roomCode}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
    }).catch(() => {});
  } catch (e) {}

  // Call Firestore
  try {
    const roomRef = doc(db, "jinrou_rooms", roomCode);
    const snap = await withTimeout(getDoc(roomRef), 1000);
    if (snap && snap.exists()) {
      const data = snap.data();
      const players = { ...(data.players || {}) };
      delete players[playerId];
      if (Object.keys(players).length === 0) {
        deleteDoc(roomRef).catch(() => {});
      } else {
        let hostId = data.hostId;
        if (hostId === playerId) {
          const remainingIds = Object.keys(players);
          hostId = remainingIds[0];
          players[hostId].isHost = true;
          players[hostId].isLeader = true;
        }
        updateDoc(roomRef, { hostId, players }).catch(() => {});
      }
    }
  } catch (err) {
    // Non-blocking
  }
}
