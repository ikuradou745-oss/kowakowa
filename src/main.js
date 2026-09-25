import { WerewolfAudio } from './audio.js';
import { VoiceManager } from './voice.js';
import { 
  savePlayerProfile, 
  fetchPlayerProfile, 
  createFirestoreRoom, 
  joinFirestoreRoom, 
  leaveFirestoreRoom,
  subscribeToRoom 
} from './firebase.js';

// --- State Variables ---
const sound = new WerewolfAudio();

// Use sessionStorage so each tab/window in the same browser has its own independent player ID,
// enabling multiple players on the same machine/browser without ID conflicts!
let localPlayerId = sessionStorage.getItem('jinrou_player_id');
if (!localPlayerId) {
  localPlayerId = 'usr_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
  sessionStorage.setItem('jinrou_player_id', localPlayerId);
}
// Keep localStorage player ID synced as fallback
localStorage.setItem('jinrou_player_id', localPlayerId);

let localNickname = sessionStorage.getItem('jinrou_nickname') || localStorage.getItem('jinrou_nickname') || '';
let vcVolume = parseInt(localStorage.getItem('jinrou_vc_volume'), 10);
if (isNaN(vcVolume) || vcVolume < 50 || vcVolume > 500) {
  vcVolume = 100;
}
sound.setVcVolume(vcVolume);

// Coin System (Initial 0, test add coins removed)
let userCoins = parseInt(localStorage.getItem('jinrou_coins'), 10);
if (isNaN(userCoins) || userCoins < 0 || userCoins === 500) {
  userCoins = 0;
  localStorage.setItem('jinrou_coins', '0');
}

// Unlocked Roles System
let unlockedRoles = [];
try {
  const saved = localStorage.getItem('jinrou_unlocked_roles');
  unlockedRoles = saved ? JSON.parse(saved) : [];
} catch (e) {
  unlockedRoles = [];
}

// Active Room & Game State
let activeRoomCode = null;
let isHost = false;
let currentRoomData = null;
let mySecretRole = null;

// Room Creation Settings
let createRoomPlayerCount = 5;
let createRoomDiscussionTime = 60; // 10s to 90s, default 60s (1 min)
let createRoomMode = 'normal'; // 'normal' | 'original'
let originalRolesConfig = {
  werewolf: 1,
  traitor: 1,
  villager: 1,
  seer: 1,
  hunter_guard: 1,
  medium: 0,
  mayor: 0,
  medic: 0,
  hunter_avenger: 0,
  archer: 0
};

// --- Roles Definitions ---
const BASE_ROLES = [
  {
    id: 'werewolf',
    name: '人狼',
    icon: '🐺',
    camp: 'werewolf',
    campName: '人狼チーム',
    desc: '人狼チーム。夜の間に村人チームを襲撃して殺害できる。自分が追放されたら負け。',
    winCondition: '市民チームの生存者を2人以下に追い込む'
  },
  {
    id: 'villager',
    name: '村人',
    icon: '🧑‍🌾',
    camp: 'villager',
    campName: '村人チーム',
    desc: '村人チーム。特殊能力はありませんが、昼の議論と投票で人狼を見つけ出し追放を目指します。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'medium',
    name: '霊媒師',
    icon: '🕯️',
    camp: 'villager',
    campName: '村人チーム',
    desc: '村人チーム。追放された人の役職が夜のターンにわかる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'seer',
    name: '占い師',
    icon: '🔮',
    camp: 'villager',
    campName: '村人チーム',
    desc: '村人チーム。夜の時に誰か1人が人狼か村人陣営かを占える。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'hunter_guard',
    name: '狩人',
    icon: '🛡️',
    camp: 'villager',
    campName: '村人チーム',
    desc: '村人チーム。人狼が動く前に誰か1人を守ることができる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'traitor',
    name: '裏切り者',
    icon: '🎭',
    camp: 'werewolf',
    campName: '人狼チーム',
    desc: '人狼チーム。人狼が誰かは分かりませんが、人狼チームの勝利を目指して村を混乱させます。',
    winCondition: '人狼チームが勝利する'
  }
];

const SHOP_ROLES = [
  {
    id: 'mayor',
    name: '村長',
    icon: '🎖️',
    cost: 100,
    camp: 'villager',
    campName: '村人チーム',
    desc: '死亡時に裏切り者が誰かが暴かれます。村の指導者。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'medic',
    name: 'メディ',
    icon: '💉',
    cost: 300,
    camp: 'villager',
    campName: '村人チーム',
    desc: '2日目以降の夜のターンに一度だけ味方を一人復活できる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'hunter_avenger',
    name: 'ハンター',
    icon: '🎯',
    cost: 100,
    camp: 'villager',
    campName: '村人チーム',
    desc: '自分が死亡した時に誰か一人を道連れにして死亡させることができる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'archer',
    name: 'アーチャー',
    icon: '🏹',
    cost: 200,
    camp: 'villager',
    campName: '村人チーム',
    desc: '夜のターンに一度だけ誰かを狙撃（殺害）できる。',
    winCondition: 'すべての人狼を追放する'
  }
];

const ALL_ROLES_MAP = {};
BASE_ROLES.forEach(r => { ALL_ROLES_MAP[r.id] = r; });
SHOP_ROLES.forEach(r => { ALL_ROLES_MAP[r.id] = r; });

const WEREWOLF_TEAM_ROLE_IDS = ['werewolf', 'traitor'];

// Normal preset generation
function getNormalRolesConfig(count) {
  const c = Math.max(3, Math.min(12, count));
  if (c === 3) return { werewolf: 1, seer: 1, villager: 1 };
  if (c === 4) return { werewolf: 1, seer: 1, hunter_guard: 1, villager: 1 };
  if (c === 5) return { werewolf: 1, traitor: 1, seer: 1, hunter_guard: 1, villager: 1 };
  if (c === 6) return { werewolf: 2, seer: 1, hunter_guard: 1, medium: 1, villager: 1 };
  if (c === 7) return { werewolf: 2, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, villager: 1 };
  if (c === 8) return { werewolf: 2, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, villager: 2 };
  if (c === 9) return { werewolf: 2, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, mayor: 1, villager: 2 };
  if (c === 10) return { werewolf: 3, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, hunter_avenger: 1, villager: 2 };
  if (c === 11) return { werewolf: 3, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, medic: 1, villager: 3 };
  return { werewolf: 3, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, archer: 1, medic: 1, villager: 3 };
}

function expandRolesList(config) {
  const list = [];
  for (const [rId, cnt] of Object.entries(config)) {
    for (let i = 0; i < cnt; i++) list.push(rId);
  }
  return list;
}

// --- DOM References ---
const topNicknameChip = document.getElementById('topNicknameChip');
const topNicknameText = document.getElementById('topNicknameText');
const topCoinsChip = document.getElementById('topCoinsChip');
const topCoinsDisplay = document.getElementById('topCoinsDisplay');
const btnOpenSettings = document.getElementById('btnOpenSettings');

// Modals
const initialNicknameModal = document.getElementById('initialNicknameModal');
const initialNicknameInput = document.getElementById('initialNicknameInput');
const initialCharCounter = document.getElementById('initialCharCounter');
const initialErrorMsg = document.getElementById('initialErrorMsg');
const btnConfirmInitialNickname = document.getElementById('btnConfirmInitialNickname');

const settingsModal = document.getElementById('settingsModal');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnFinishSettings = document.getElementById('btnFinishSettings');
const settingsNicknameInput = document.getElementById('settingsNicknameInput');
const settingsCharCounter = document.getElementById('settingsCharCounter');
const settingsErrorMsg = document.getElementById('settingsErrorMsg');
const btnSaveNickname = document.getElementById('btnSaveNickname');
const vcVolumeSlider = document.getElementById('vcVolumeSlider');
const vcVolumeDisplay = document.getElementById('vcVolumeDisplay');
const btnTestVolume = document.getElementById('btnTestVolume');
const presetPills = document.querySelectorAll('.preset-pill[data-preset]');

const btnSettingsVcOn = document.getElementById('btnSettingsVcOn');
const btnSettingsVcOff = document.getElementById('btnSettingsVcOff');
const btnSettingsMicOn = document.getElementById('btnSettingsMicOn');
const btnSettingsMicOff = document.getElementById('btnSettingsMicOff');

