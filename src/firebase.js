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

// User Profile Helpers
export async function savePlayerProfile(playerId, nickname, vcVolume = 100, coins = 500, unlockedRoles = []) {
  if (!playerId || !nickname) return;
  try {
    const userRef = doc(db, "players", playerId);
    await setDoc(userRef, {
      nickname: nickname.trim(),
      vcVolume: Number(vcVolume) || 100,
      coins: typeof coins === 'number' ? coins : 500,
      unlockedRoles: Array.isArray(unlockedRoles) ? unlockedRoles : [],
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn("[Firebase] Could not save player profile to cloud:", err);
  }
}

export async function fetchPlayerProfile(playerId) {
  if (!playerId) return null;
  try {
    const userRef = doc(db, "players", playerId);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      return snap.data();
    }
  } catch (err) {
    console.warn("[Firebase] Could not fetch player profile:", err);
  }
  return null;
}

// Online Werewolf Room Management Helpers
export async function createFirestoreRoom(roomCode, hostId, hostNickname) {
  try {
    const roomRef = doc(db, "jinrou_rooms", roomCode);
    const roomData = {
      code: roomCode,
      hostId,
      status: "waiting", // waiting | in_game | finished
      phase: "day", // day | vote | night
      dayCount: 1,
      createdAt: serverTimestamp(),
      players: {
        [hostId]: {
          id: hostId,
          nickname: hostNickname,
          isHost: true,
          role: null,
          isAlive: true,
          joinedAt: Date.now()
        }
      }
    };
    await setDoc(roomRef, roomData);
    return roomData;
  } catch (err) {
    console.warn("[Firebase] create room notice:", err);
    return null;
  }
}

export async function joinFirestoreRoom(roomCode, playerId, playerNickname) {
  try {
    const roomRef = doc(db, "jinrou_rooms", roomCode);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) {
      throw new Error("部屋が見つかりませんでした");
    }
    const data = snap.data();
    if (data.status !== "waiting") {
      throw new Error("この部屋は既にゲームが開始されています");
    }
    const playerEntries = Object.keys(data.players || {});
    if (playerEntries.length >= 15) {
      throw new Error("部屋が満員です（最大15名）");
    }

    const updatedPlayers = {
      ...(data.players || {}),
      [playerId]: {
        id: playerId,
        nickname: playerNickname,
        isHost: false,
        role: null,
        isAlive: true,
        joinedAt: Date.now()
      }
    };

    await updateDoc(roomRef, {
      players: updatedPlayers
    });

    return { ...data, players: updatedPlayers };
  } catch (err) {
    console.warn("[Firebase] join room error:", err);
    throw err;
  }
}

export function subscribeToRoom(roomCode, onUpdate, onError) {
  try {
    const roomRef = doc(db, "jinrou_rooms", roomCode);
    return onSnapshot(roomRef, (docSnap) => {
      if (docSnap.exists()) {
        onUpdate(docSnap.data());
      } else {
        if (onError) onError(new Error("部屋が削除されました"));
      }
    }, (error) => {
      console.warn("[Firebase] room subscription error:", error);
      if (onError) onError(error);
    });
  } catch (err) {
    console.warn("[Firebase] subscribeToRoom notice:", err);
    return () => {};
  }
}

export async function leaveFirestoreRoom(roomCode, playerId) {
  try {
    const roomRef = doc(db, "jinrou_rooms", roomCode);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return;
    const data = snap.data();
    const players = { ...(data.players || {}) };
    delete players[playerId];

    if (Object.keys(players).length === 0) {
      await deleteDoc(roomRef);
    } else {
      let hostId = data.hostId;
      if (hostId === playerId) {
        // Transfer host to first remaining player
        const remainingIds = Object.keys(players);
        hostId = remainingIds[0];
        players[hostId].isHost = true;
      }
      await updateDoc(roomRef, {
        hostId,
        players
      });
    }
  } catch (err) {
    console.warn("[Firebase] leave room notice:", err);
  }
}