// Main Menu Actions
const btnOnlinePlay = document.getElementById('btnOnlinePlay');
const btnRoleGuide = document.getElementById('btnRoleGuide');
const btnOpenShop = document.getElementById('btnOpenShop');

// Role Guide & Shop
const roleGuideModal = document.getElementById('roleGuideModal');
const btnCloseRoleGuide = document.getElementById('btnCloseRoleGuide');
const btnFinishRoleGuide = document.getElementById('btnFinishRoleGuide');
const rolesList = document.getElementById('rolesList');
const tabRoleAll = document.getElementById('tabRoleAll');
const tabRoleVillager = document.getElementById('tabRoleVillager');
const tabRoleWerewolf = document.getElementById('tabRoleWerewolf');
const tabRoleShop = document.getElementById('tabRoleShop');

const shopModal = document.getElementById('shopModal');
const btnCloseShop = document.getElementById('btnCloseShop');
const btnFinishShop = document.getElementById('btnFinishShop');
const shopCoinsDisplay = document.getElementById('shopCoinsDisplay');
const shopItemsList = document.getElementById('shopItemsList');

// Online Play Views
const onlinePlayModal = document.getElementById('onlinePlayModal');
const btnCloseOnlinePlay = document.getElementById('btnCloseOnlinePlay');
const onlineHubView = document.getElementById('onlineHubView');
const onlineCreateRoomView = document.getElementById('onlineCreateRoomView');
const onlineLobbyView = document.getElementById('onlineLobbyView');
const btnCardCreateRoom = document.getElementById('btnCardCreateRoom');
const btnCardShowJoinInput = document.getElementById('btnCardShowJoinInput');
const joinRoomForm = document.getElementById('joinRoomForm');
const roomCodeInput = document.getElementById('roomCodeInput');
const btnJoinRoomSubmit = document.getElementById('btnJoinRoomSubmit');
const joinRoomErrorMsg = document.getElementById('joinRoomErrorMsg');

// Create Room Settings
const roomPlayerCountSlider = document.getElementById('roomPlayerCountSlider');
const playerCountDisplay = document.getElementById('playerCountDisplay');
const roomDiscussionTimeSlider = document.getElementById('roomDiscussionTimeSlider');
const discussionTimeDisplay = document.getElementById('discussionTimeDisplay');
const btnModeNormal = document.getElementById('btnModeNormal');
const btnModeOriginal = document.getElementById('btnModeOriginal');
const normalModeContainer = document.getElementById('normalModeContainer');
const normalRolesPreviewList = document.getElementById('normalRolesPreviewList');
const originalModeContainer = document.getElementById('originalModeContainer');
const originalRolesSteppersList = document.getElementById('originalRolesSteppersList');
const originalValidationBox = document.getElementById('originalValidationBox');
const originalTotalCountNotice = document.getElementById('originalTotalCountNotice');
const originalRatioNotice = document.getElementById('originalRatioNotice');
const btnConfirmCreateRoom = document.getElementById('btnConfirmCreateRoom');
const btnCancelCreateRoom = document.getElementById('btnCancelCreateRoom');

// Lobby View
const lobbyRoomCodeText = document.getElementById('lobbyRoomCodeText');
const btnCopyRoomCode = document.getElementById('btnCopyRoomCode');
const lobbyPlayerCount = document.getElementById('lobbyPlayerCount');
const lobbyPlayerMax = document.getElementById('lobbyPlayerMax');
const lobbyPlayerRoster = document.getElementById('lobbyPlayerRoster');
const btnLobbyStartGame = document.getElementById('btnLobbyStartGame');
const btnLeaveRoom = document.getElementById('btnLeaveRoom');
const btnInviteShare = document.getElementById('btnInviteShare');
const lobbyInvitePreviewText = document.getElementById('lobbyInvitePreviewText');
const lobbyMinPlayerWarning = document.getElementById('lobbyMinPlayerWarning');
const lobbyMinPlayerNoticeText = document.getElementById('lobbyMinPlayerNoticeText');

const btnLobbyVcToggle = document.getElementById('btnLobbyVcToggle');
const lobbyVcIcon = document.getElementById('lobbyVcIcon');
const lobbyVcLabel = document.getElementById('lobbyVcLabel');
const btnLobbyMicToggle = document.getElementById('btnLobbyMicToggle');
const lobbyMicIcon = document.getElementById('lobbyMicIcon');
const lobbyMicLabel = document.getElementById('lobbyMicLabel');
const lobbySpeakingRing = document.getElementById('lobbySpeakingRing');

// Top-Left Chat
const topLeftChatContainer = document.getElementById('topLeftChatContainer');
const chatModeBadge = document.getElementById('chatModeBadge');
const chatModeText = document.getElementById('chatModeText');
const btnChatToggle = document.getElementById('btnChatToggle');
const chatExpandableArea = document.getElementById('chatExpandableArea');
const chatMessagesBox = document.getElementById('chatMessagesBox');
const chatInput = document.getElementById('chatInput');
const chatCharCounter = document.getElementById('chatCharCounter');
const btnSendChat = document.getElementById('btnSendChat');

// Role Announcement Modal
const roleAnnouncementModal = document.getElementById('roleAnnouncementModal');
const revealRoleIcon = document.getElementById('revealRoleIcon');
const revealRoleName = document.getElementById('revealRoleName');
const revealRoleBadge = document.getElementById('revealRoleBadge');
const revealRoleDesc = document.getElementById('revealRoleDesc');
const revealRoleWinCondition = document.getElementById('revealRoleWinCondition');
const btnConfirmMyRole = document.getElementById('btnConfirmMyRole');

// Game View
const gameView = document.getElementById('gameView');
const gameDayCountText = document.getElementById('gameDayCountText');
const gamePhaseBadge = document.getElementById('gamePhaseBadge');
const gamePhaseIcon = document.getElementById('gamePhaseIcon');
const gamePhaseText = document.getElementById('gamePhaseText');
const gameCutsceneBanner = document.getElementById('gameCutsceneBanner');
const cutsceneTitle = document.getElementById('cutsceneTitle');
const cutsceneBody = document.getElementById('cutsceneBody');
const myRoleCampBadge = document.getElementById('myRoleCampBadge');
const myRoleIcon = document.getElementById('myRoleIcon');
const myRoleName = document.getElementById('myRoleName');
const myRoleDesc = document.getElementById('myRoleDesc');
const gameActionPrompt = document.getElementById('gameActionPrompt');
const gamePlayersGrid = document.getElementById('gamePlayersGrid');
const btnHostNextPhase = document.getElementById('btnHostNextPhase');
const btnReturnToLobby = document.getElementById('btnReturnToLobby');
const btnGameVcToggle = document.getElementById('btnGameVcToggle');
const btnGameMicToggle = document.getElementById('btnGameMicToggle');
const gameVcLabel = document.getElementById('gameVcLabel');
const gameMicLabel = document.getElementById('gameMicLabel');

const globalToast = document.getElementById('globalToast');

// --- Voice Manager (WebRTC) ---
const voiceManager = new VoiceManager({
  onSpeakingChange: (isSpeaking) => updateSpeakingIndicators(localPlayerId, isSpeaking),
  onPeerVoiceState: (peerId, voiceState) => updateSpeakingIndicators(peerId, voiceState.isSpeaking),
  onRemoteTrack: (peerId, stream) => {},
  onLog: (msg) => showToast(msg)
});
voiceManager.setVolume(vcVolume);

// --- WebSocket Connection ---
let socket = null;

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[WS] Connected');
      if (activeRoomCode) {
        socket.send(JSON.stringify({
          type: 'JOIN_ROOM',
          payload: {
            code: activeRoomCode,
            playerId: localPlayerId,
            nickname: localNickname,
            isVcOn: voiceManager.isVcEnabled
          }
        }));
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSocketMessage(msg);
      } catch (e) {}
    };

    socket.onclose = () => setTimeout(initWebSocket, 2000);

    voiceManager.setSignalSender((signalMsg) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(signalMsg));
      }
    }, localPlayerId, activeRoomCode);
  } catch (err) {}
}
initWebSocket();

function sendWs(type, payload) {
  const msgStr = JSON.stringify({ type, payload });
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(msgStr); } catch (e) {}
    return;
  }
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    socket.addEventListener('open', () => {
      try { socket.send(msgStr); } catch (e) {}
    }, { once: true });
    return;
  }
  initWebSocket();
  if (socket) {
    socket.addEventListener('open', () => {
      try { socket.send(msgStr); } catch (e) {}
    }, { once: true });
  }
}

function handleSocketMessage(msg) {
  const { type, payload } = msg;

  switch (type) {
    case 'ROOM_CREATED':
    case 'ROOM_JOINED':
    case 'ROOM_UPDATE': {
      currentRoomData = payload;
      updateLobbyUI(payload);
      break;
    }
    case 'PEER_JOINED': {
      if (payload.peerId !== localPlayerId) {
        voiceManager.handlePeerJoined(payload.peerId, true);
        appendChatMessage('システム', `「${payload.nickname || 'プレイヤー'}」が入室しました`, 'system');
      }
      break;
    }
    case 'PEER_LEFT': {
      if (payload.peerId !== localPlayerId) {
        voiceManager.handlePeerLeft(payload.peerId);
      }
      break;
    }
    case 'WEBRTC_SIGNAL': {
      voiceManager.handleSignal(payload.senderId, payload.signal);
      break;
    }
    case 'VOICE_STATE_UPDATE': {
      updateSpeakingIndicators(payload.playerId, payload.isSpeaking);
      break;
    }
    case 'CHAT_MESSAGE': {
      appendChatMessage(payload.senderName, payload.text, payload.senderId === localPlayerId ? 'me' : 'other');
      break;
    }
    case 'GAME_STARTED': {
      currentRoomData = payload;
      mySecretRole = payload.myRole || 'villager';
      showRoleAnnouncement(mySecretRole, payload);
      break;
    }
    case 'TIMER_TICK': {
      if (currentRoomData && currentRoomData.game) {
        currentRoomData.game.timerSec = payload.timerSec;
        updateTimerBadge(payload.timerSec);
      }
      break;
    }
    case 'PHASE_CHANGED': {
      currentRoomData = payload;
      updateGamePhaseUI(payload);
      break;
    }
    case 'SEER_RESULT': {
      sound.playSuccess();
      const verdict = payload.isWerewolf ? '【人狼】🐺' : '【村人陣営】🧑‍🌾';
      showToast(`🔮 占い結果: ${payload.targetNickname} さんは ${verdict} です！`);
      appendChatMessage('占い結果', `${payload.targetNickname}さんは${verdict}でした`, 'system');
      break;
    }
    case 'MEDIUM_RESULT': {
      sound.playSuccess();
      const verdict = payload.isWerewolf ? '【人狼】🐺' : '【村人陣営】🧑‍🌾';
      showToast(`🕯️ 霊媒結果: 追放された ${payload.exiledNickname} さんは ${verdict} でした！`);
      appendChatMessage('霊媒結果', `${payload.exiledNickname}さんは${verdict}でした`, 'system');
      break;
    }
    case 'ACTION_CONFIRMED': {
      sound.playClick();
      showToast('行動を選択しました');
      break;
    }
    case 'ERROR': {
      showToast(payload.message || 'エラー');
      break;
    }
  }
}

// --- Helper Functions ---
function showToast(msg) {
  if (!globalToast) return;
  globalToast.textContent = msg;
  globalToast.classList.add('show');
  clearTimeout(globalToast._timer);
  globalToast._timer = setTimeout(() => globalToast.classList.remove('show'), 2800);
}

function openModal(modal) { if (modal) modal.classList.add('active'); }
function closeModal(modal) { if (modal) modal.classList.remove('active'); }

function validateNickname(name) {
  const trimmed = (name || '').trim();
  return trimmed.length >= 2 && trimmed.length <= 8;
}

function applyNickname(nick) {
  localNickname = nick.trim();
  localStorage.setItem('jinrou_nickname', localNickname);
  topNicknameText.textContent = localNickname;
  scheduleProfileSync();
}

function updateCoinsDisplay() {
  topCoinsDisplay.textContent = userCoins;
  shopCoinsDisplay.textContent = userCoins;
  localStorage.setItem('jinrou_coins', userCoins.toString());
}

function updateVcVolumeUI(vol) {
  vcVolume = Math.max(50, Math.min(500, vol));
  localStorage.setItem('jinrou_vc_volume', vcVolume.toString());
  vcVolumeSlider.value = vcVolume;
  vcVolumeDisplay.textContent = vcVolume;
  sound.setVcVolume(vcVolume);
  voiceManager.setVolume(vcVolume);
  presetPills.forEach(pill => {
    pill.classList.toggle('active', parseInt(pill.getAttribute('data-preset'), 10) === vcVolume);
  });
}

function scheduleProfileSync() {
  if (!localPlayerId || !localNickname) return;
  savePlayerProfile(localPlayerId, localNickname, vcVolume, userCoins, unlockedRoles);
}

// --- Top-Left Chat ---
function appendChatMessage(senderName, text, type = 'other') {
  const item = document.createElement('div');
  item.className = 'chat-message-item';
  const isMe = type === 'me';
  const isSys = type === 'system';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'chat-sender-name' + (isMe ? ' is-me' : isSys ? ' is-system' : '');
  nameSpan.textContent = `${senderName}:`;

  const textSpan = document.createElement('span');
  textSpan.className = 'chat-content-text';
  textSpan.textContent = ` ${text}`;

  item.appendChild(nameSpan);
  item.appendChild(textSpan);
  chatMessagesBox.appendChild(item);
  chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
}

function sendCurrentChat() {
  let val = (chatInput.value || '').trim();
  if (!val) return;
  if (val.length > 20) val = val.slice(0, 20); // strict 20 chars

  if (activeRoomCode) {
    sendWs('CHAT_MESSAGE', {
      roomCode: activeRoomCode,
      senderId: localPlayerId,
      senderName: localNickname,
      text: val
    });
  } else {
    appendChatMessage(localNickname || '自分', val, 'me');
  }

  chatInput.value = '';
  chatCharCounter.textContent = '0/20';
}

chatInput.addEventListener('input', (e) => {
  let val = e.target.value;
  if (val.length > 20) {
    e.target.value = val.slice(0, 20);
    val = e.target.value;
  }
  chatCharCounter.textContent = `${val.length}/20`;
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendCurrentChat();
});
btnSendChat.addEventListener('click', sendCurrentChat);

btnChatToggle.addEventListener('click', () => {
  if (chatExpandableArea.style.display === 'none') {
    chatExpandableArea.style.display = 'block';
    btnChatToggle.textContent = '▼';
  } else {
    chatExpandableArea.style.display = 'none';
    btnChatToggle.textContent = '▲';
  }
});

// --- VC & Mic Control Functions ---
function setVcState(enabled) {
  voiceManager.setVcEnabled(enabled);
  if (enabled) {
    chatModeBadge.className = 'chat-mode-badge vc-on';
    chatModeBadge.innerHTML = '<span>🎙️</span><span>VC: ON (通話可能)</span>';
    lobbyVcIcon.textContent = '🔊';
    lobbyVcLabel.textContent = 'VC: ON';
    btnLobbyVcToggle.classList.add('active');
    btnLobbyVcToggle.classList.remove('muted');
    if (gameVcLabel) gameVcLabel.textContent = '🔊 VC: ON';
  } else {
    chatModeBadge.className = 'chat-mode-badge vc-off';
    chatModeBadge.innerHTML = '<span>💬</span><span>チャットモード (VC: OFF)</span>';
    lobbyVcIcon.textContent = '🔇';
    lobbyVcLabel.textContent = 'VC: OFF';
    btnLobbyVcToggle.classList.remove('active');
    btnLobbyVcToggle.classList.add('muted');
    if (gameVcLabel) gameVcLabel.textContent = '🔇 VC: OFF';
    chatExpandableArea.style.display = 'block';
    btnChatToggle.textContent = '▼';
    chatInput.focus();
  }
  btnSettingsVcOn.style.background = enabled ? 'var(--emerald-light)' : '#f1f5f9';
  btnSettingsVcOff.style.background = !enabled ? 'var(--sky-light)' : '#f1f5f9';
}

function setMicState(muted) {
  voiceManager.setMicMuted(muted);
  if (muted) {
    lobbyMicIcon.textContent = '🔇';
    lobbyMicLabel.textContent = 'マイク: OFF';
    btnLobbyMicToggle.classList.remove('active');
    btnLobbyMicToggle.classList.add('muted');
    if (gameMicLabel) gameMicLabel.textContent = '🔇 マイクOFF';
  } else {
    lobbyMicIcon.textContent = '🎙️';
    lobbyMicLabel.textContent = 'マイク: ON';
    btnLobbyMicToggle.classList.add('active');
    btnLobbyMicToggle.classList.remove('muted');
    if (gameMicLabel) gameMicLabel.textContent = '🎙️ マイクON';
  }
  btnSettingsMicOn.style.background = !muted ? 'var(--emerald-light)' : '#f1f5f9';
  btnSettingsMicOff.style.background = muted ? 'var(--crimson-light)' : '#f1f5f9';
}

btnLobbyVcToggle.addEventListener('click', () => setVcState(!voiceManager.isVcEnabled));
btnLobbyMicToggle.addEventListener('click', () => setMicState(!voiceManager.isMicMuted));
if (btnGameVcToggle) btnGameVcToggle.addEventListener('click', () => setVcState(!voiceManager.isVcEnabled));
if (btnGameMicToggle) btnGameMicToggle.addEventListener('click', () => setMicState(!voiceManager.isMicMuted));

btnSettingsVcOn.addEventListener('click', () => setVcState(true));
btnSettingsVcOff.addEventListener('click', () => setVcState(false));
btnSettingsMicOn.addEventListener('click', () => setMicState(false));
btnSettingsMicOff.addEventListener('click', () => setMicState(true));

function updateSpeakingIndicators(playerId, isSpeaking) {
  if (playerId === localPlayerId && lobbySpeakingRing) {
    lobbySpeakingRing.classList.toggle('speaking', isSpeaking);
  }
  const rosterItem = document.getElementById(`roster_${playerId}`);
  if (rosterItem) {
    const ring = rosterItem.querySelector('.speaking-indicator-ring');
    if (ring) ring.classList.toggle('speaking', isSpeaking);
  }
  const gameCard = document.getElementById(`game_player_${playerId}`);
  if (gameCard) {
    gameCard.classList.toggle('speaking', isSpeaking);
  }
}

// --- Create Room Settings (Fix: Mode switch, Role Preview, Discussion Time 10~90s) ---
function updateCreateRoomUI() {
  playerCountDisplay.textContent = `${createRoomPlayerCount}人`;
  discussionTimeDisplay.textContent = `${createRoomDiscussionTime}秒 (${Math.floor(createRoomDiscussionTime / 60)}分${createRoomDiscussionTime % 60 ? (createRoomDiscussionTime % 60) + '秒' : ''})`;

  if (createRoomMode === 'normal') {
    normalModeContainer.style.display = 'block';
    originalModeContainer.style.display = 'none';
    btnModeNormal.classList.add('active');
    btnModeOriginal.classList.remove('active');

    // Populate normal roles preview
    const preset = getNormalRolesConfig(createRoomPlayerCount);
    normalRolesPreviewList.innerHTML = '';
    for (const [rId, cnt] of Object.entries(preset)) {
      if (cnt > 0 && ALL_ROLES_MAP[rId]) {
        const r = ALL_ROLES_MAP[rId];
        const chip = document.createElement('div');
        chip.className = 'role-preview-chip';
        chip.innerHTML = `<span>${r.icon}</span> <span>${r.name}</span> <strong style="color: var(--crimson);">× ${cnt}</strong>`;
        normalRolesPreviewList.appendChild(chip);
      }
    }
    btnConfirmCreateRoom.disabled = false;
  } else {
    normalModeContainer.style.display = 'none';
    originalModeContainer.style.display = 'block';
    btnModeNormal.classList.remove('active');
    btnModeOriginal.classList.add('active');

    renderOriginalSteppers();
    validateOriginalRoles();
  }
}

function renderOriginalSteppers() {
  originalRolesSteppersList.innerHTML = '';
  const availableRoles = [...BASE_ROLES, ...SHOP_ROLES.filter(r => unlockedRoles.includes(r.id))];

  availableRoles.forEach(r => {
    const count = originalRolesConfig[r.id] || 0;
    const isWolf = WEREWOLF_TEAM_ROLE_IDS.includes(r.id);

    const item = document.createElement('div');
    item.className = 'role-stepper-item';
    item.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 1.2rem;">${r.icon}</span>
        <span style="font-weight: 800; font-size: 0.9rem;">${r.name}</span>
        <span class="role-badge ${isWolf ? 'werewolf' : 'villager'}" style="font-size: 0.65rem;">
          ${isWolf ? '人狼' : '市民'}
        </span>
      </div>
      <div class="role-stepper-ctrl">
        <button class="btn-stepper btn-minus" data-id="${r.id}">−</button>
        <span class="stepper-count" id="count_${r.id}">${count}</span>
        <button class="btn-stepper btn-plus" data-id="${r.id}">＋</button>
      </div>
    `;

    item.querySelector('.btn-minus').addEventListener('click', () => {
      sound.playClick();
      if ((originalRolesConfig[r.id] || 0) > 0) {
        originalRolesConfig[r.id]--;
        document.getElementById(`count_${r.id}`).textContent = originalRolesConfig[r.id];
        validateOriginalRoles();
      }
    });

    item.querySelector('.btn-plus').addEventListener('click', () => {
      sound.playClick();
      originalRolesConfig[r.id] = (originalRolesConfig[r.id] || 0) + 1;
      document.getElementById(`count_${r.id}`).textContent = originalRolesConfig[r.id];
      validateOriginalRoles();
    });

    originalRolesSteppersList.appendChild(item);
  });
}

function validateOriginalRoles() {
  let total = 0;
  let wolfTeam = 0;
  for (const [rId, c] of Object.entries(originalRolesConfig)) {
    total += c;
    if (WEREWOLF_TEAM_ROLE_IDS.includes(rId)) wolfTeam += c;
  }

  const citizenTeam = total - wolfTeam;
  const ratio = total > 0 ? wolfTeam / total : 0;
  const target = createRoomPlayerCount;

  const isCountValid = total === target;
  const isRatioValid = wolfTeam >= 1 && ratio >= 0.12 && ratio <= 0.4;
  const isValid = isCountValid && isRatioValid;

  originalTotalCountNotice.textContent = `合計役職数: ${total} / ${target}人 ${isCountValid ? '✅' : '⚠️ 定員に合わせてください'}`;

  const wolfPercent = Math.round(ratio * 100);
  const citizenPercent = 100 - wolfPercent;

  if (!isRatioValid) {
    originalRatioNotice.innerHTML = `⚠️ 陣営比率: 人狼陣営 ${wolfTeam}人 : 市民陣営 ${citizenTeam}人 (${wolfPercent}% : ${citizenPercent}%)<br><span style="font-size: 0.72rem; opacity: 0.9;">※ 人狼チームと市民チームの比率が約 <strong>2 : 8</strong> になるようにしてください</span>`;
    originalValidationBox.className = 'ratio-indicator-box invalid';
    btnConfirmCreateRoom.disabled = true;
  } else {
    originalRatioNotice.innerHTML = `✅ 陣営比率: 人狼陣営 ${wolfTeam}人 : 市民陣営 ${citizenTeam}人 (${wolfPercent}% : ${citizenPercent}%) 良好！`;
    originalValidationBox.className = 'ratio-indicator-box valid';
    btnConfirmCreateRoom.disabled = !isCountValid;
  }
}

roomPlayerCountSlider.addEventListener('input', (e) => {
  createRoomPlayerCount = parseInt(e.target.value, 10);
  updateCreateRoomUI();
});

roomDiscussionTimeSlider.addEventListener('input', (e) => {
  createRoomDiscussionTime = parseInt(e.target.value, 10);
  updateCreateRoomUI();
});

btnModeNormal.addEventListener('click', () => {
  sound.playClick();
  createRoomMode = 'normal';
  updateCreateRoomUI();
});

btnModeOriginal.addEventListener('click', () => {
  sound.playClick();
  createRoomMode = 'original';
  const normalPreset = getNormalRolesConfig(createRoomPlayerCount);
  originalRolesConfig = {
    werewolf: normalPreset.werewolf || 1,
    traitor: normalPreset.traitor || 0,
    villager: normalPreset.villager || 0,
    seer: normalPreset.seer || 0,
    hunter_guard: normalPreset.hunter_guard || 0,
    medium: normalPreset.medium || 0,
    mayor: 0,
    medic: 0,
    hunter_avenger: 0,
    archer: 0
  };
  updateCreateRoomUI();
});

// --- Lobby View ---
function updateLobbyUI(room) {
  if (!room) return;
  activeRoomCode = room.code;
  lobbyRoomCodeText.textContent = `#${room.code}`;

  const players = Object.values(room.players || {});
  const playerCount = players.length;
  const maxPlayers = room.maxPlayers || 5;

  lobbyPlayerCount.textContent = playerCount;
  lobbyPlayerMax.textContent = maxPlayers;

  const hostNick = room.hostNickname || localNickname;
  lobbyInvitePreviewText.textContent = `https://ikuradou745-oss.github.io/zinnrou/
${hostNick}が呼んでるよ！参加コードは${room.code}だよ！`;

  lobbyPlayerRoster.innerHTML = '';
  players.forEach((p) => {
    const isMe = p.id === localPlayerId;
    const row = document.createElement('div');
    row.className = 'lobby-player-item';
    row.id = `roster_${p.id}`;
    row.innerHTML = `
      <div class="lobby-player-info">
        <span class="speaking-indicator-ring ${p.isSpeaking ? 'speaking' : ''}"></span>
        <span>👤 ${p.nickname}</span>
        ${p.isHost ? '<span style="font-size: 0.7rem; background: var(--crimson-light); color: var(--crimson); font-weight: 800; padding: 2px 6px; border-radius: 4px;">ホスト</span>' : ''}
        ${isMe ? '<span style="font-size: 0.7rem; color: var(--sky); font-weight: 800;">(あなた)</span>' : ''}
      </div>
      <div class="lobby-player-voice-status">
        <span>${!p.isVcOn ? '🔇(VC切)' : p.isMuted ? '🔇(消音)' : '🎙️'}</span>
      </div>
    `;
    lobbyPlayerRoster.appendChild(row);
  });

  // Strict Rule: Minimum 3 players required to start!
  const isMeHost = (room.hostId === localPlayerId);
  if (isMeHost) {
    btnLobbyStartGame.style.display = 'block';
    if (playerCount < 3) {
      btnLobbyStartGame.disabled = true;
      btnLobbyStartGame.textContent = `最低3人必要 (現在: ${playerCount}/3人)`;
      lobbyMinPlayerWarning.style.display = 'flex';
      lobbyMinPlayerNoticeText.textContent = `ゲームを開始するには最低3人のプレイヤーが必要です（現在: ${playerCount}/3人）`;
    } else {
      btnLobbyStartGame.disabled = false;
      btnLobbyStartGame.textContent = `🐺 ゲームを開始する (${playerCount}人)`;
      lobbyMinPlayerWarning.style.display = 'none';
    }
  } else {
    btnLobbyStartGame.style.display = 'none';
    if (playerCount < 3) {
      lobbyMinPlayerWarning.style.display = 'flex';
      lobbyMinPlayerNoticeText.textContent = `ホストがゲームを開始するまで待機中... (現在: ${playerCount}/3人 - 最低3人必要)`;
    } else {
      lobbyMinPlayerWarning.style.display = 'none';
    }
  }
}

let lobbyUnsubscribe = null;

function enterLobbyView(roomCode, roomData) {
  onlineHubView.style.display = 'none';
  onlineCreateRoomView.style.display = 'none';
  onlineLobbyView.style.display = 'block';

  topLeftChatContainer.style.display = 'block';
  chatExpandableArea.style.display = 'block';

  voiceManager.setSignalSender((msg) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }, localPlayerId, roomCode);

  if (voiceManager.isVcEnabled) {
    voiceManager.initLocalAudio();
  }

  updateLobbyUI(roomData);

  // Setup backup sync listener to ensure state stays 100% in sync
  if (lobbyUnsubscribe) {
    try { lobbyUnsubscribe(); } catch (e) {}
    lobbyUnsubscribe = null;
  }
  lobbyUnsubscribe = subscribeToRoom(roomCode, (updatedRoom) => {
    if (updatedRoom && activeRoomCode === roomCode) {
      currentRoomData = updatedRoom;
      updateLobbyUI(updatedRoom);
    }
  });
}

// Start Game from Lobby
btnLobbyStartGame.addEventListener('click', () => {
  const currentCount = currentRoomData ? Object.keys(currentRoomData.players || {}).length : 1;
  if (currentCount < 3) {
    sound.playClick();
    showToast(`⚠️ 最低3人いないとゲームを開始できません（現在: ${currentCount}/3人）`);
    return;
  }
  sound.playWolfHowl();
  showToast('🐺 役職を配り、ゲームを開始します...');
  sendWs('START_GAME', { roomCode: activeRoomCode, playerId: localPlayerId });
});

// --- Role Announcement Phase (ユーザー要望: 最初は自分の役職が言い渡され、その後に試合スタート) ---
function showRoleAnnouncement(roleId, room) {
  closeModal(onlinePlayModal);
  const r = ALL_ROLES_MAP[roleId] || BASE_ROLES[1];

  revealRoleIcon.textContent = r.icon;
  revealRoleName.textContent = r.name;
  revealRoleDesc.textContent = r.desc;
  revealRoleWinCondition.textContent = r.winCondition;
  revealRoleBadge.textContent = r.campName;
  revealRoleBadge.className = 'role-badge ' + (r.camp === 'werewolf' ? 'werewolf' : 'villager');

  openModal(roleAnnouncementModal);
  sound.playWolfHowl();

  btnConfirmMyRole.onclick = () => {
    sound.playSuccess();
    closeModal(roleAnnouncementModal);
    gameView.style.display = 'flex';
    myRoleName.textContent = r.name;
    myRoleIcon.textContent = r.icon;
    myRoleDesc.textContent = r.desc;
    myRoleCampBadge.textContent = r.campName;
    myRoleCampBadge.className = 'role-badge ' + (r.camp === 'werewolf' ? 'werewolf' : 'villager');
    updateGamePhaseUI(room);
  };
}

// --- In-Game Screen Phase Updates ---
function updateTimerBadge(timerSec) {
  if (!currentRoomData || !currentRoomData.game) return;
  const g = currentRoomData.game;
  const phase = g.phase;

  if (phase === 'morning_discussion') {
    gamePhaseText.textContent = `朝の話し合い (残り${timerSec}秒)`;
  } else if (phase === 'morning_voting') {
    gamePhaseText.textContent = `追放投票タイム (残り${timerSec}秒)`;
  } else if (phase === 'morning_execution') {
    gamePhaseText.textContent = `追放結果発表 (残り${timerSec}秒)`;
  } else if (phase.startsWith('night_')) {
    gamePhaseText.textContent = `${g.phaseTitle || '夜の行動'} (残り${timerSec}秒)`;
  } else if (phase === 'morning_result') {
    gamePhaseText.textContent = `昨夜の結果発表 (残り${timerSec}秒)`;
  } else if (phase === 'hunter_revenge') {
    gamePhaseText.textContent = `ハンター道連れ選択 (残り${timerSec}秒)`;
  }
}

function updateGamePhaseUI(room) {
  if (!room || !room.game) return;
  const g = room.game;
  gameDayCountText.textContent = `${g.dayCount || 1}日目`;

  // Update Dramatic Cutscene Banners & Audio
  if (g.phase === 'morning_discussion') {
    sound.playBellSound ? sound.playBellSound() : sound.playClick();
    gamePhaseIcon.textContent = '☀️';
    gamePhaseBadge.className = 'game-phase-badge day';
    cutsceneTitle.textContent = `☀️ ${g.dayCount}日目の朝が来ました`;
    cutsceneBody.innerHTML = `朝の話し合いタイムです。VCまたは左上のチャットで話し合ってください。<br><strong style="color: var(--crimson);">※ 話し合い終了後、怪しい人物を追放投票します。</strong>`;
    gameActionPrompt.textContent = '👥 参加者一覧 (話し合い中):';
  } else if (g.phase === 'morning_voting') {
    sound.playClick();
    gamePhaseIcon.textContent = '🗳️';
    gamePhaseBadge.className = 'game-phase-badge voting';
    cutsceneTitle.textContent = '🗳️ 追放投票タイム';
    cutsceneBody.textContent = '怪しいと思うプレイヤーを1人選んで投票してください。最も票を集めたプレイヤーが追放されます。';
    gameActionPrompt.textContent = '🗳️ 追放したいプレイヤーを選択:';
  } else if (g.phase === 'morning_execution') {
    sound.playExileSound ? sound.playExileSound() : sound.playWolfHowl();
    gamePhaseIcon.textContent = '⚖️';
    gamePhaseBadge.className = 'game-phase-badge voting';
    const exiled = g.lastExiled;
    if (exiled) {
      cutsceneTitle.textContent = `⚖️ 審判の結果:「${exiled.nickname}」が追放されました`;
      cutsceneBody.innerHTML = `投票により <strong>${exiled.nickname}</strong> が村から追放されました。<br>${exiled.role === 'werewolf' ? '<span style="color: var(--emerald); font-weight: 800;">🎉 人狼の追放に成功しました！</span>' : '<span style="color: var(--crimson);">⚠️ 村人陣営のプレイヤーでした...</span>'}`;
    } else {
      cutsceneTitle.textContent = '⚖️ 追放なし';
      cutsceneBody.textContent = '同票のため、今回の追放者は出ませんでした。';
    }
    // Traitor revealed if Mayor died
    if (g.revealedTraitor) {
      cutsceneBody.innerHTML += `<br><strong style="color: var(--gold); font-size: 0.95rem;">🎖️ 村長の遺言発動！ 裏切り者は「${g.revealedTraitor.nickname}」です！</strong>`;
    }
  } else if (g.phase === 'hunter_revenge') {
    gamePhaseIcon.textContent = '🎯';
    cutsceneTitle.textContent = '🎯 ハンターの最後の道連れ射撃！';
    cutsceneBody.textContent = 'ハンターが死亡時に発動する特殊能力！道連れにする相手を1人選択できます。';
    gameActionPrompt.textContent = mySecretRole === 'hunter_avenger' ? '🎯 道連れにする相手を1人選択してください:' : 'ハンターの道連れ選択を待っています...';
  } else if (g.phase.startsWith('night_')) {
    gamePhaseIcon.textContent = '🌙';
    gamePhaseBadge.className = 'game-phase-badge night';
    cutsceneTitle.textContent = `🌙 夜のターン: ${g.phaseTitle || ''}`;

    if (g.phase === 'night_guard') {
      cutsceneBody.textContent = '狩人のターンです。人狼が襲撃する前に守りたい人を1人護衛できます。';
      gameActionPrompt.textContent = mySecretRole === 'hunter_guard' ? '🛡️ 今夜守るプレイヤーを選択:' : '狩人が護衛対象を選択中...';
    } else if (g.phase === 'night_werewolf') {
      sound.playWolfHowl();
      cutsceneBody.textContent = '人狼のターンです。襲撃して殺害するプレイヤーを1人選択します。';
      gameActionPrompt.textContent = mySecretRole === 'werewolf' ? '🐺 襲撃して殺害するプレイヤーを選択:' : '人狼が獲物を狙っています...';
    } else if (g.phase === 'night_seer') {
      cutsceneBody.textContent = '占い師のターンです。占いたいプレイヤーの役職（人狼か市民か）を見抜きます。';
      gameActionPrompt.textContent = mySecretRole === 'seer' ? '🔮 占うプレイヤーを選択:' : '占い師が水晶を覗いています...';
    } else if (g.phase === 'night_medium') {
      cutsceneBody.textContent = '霊媒師のターンです。直前に追放されたプレイヤーの魂と対話します。';
      gameActionPrompt.textContent = mySecretRole === 'medium' ? '🕯️ 追放者の役職結果を確認中...' : '霊媒師が交信中...';
    } else if (g.phase === 'night_archer') {
      cutsceneBody.textContent = 'アーチャーのターンです。一度だけ誰かを狙撃（殺害）できます。';
      gameActionPrompt.textContent = mySecretRole === 'archer' ? '🏹 狙撃するプレイヤーを選択 (しない場合は待機):' : 'アーチャーが狙撃体勢に入っています...';
    } else if (g.phase === 'night_medic') {
      cutsceneBody.textContent = 'メディのターンです。死亡した味方を一度だけ蘇生できます。';
      gameActionPrompt.textContent = mySecretRole === 'medic' ? '💉 復活させるプレイヤーを選択:' : 'メディが治療を行っています...';
    }
  } else if (g.phase === 'morning_result') {
    gamePhaseIcon.textContent = '🌅';
    gamePhaseBadge.className = 'game-phase-badge day';
    const vic = g.lastVictim;
    if (vic) {
      cutsceneTitle.textContent = '🌅 昨夜の犠牲者';
      cutsceneBody.innerHTML = `無残にも <strong>${vic.nickname}</strong> が命を落としました...`;
    } else {
      cutsceneTitle.textContent = '🌅 平穏な朝';
      cutsceneBody.textContent = '昨夜の犠牲者はいませんでした！（狩人の護衛成功、または襲撃なし）';
    }
    if (g.revealedTraitor) {
      cutsceneBody.innerHTML += `<br><strong style="color: var(--gold); font-size: 0.95rem;">🎖️ 村長死亡！ 裏切り者の正体は「${g.revealedTraitor.nickname}」です！</strong>`;
    }
  } else if (g.phase === 'game_over') {
    sound.playVictorySound ? sound.playVictorySound() : sound.playSuccess();
    gamePhaseIcon.textContent = '🏆';
    cutsceneTitle.textContent = g.winnerTitle || (g.winner === 'werewolf' ? '🐺 人狼チームの勝利！' : '🎉 村人チームの勝利！');
    cutsceneBody.innerHTML = `<div style="font-size: 1.1rem; font-weight: 900; color: ${g.winner === 'werewolf' ? 'var(--crimson)' : 'var(--emerald)'};">${g.winner === 'werewolf' ? '市民チームが2人以下になり、人狼チームが村を支配しました！' : 'すべての人狼が追放され、村に平和が戻りました！'}</div><div style="margin-top: 8px; font-size: 0.82rem; color: var(--text-muted);">勝利報酬: +50 コインを獲得しました🪙</div>`;
    btnReturnToLobby.style.display = 'block';
  }

  // Render Players Grid with interactive action buttons
  gamePlayersGrid.innerHTML = '';
  const players = Object.values(room.players || {});
  const me = room.players[localPlayerId];

  players.forEach((p) => {
    const isMe = p.id === localPlayerId;
    const card = document.createElement('div');
    card.className = 'game-player-card' + (!p.isAlive ? ' is-dead' : '') + (p.isSpeaking ? ' speaking' : '');
    card.id = `game_player_${p.id}`;

    let actionBtnText = null;
    let actionType = null;

    if (me && me.isAlive && p.isAlive && !isMe) {
      if (g.phase === 'morning_voting') {
        actionBtnText = '🗳️ 投票';
        actionType = 'CAST_VOTE';
      } else if (g.phase === 'night_guard' && mySecretRole === 'hunter_guard') {
        actionBtnText = '🛡️ 護衛';
        actionType = 'GUARD_TARGET';
      } else if (g.phase === 'night_werewolf' && mySecretRole === 'werewolf') {
        actionBtnText = '🐺 襲撃';
        actionType = 'WEREWOLF_KILL';
      } else if (g.phase === 'night_seer' && mySecretRole === 'seer') {
        actionBtnText = '🔮 占う';
        actionType = 'SEER_DIVINE';
      } else if (g.phase === 'night_archer' && mySecretRole === 'archer') {
        actionBtnText = '🏹 狙撃';
        actionType = 'ARCHER_SHOT';
      }
    } else if (me && g.phase === 'hunter_revenge' && mySecretRole === 'hunter_avenger' && p.isAlive && !isMe) {
      actionBtnText = '🎯 道連れ';
      actionType = 'HUNTER_REVENGE';
    } else if (me && me.isAlive && !p.isAlive && g.phase === 'night_medic' && mySecretRole === 'medic') {
      actionBtnText = '💉 復活';
      actionType = 'MEDIC_REVIVE';
    }

    // Role reveal on game over
    let revealedRoleHtml = '';
    if (g.phase === 'game_over' && g.allRolesRevealed && g.allRolesRevealed[p.id]) {
      const r = ALL_ROLES_MAP[g.allRolesRevealed[p.id].role];
      if (r) {
        revealedRoleHtml = `<div style="font-size: 0.75rem; font-weight: 800; color: ${r.camp === 'werewolf' ? 'var(--crimson)' : 'var(--villager-color)'}; margin-top: 4px;">${r.icon} ${r.name}</div>`;
      }
    }

    card.innerHTML = `
      <div style="font-size: 1.8rem; margin-bottom: 2px;">👤</div>
      <div style="font-weight: 800; font-size: 0.88rem; color: var(--text-main);">${p.nickname}</div>
      <div style="font-size: 0.72rem; color: ${p.isAlive ? 'var(--emerald)' : 'var(--crimson)'}; font-weight: 800;">
        ${p.isAlive ? '生存' : '追放/死亡'}
      </div>
      ${revealedRoleHtml}
      ${actionBtnText ? `<button class="btn-target-select" data-action="${actionType}" data-target="${p.id}">${actionBtnText}</button>` : ''}
    `;

    const btn = card.querySelector('.btn-target-select');
    if (btn) {
      btn.addEventListener('click', () => {
        sound.playClick();
        sendWs('GAME_ACTION', { action: actionType, targetId: p.id });
        showToast(`「${p.nickname}」を選択しました`);
      });
    }

    gamePlayersGrid.appendChild(card);
  });

  // Host Skip / Advance button
  if (room.hostId === localPlayerId && g.phase !== 'game_over') {
    btnHostNextPhase.style.display = 'block';
  } else {
    btnHostNextPhase.style.display = 'none';
  }
}

if (btnHostNextPhase) {
  btnHostNextPhase.addEventListener('click', () => {
    sound.playClick();
    sendWs('GAME_ACTION', { action: 'HOST_SKIP_PHASE' });
  });
}

if (btnReturnToLobby) {
  btnReturnToLobby.addEventListener('click', () => {
    gameView.style.display = 'none';
    onlineHubView.style.display = 'block';
    openModal(onlinePlayModal);
  });
}

// --- Roles Guide & Shop Renderers ---
function renderRoles(campFilter = 'all') {
  rolesList.innerHTML = '';
  const filtered = BASE_ROLES.concat(SHOP_ROLES).filter(r => {
    if (campFilter === 'all') return true;
    if (campFilter === 'shop') return SHOP_ROLES.some(s => s.id === r.id);
    return r.camp === campFilter;
  });

  filtered.forEach(r => {
    const isUnlocked = BASE_ROLES.some(b => b.id === r.id) || unlockedRoles.includes(r.id);
    const card = document.createElement('div');
    card.className = 'role-card';
    card.innerHTML = `
      <div class="role-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.5rem;">${r.icon}</span>
          <strong style="font-size: 1rem; color: var(--text-main);">${r.name}</strong>
        </div>
        <span class="role-badge ${r.camp === 'werewolf' ? 'werewolf' : 'villager'}">${r.campName}</span>
      </div>
      <p style="font-size: 0.82rem; color: var(--text-sub); line-height: 1.5; margin-bottom: 6px;">${r.desc}</p>
      <div style="font-size: 0.74rem; color: var(--text-muted);">
        <strong>勝利条件:</strong> ${r.winCondition}
      </div>
      ${!isUnlocked ? '<div style="font-size: 0.72rem; color: var(--crimson); font-weight: 700; margin-top: 4px;">🔒 ショップで開放可能</div>' : ''}
    `;
    rolesList.appendChild(card);
  });
}

function renderShop() {
  shopItemsList.innerHTML = '';
  SHOP_ROLES.forEach(r => {
    const isUnlocked = unlockedRoles.includes(r.id);
    const card = document.createElement('div');
    card.className = 'shop-item-card';
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.4rem;">${r.icon}</span>
          <strong style="font-size: 1rem; color: var(--text-main);">${r.name}</strong>
          <span class="role-badge villager" style="font-size: 0.7rem;">${r.campName}</span>
        </div>
        <div style="font-weight: 800; color: var(--gold); font-size: 0.95rem;">
          🪙 ${r.cost} C
        </div>
      </div>
      <p style="font-size: 0.8rem; color: var(--text-sub); margin-bottom: 8px;">${r.desc}</p>
      <button class="btn-primary btn-buy-role" ${isUnlocked ? 'disabled' : ''} style="width: 100%; padding: 8px 12px; font-size: 0.85rem;">
        ${isUnlocked ? '✅ 開放済み' : `🪙 ${r.cost}コインで開放`}
      </button>
    `;

    const buyBtn = card.querySelector('.btn-buy-role');
    if (!isUnlocked && buyBtn) {
      buyBtn.addEventListener('click', () => {
        if (userCoins < r.cost) {
          showToast(`コインが不足しています（必要: ${r.cost}C / 所持: ${userCoins}C）`);
          return;
        }
        userCoins -= r.cost;
        unlockedRoles.push(r.id);
        localStorage.setItem('jinrou_unlocked_roles', JSON.stringify(unlockedRoles));
        updateCoinsDisplay();
        scheduleProfileSync();
        renderShop();
        showToast(`🎉 役職「${r.name}」を開放しました！`);
      });
    }

    shopItemsList.appendChild(card);
  });
}

// --- Event Listeners ---
btnOpenSettings.addEventListener('click', () => {
  settingsNicknameInput.value = localNickname;
  settingsCharCounter.textContent = `${localNickname.length}/8`;
  settingsErrorMsg.classList.remove('visible');
  updateVcVolumeUI(vcVolume);
  setVcState(voiceManager.isVcEnabled);
  setMicState(voiceManager.isMicMuted);
  openModal(settingsModal);
});
topNicknameChip.addEventListener('click', () => btnOpenSettings.click());
btnCloseSettings.addEventListener('click', () => closeModal(settingsModal));
btnFinishSettings.addEventListener('click', () => closeModal(settingsModal));

settingsNicknameInput.addEventListener('input', (e) => {
  settingsCharCounter.textContent = `${e.target.value.length}/8`;
  settingsErrorMsg.classList.remove('visible');
});

btnSaveNickname.addEventListener('click', () => {
  const val = (settingsNicknameInput.value || '').trim();
  if (!validateNickname(val)) {
    settingsErrorMsg.classList.add('visible');
    return;
  }
  applyNickname(val);
  showToast(`ニックネームを「${val}」に変更しました`);
});

vcVolumeSlider.addEventListener('input', (e) => updateVcVolumeUI(parseInt(e.target.value, 10)));
presetPills.forEach(pill => {
  pill.addEventListener('click', () => updateVcVolumeUI(parseInt(pill.getAttribute('data-preset'), 10)));
});
btnTestVolume.addEventListener('click', () => {
  sound.playVcTest();
  showToast(`🔊 音量テスト (${vcVolume}%)`);
});

// Role Guide & Shop
btnRoleGuide.addEventListener('click', () => { renderRoles('all'); openModal(roleGuideModal); });
btnCloseRoleGuide.addEventListener('click', () => closeModal(roleGuideModal));
btnFinishRoleGuide.addEventListener('click', () => closeModal(roleGuideModal));

tabRoleAll.addEventListener('click', () => renderRoles('all'));
tabRoleVillager.addEventListener('click', () => renderRoles('villager'));
tabRoleWerewolf.addEventListener('click', () => renderRoles('werewolf'));
tabRoleShop.addEventListener('click', () => renderRoles('shop'));

btnOpenShop.addEventListener('click', () => { renderShop(); openModal(shopModal); });
topCoinsChip.addEventListener('click', () => btnOpenShop.click());
btnCloseShop.addEventListener('click', () => closeModal(shopModal));
btnFinishShop.addEventListener('click', () => closeModal(shopModal));

// Online Play
btnOnlinePlay.addEventListener('click', () => {
  if (activeRoomCode) {
    onlineHubView.style.display = 'none';
    onlineCreateRoomView.style.display = 'none';
    onlineLobbyView.style.display = 'block';
  } else {
    onlineHubView.style.display = 'block';
    onlineCreateRoomView.style.display = 'none';
    onlineLobbyView.style.display = 'none';
  }
  openModal(onlinePlayModal);
});
btnCloseOnlinePlay.addEventListener('click', () => closeModal(onlinePlayModal));

btnCardCreateRoom.addEventListener('click', () => {
  onlineHubView.style.display = 'none';
  onlineCreateRoomView.style.display = 'block';
  updateCreateRoomUI();
});
btnCancelCreateRoom.addEventListener('click', () => {
  onlineCreateRoomView.style.display = 'none';
  onlineHubView.style.display = 'block';
});

btnCardShowJoinInput.addEventListener('click', () => {
  const isHidden = joinRoomForm.style.display === 'none';
  joinRoomForm.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    roomCodeInput.focus();
    loadActiveRooms();
  }
});

async function loadActiveRooms() {
  const listEl = document.getElementById('activeRoomsList');
  if (!listEl) return;
  listEl.innerHTML = '<div style="font-size: 0.78rem; color: var(--text-muted); text-align: center; padding: 6px;">更新中...</div>';
  try {
    const res = await fetch('/api/jinrou/rooms');
    if (res.ok) {
      const data = await res.json();
      const rooms = data.rooms || [];
      if (rooms.length === 0) {
        listEl.innerHTML = '<div style="font-size: 0.78rem; color: var(--text-muted); text-align: center; padding: 6px;">現在募集中の部屋はありません</div>';
        return;
      }
      listEl.innerHTML = '';
      rooms.forEach(r => {
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: #ffffff; border: 1px solid var(--border-color); border-radius: 8px; padding: 6px 10px; font-size: 0.82rem;';
        item.innerHTML = `
          <div>
            <span style="font-weight: 800; color: var(--crimson);">#${r.code}</span>
            <span style="color: var(--text-sub); margin-left: 6px;">(${r.hostNickname || 'ホスト'}村)</span>
            <span style="color: var(--text-muted); font-size: 0.72rem; margin-left: 4px;">${r.playerCount}/${r.maxPlayers}人</span>
          </div>
          <button class="btn-primary" style="padding: 4px 10px; font-size: 0.78rem;" data-join-code="${r.code}">参加</button>
        `;
        item.querySelector('button').addEventListener('click', () => {
          roomCodeInput.value = r.code;
          btnJoinRoomSubmit.click();
        });
        listEl.appendChild(item);
      });
      return;
    }
  } catch (e) {}
  listEl.innerHTML = '<div style="font-size: 0.78rem; color: var(--text-muted); text-align: center; padding: 6px;">部屋コードを入力してご参加ください</div>';
}

const btnRefreshActiveRooms = document.getElementById('btnRefreshActiveRooms');
if (btnRefreshActiveRooms) {
  btnRefreshActiveRooms.addEventListener('click', loadActiveRooms);
}

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    btnJoinRoomSubmit.click();
  }
});

roomCodeInput.addEventListener('input', () => {
  joinRoomErrorMsg.classList.remove('visible');
});

// Create Room Action
btnConfirmCreateRoom.addEventListener('click', async () => {
  btnConfirmCreateRoom.disabled = true;
  try {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    showToast('部屋を作成中...');

    let finalConfig = {};
    if (createRoomMode === 'normal') {
      finalConfig = getNormalRolesConfig(createRoomPlayerCount);
    } else {
      finalConfig = { ...originalRolesConfig };
    }
    const finalRolesList = expandRolesList(finalConfig);

    const roomData = await createFirestoreRoom(code, localPlayerId, localNickname, {
      maxPlayers: createRoomPlayerCount,
      discussionTime: createRoomDiscussionTime,
      roleMode: createRoomMode,
      rolesConfig: finalConfig,
      rolesList: finalRolesList
    });

    activeRoomCode = code;
    isHost = true;
    enterLobbyView(code, roomData);

    sendWs('CREATE_ROOM', {
      code,
      playerId: localPlayerId,
      nickname: localNickname,
      maxPlayers: createRoomPlayerCount,
      discussionTime: createRoomDiscussionTime,
      roleMode: createRoomMode,
      rolesConfig: finalConfig,
      rolesList: finalRolesList,
      isVcOn: voiceManager.isVcEnabled
    });

    showToast(`部屋 #${code} を作成しました！`);
  } catch (err) {
    showToast('部屋作成エラー: ' + err.message);
  } finally {
    btnConfirmCreateRoom.disabled = false;
  }
});

// Join Room Action (Supports #1234, full-width digits, spaces, and direct code)
btnJoinRoomSubmit.addEventListener('click', async () => {
  const rawVal = (roomCodeInput.value || '').trim();
  // Strip any leading # or ＃, remove spaces, convert Japanese full-width digits to half-width
  const code = rawVal
    .replace(/[＃#\s]/g, '')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .trim();

  if (code.length < 4 || !/^\d{4}$/.test(code)) {
    joinRoomErrorMsg.textContent = '4桁の半角数字の部屋コードを入力してください（例: 1234）';
    joinRoomErrorMsg.classList.add('visible');
    return;
  }
  joinRoomErrorMsg.classList.remove('visible');
  btnJoinRoomSubmit.disabled = true;

  try {
    showToast(`部屋 #${code} に参加中...`);
    const roomData = await joinFirestoreRoom(code, localPlayerId, localNickname);

    activeRoomCode = code;
    isHost = (roomData.hostId === localPlayerId);
    enterLobbyView(code, roomData);

    sendWs('JOIN_ROOM', {
      code,
      playerId: localPlayerId,
      nickname: localNickname,
      isVcOn: voiceManager.isVcEnabled
    });

    showToast(`部屋 #${code} に合流しました！`);
  } catch (err) {
    joinRoomErrorMsg.textContent = err.message || '部屋が見つかりませんでした';
    joinRoomErrorMsg.classList.add('visible');
    showToast('参加失敗: ' + (err.message || '部屋が見つかりませんでした'));
  } finally {
    btnJoinRoomSubmit.disabled = false;
  }
});

btnCopyRoomCode.addEventListener('click', () => {
  if (!activeRoomCode) return;
  navigator.clipboard.writeText(activeRoomCode).then(() => {
    showToast(`部屋コード #${activeRoomCode} をコピーしました！`);
  });
});

btnInviteShare.addEventListener('click', () => {
  if (!activeRoomCode) return;
  const inviteText = lobbyInvitePreviewText.textContent;
  if (navigator.share) {
    navigator.share({ title: '人狼オンライン 招待', text: inviteText }).catch(() => {});
  } else {
    navigator.clipboard.writeText(inviteText).then(() => {
      showToast('✉️ 招待メッセージをコピーしました！友達に送信してください');
    });
  }
});

btnLeaveRoom.addEventListener('click', async () => {
  if (lobbyUnsubscribe) {
    try { lobbyUnsubscribe(); } catch (e) {}
    lobbyUnsubscribe = null;
  }
  if (activeRoomCode) {
    sendWs('LEAVE_ROOM', { code: activeRoomCode, playerId: localPlayerId });
    await leaveFirestoreRoom(activeRoomCode, localPlayerId);
  }
  voiceManager.leaveRoom();
  activeRoomCode = null;
  isHost = false;
  currentRoomData = null;
  onlineLobbyView.style.display = 'none';
  onlineHubView.style.display = 'block';
  topLeftChatContainer.style.display = 'none';
  gameView.style.display = 'none';
  showToast('部屋を退出しました');
});

// Initial Nickname modal
initialNicknameInput.addEventListener('input', (e) => {
  initialCharCounter.textContent = `${e.target.value.length}/8`;
  if (validateNickname(e.target.value)) initialErrorMsg.classList.remove('visible');
});

btnConfirmInitialNickname.addEventListener('click', () => {
  const val = (initialNicknameInput.value || '').trim();
  if (!validateNickname(val)) {
    initialErrorMsg.classList.add('visible');
    return;
  }
  applyNickname(val);
  closeModal(initialNicknameModal);
  sound.playSuccess();
  showToast(`ニックネーム「${val}」で開始しました！`);
});

// App Initialization
function initApp() {
  updateCoinsDisplay();
  updateVcVolumeUI(vcVolume);
  setVcState(true); // VC ON by default

  if (!localNickname || !validateNickname(localNickname)) {
    openModal(initialNicknameModal);
  } else {
    topNicknameText.textContent = localNickname;
    scheduleProfileSync();
  }

  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam && /^\d{4}$/.test(roomParam)) {
    roomCodeInput.value = roomParam;
    openModal(onlinePlayModal);
    joinRoomForm.style.display = 'block';
  }
}

window.addEventListener('DOMContentLoaded', initApp);
