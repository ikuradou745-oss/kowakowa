import { WerewolfAudio } from './audio.js';
import { VoiceManager } from './voice.js';
import { 
  savePlayerProfile, 
  fetchPlayerProfile, 
  createFirestoreRoom, 
  joinFirestoreRoom, 
  subscribeToRoom, 
  leaveFirestoreRoom 
} from './firebase.js';

// --- State Variables ---
const sound = new WerewolfAudio();

let localPlayerId = localStorage.getItem('jinrou_player_id');
if (!localPlayerId) {
  localPlayerId = 'usr_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
  localStorage.setItem('jinrou_player_id', localPlayerId);
}

let localNickname = localStorage.getItem('jinrou_nickname') || '';
let vcVolume = parseInt(localStorage.getItem('jinrou_vc_volume'), 10);
if (isNaN(vcVolume) || vcVolume < 50 || vcVolume > 500) {
  vcVolume = 100;
}
sound.setVcVolume(vcVolume);

// Coin System (Initial coins is 0, test-increasing feature removed)
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

// Active Online Room State
let activeRoomCode = null;
let roomUnsubscribe = null;
let isHost = false;
let currentRoomData = null;
let mySecretRole = null;

// Room Creation Local State
let createRoomPlayerCount = 5;
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

// --- Basic Roles Definitions for 「役職確認」 ---
const BASE_ROLES = [
  {
    id: 'werewolf',
    name: '人狼',
    icon: '🐺',
    camp: 'werewolf',
    campName: '人狼チーム',
    desc: '人狼チームで村人チームを夜の間に殺害できる。自分が追放されたら負け。',
    winCondition: '村人チームの人数と同数以上になること（自身が追放されたら敗北）'
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
    desc: '村人チームで追放された人の役職がわかる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'seer',
    name: '占い師',
    icon: '🔮',
    camp: 'villager',
    campName: '村人チーム',
    desc: '夜の時に役職が何かを占える。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'hunter_guard',
    name: '狩人',
    icon: '🛡️',
    camp: 'villager',
    campName: '村人チーム',
    desc: '夜の時に味方を守れる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'traitor',
    name: '裏切り者',
    icon: '🎭',
    camp: 'werewolf',
    campName: '人狼チーム',
    desc: '人狼チーム。村人陣営としてカウントされますが、人狼チームの勝利を目指します。',
    winCondition: '人狼チームが勝利する'
  }
];

// --- Shop Roles Definitions ---
const SHOP_ROLES = [
  {
    id: 'mayor',
    name: '村長',
    icon: '🎖️',
    cost: 100,
    camp: 'villager',
    campName: '村人チーム',
    desc: '死亡時に裏切り者が誰かがわかる。村長が死亡した時、村に潜む裏切り者の正体が暴かれます。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'medic',
    name: 'メディ',
    icon: '💉',
    cost: 300,
    camp: 'villager',
    campName: '村人チーム',
    desc: '2日目以降の夜のターンに一度だけ味方を一人復活できる。ピンチの村人を蘇生させて形勢逆転を狙えます。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'hunter_avenger',
    name: 'ハンター',
    icon: '🎯',
    cost: 100,
    camp: 'villager',
    campName: '村人チーム',
    desc: '自分が死亡した時に誰か一人を道連れにして死亡させることができる。最後の反撃で村を守る強力な役職。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'archer',
    name: 'アーチャー',
    icon: '🏹',
    cost: 200,
    camp: 'villager',
    campName: '村人チーム',
    desc: '夜のターンに一度だけ誰かを狙撃（殺害）できる。人狼を直接討ち取ることができる強力な攻撃能力者。',
    winCondition: 'すべての人狼を追放する'
  }
];

const ALL_ROLES_MAP = {};
BASE_ROLES.forEach(r => { ALL_ROLES_MAP[r.id] = r; });
SHOP_ROLES.forEach(r => { ALL_ROLES_MAP[r.id] = r; });

// --- DOM Elements ---
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

// VC & Mic Settings buttons
const btnSettingsVcOn = document.getElementById('btnSettingsVcOn');
const btnSettingsVcOff = document.getElementById('btnSettingsVcOff');
const btnSettingsMicOn = document.getElementById('btnSettingsMicOn');
const btnSettingsMicOff = document.getElementById('btnSettingsMicOff');

// Main Menu Actions
const btnOnlinePlay = document.getElementById('btnOnlinePlay');
const btnRoleGuide = document.getElementById('btnRoleGuide');
const btnOpenShop = document.getElementById('btnOpenShop');

// Role Guide Modal
const roleGuideModal = document.getElementById('roleGuideModal');
const btnCloseRoleGuide = document.getElementById('btnCloseRoleGuide');
const btnFinishRoleGuide = document.getElementById('btnFinishRoleGuide');
const rolesList = document.getElementById('rolesList');
const tabRoleAll = document.getElementById('tabRoleAll');
const tabRoleVillager = document.getElementById('tabRoleVillager');
const tabRoleWerewolf = document.getElementById('tabRoleWerewolf');
const tabRoleShop = document.getElementById('tabRoleShop');

// Shop Modal
const shopModal = document.getElementById('shopModal');
const btnCloseShop = document.getElementById('btnCloseShop');
const btnFinishShop = document.getElementById('btnFinishShop');
const shopCoinsDisplay = document.getElementById('shopCoinsDisplay');
const shopItemsList = document.getElementById('shopItemsList');

// Online Play Modal
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

// Create Room View
const roomPlayerCountSlider = document.getElementById('roomPlayerCountSlider');
const playerCountDisplay = document.getElementById('playerCountDisplay');
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

// Lobby In-Room Voice Bar
const btnLobbyVcToggle = document.getElementById('btnLobbyVcToggle');
const lobbyVcIcon = document.getElementById('lobbyVcIcon');
const lobbyVcLabel = document.getElementById('lobbyVcLabel');
const btnLobbyMicToggle = document.getElementById('btnLobbyMicToggle');
const lobbyMicIcon = document.getElementById('lobbyMicIcon');
const lobbyMicLabel = document.getElementById('lobbyMicLabel');
const lobbySpeakingRing = document.getElementById('lobbySpeakingRing');

// Top-Left Chat Box
const topLeftChatContainer = document.getElementById('topLeftChatContainer');
const chatModeBadge = document.getElementById('chatModeBadge');
const chatModeText = document.getElementById('chatModeText');
const btnChatToggle = document.getElementById('btnChatToggle');
const chatExpandableArea = document.getElementById('chatExpandableArea');
const chatMessagesBox = document.getElementById('chatMessagesBox');
const chatInput = document.getElementById('chatInput');
const chatCharCounter = document.getElementById('chatCharCounter');
const btnSendChat = document.getElementById('btnSendChat');

// Game View
const gameView = document.getElementById('gameView');
const gameDayCountText = document.getElementById('gameDayCountText');
const gamePhaseBadge = document.getElementById('gamePhaseBadge');
const gamePhaseIcon = document.getElementById('gamePhaseIcon');
const gamePhaseText = document.getElementById('gamePhaseText');
const myRoleCampBadge = document.getElementById('myRoleCampBadge');
const myRoleIcon = document.getElementById('myRoleIcon');
const myRoleName = document.getElementById('myRoleName');
const myRoleDesc = document.getElementById('myRoleDesc');
const gameActionPrompt = document.getElementById('gameActionPrompt');
const gamePlayersGrid = document.getElementById('gamePlayersGrid');
const btnHostNextPhase = document.getElementById('btnHostNextPhase');
const btnGameVcToggle = document.getElementById('btnGameVcToggle');
const btnGameMicToggle = document.getElementById('btnGameMicToggle');
const gameVcLabel = document.getElementById('gameVcLabel');
const gameMicLabel = document.getElementById('gameMicLabel');

// Global Toast
const globalToast = document.getElementById('globalToast');

// --- Voice Manager (WebRTC Voice Chat) ---
const voiceManager = new VoiceManager({
  onSpeakingChange: (isSpeaking) => {
    updateSpeakingIndicators(localPlayerId, isSpeaking);
  },
  onPeerVoiceState: (peerId, voiceState) => {
    updateSpeakingIndicators(peerId, voiceState.isSpeaking);
  },
  onRemoteTrack: (peerId, stream) => {
    console.log(`[WebRTC] Attached remote audio track for peer ${peerId}`);
  },
  onLog: (msg) => {
    showToast(msg);
  }
});
voiceManager.setVolume(vcVolume);

// --- WebSocket Real-Time Connection ---
let socket = null;
let isSocketConnected = false;

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      isSocketConnected = true;
      console.log('[WS] Connected to Werewolf server');
      // If we already have an active room, re-join on reconnect
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
      } catch (err) {
        console.error('[WS] Parse error', err);
      }
    };

    socket.onclose = () => {
      isSocketConnected = false;
      setTimeout(initWebSocket, 2000);
    };

    socket.onerror = (e) => {
      console.warn('[WS] Socket notice:', e);
    };

    // Connect voice signaling through WebSocket
    voiceManager.setSignalSender((signalMsg) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(signalMsg));
      }
    }, localPlayerId, activeRoomCode);

  } catch (err) {
    console.warn('[WS] Could not start WebSocket', err);
  }
}
initWebSocket();

function sendWs(type, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, payload }));
  }
}

// --- WebSocket Message Handler ---
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
      // Another peer joined our room: initiate WebRTC audio offer
      if (payload.peerId !== localPlayerId) {
        voiceManager.handlePeerJoined(payload.peerId, true);
        appendChatMessage('システム', `「${payload.nickname || 'プレイヤー'}」が部屋に入室しました`, 'system');
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
      updatePeerVoiceIcon(payload.playerId, payload.isVcOn, payload.isMuted);
      break;
    }

    case 'CHAT_MESSAGE': {
      appendChatMessage(payload.senderName, payload.text, payload.senderId === localPlayerId ? 'me' : 'other');
      break;
    }

    case 'GAME_STARTED': {
      currentRoomData = payload;
      mySecretRole = payload.myRole || 'villager';
      startGameScreen(payload);
      break;
    }

    case 'SEER_RESULT': {
      sound.playSuccess();
      const verdict = payload.isWerewolf ? '【人狼】🐺' : '【村人陣営】🧑‍🌾';
      showToast(`🔮 占い結果: ${payload.targetNickname} さんは ${verdict} です！`);
      appendChatMessage('占い結果', `${payload.targetNickname}さんは${verdict}でした`, 'system');
      break;
    }

    case 'PHASE_CHANGED': {
      currentRoomData = payload;
      updateGamePhaseUI(payload);
      break;
    }

    case 'ERROR': {
      showToast(payload.message || 'エラーが発生しました');
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
  globalToast._timer = setTimeout(() => {
    globalToast.classList.remove('show');
  }, 2800);
}

function openModal(modal) {
  if (modal) modal.classList.add('active');
}

function closeModal(modal) {
  if (modal) modal.classList.remove('active');
}

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

  presetPills.forEach((pill) => {
    const pVal = parseInt(pill.getAttribute('data-preset'), 10);
    pill.classList.toggle('active', pVal === vcVolume);
  });
}

function scheduleProfileSync() {
  if (!localPlayerId || !localNickname) return;
  savePlayerProfile(localPlayerId, localNickname, vcVolume, userCoins, unlockedRoles);
}

// --- Top-Left Chat Management (Max 20 chars, format: [ユーザー名]: [チャットの内容]) ---
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
  if (val.length > 20) {
    val = val.slice(0, 20); // strictly max 20 chars
  }

  // Send through WebSocket to room
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
  if (e.key === 'Enter') {
    sendCurrentChat();
  }
});

btnSendChat.addEventListener('click', () => {
  sendCurrentChat();
});

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

  // Update Top-Left Chat Mode Badge
  if (enabled) {
    chatModeBadge.className = 'chat-mode-badge vc-on';
    chatModeBadge.innerHTML = '<span>🎙️</span><span>VC: ON (通話可能)</span>';
    lobbyVcIcon.textContent = '🔊';
    lobbyVcLabel.textContent = 'VC: ON';
    btnLobbyVcToggle.classList.add('active');
    btnLobbyVcToggle.classList.remove('muted');
    if (gameVcLabel) gameVcLabel.textContent = '🔊 VC: ON';
    showToast('🔊 ボイスチャット (VC) をONにしました');
  } else {
    chatModeBadge.className = 'chat-mode-badge vc-off';
    chatModeBadge.innerHTML = '<span>💬</span><span>チャットモード (VC: OFF)</span>';
    lobbyVcIcon.textContent = '🔇';
    lobbyVcLabel.textContent = 'VC: OFF';
    btnLobbyVcToggle.classList.remove('active');
    btnLobbyVcToggle.classList.add('muted');
    if (gameVcLabel) gameVcLabel.textContent = '🔇 VC: OFF';
    showToast('🔇 VCをOFFにしました（チャットモード中）');
    // Expand chat and focus input
    chatExpandableArea.style.display = 'block';
    btnChatToggle.textContent = '▼';
    chatInput.focus();
  }

  // Update settings modal buttons
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
    showToast('🔇 マイクをミュートしました');
  } else {
    lobbyMicIcon.textContent = '🎙️';
    lobbyMicLabel.textContent = 'マイク: ON';
    btnLobbyMicToggle.classList.add('active');
    btnLobbyMicToggle.classList.remove('muted');
    if (gameMicLabel) gameMicLabel.textContent = '🎙️ マイクON';
    showToast('🎙️ マイクをONにしました');
  }

  btnSettingsMicOn.style.background = !muted ? 'var(--emerald-light)' : '#f1f5f9';
  btnSettingsMicOff.style.background = muted ? 'var(--crimson-light)' : '#f1f5f9';
}

// In-Lobby & In-Game Voice Buttons
btnLobbyVcToggle.addEventListener('click', () => {
  setVcState(!voiceManager.isVcEnabled);
});

btnLobbyMicToggle.addEventListener('click', () => {
  setMicState(!voiceManager.isMicMuted);
});

if (btnGameVcToggle) {
  btnGameVcToggle.addEventListener('click', () => {
    setVcState(!voiceManager.isVcEnabled);
  });
}
if (btnGameMicToggle) {
  btnGameMicToggle.addEventListener('click', () => {
    setMicState(!voiceManager.isMicMuted);
  });
}

btnSettingsVcOn.addEventListener('click', () => setVcState(true));
btnSettingsVcOff.addEventListener('click', () => setVcState(false));
btnSettingsMicOn.addEventListener('click', () => setMicState(false));
btnSettingsMicOff.addEventListener('click', () => setMicState(true));

// Speaking Indicators Update
function updateSpeakingIndicators(playerId, isSpeaking) {
  if (playerId === localPlayerId) {
    if (lobbySpeakingRing) {
      lobbySpeakingRing.classList.toggle('speaking', isSpeaking);
    }
  }

  // Update in Lobby Roster
  const rosterItem = document.getElementById(`roster_${playerId}`);
  if (rosterItem) {
    const ring = rosterItem.querySelector('.speaking-indicator-ring');
    if (ring) ring.classList.toggle('speaking', isSpeaking);
  }

  // Update in Game Player Card
  const gameCard = document.getElementById(`game_player_${playerId}`);
  if (gameCard) {
    gameCard.classList.toggle('speaking', isSpeaking);
  }
}

function updatePeerVoiceIcon(playerId, isVcOn, isMuted) {
  const rosterItem = document.getElementById(`roster_${playerId}`);
  if (rosterItem) {
    const vcIcon = rosterItem.querySelector('.peer-vc-icon');
    if (vcIcon) {
      if (!isVcOn) {
        vcIcon.textContent = '🔇(VC切)';
      } else if (isMuted) {
        vcIcon.textContent = '🔇(消音)';
      } else {
        vcIcon.textContent = '🎙️';
      }
    }
  }
}

// --- Lobby Management & Minimum 3 Players Enforcement ---
function updateLobbyUI(room) {
  if (!room) return;
  activeRoomCode = room.code;
  lobbyRoomCodeText.textContent = `#${room.code}`;

  const players = Object.values(room.players || {});
  const playerCount = players.length;
  const maxPlayers = room.maxPlayers || 5;

  lobbyPlayerCount.textContent = playerCount;
  lobbyPlayerMax.textContent = maxPlayers;

  // Invite text preview
  const hostNick = room.hostNickname || localNickname;
  lobbyInvitePreviewText.textContent = `https://ikuradou745-oss.github.io/zinnrou/
${hostNick}が呼んでるよ！参加コードは${room.code}だよ！`;

  // Render Roster
  lobbyPlayerRoster.innerHTML = '';
  players.forEach((p) => {
    const isMe = p.id === localPlayerId;
    const isHostPlayer = p.isHost;

    const row = document.createElement('div');
    row.className = 'lobby-player-item';
    row.id = `roster_${p.id}`;

    row.innerHTML = `
      <div class="lobby-player-info">
        <span class="speaking-indicator-ring ${p.isSpeaking ? 'speaking' : ''}"></span>
        <span>👤 ${p.nickname}</span>
        ${isHostPlayer ? '<span style="font-size: 0.7rem; background: var(--crimson-light); color: var(--crimson); font-weight: 800; padding: 2px 6px; border-radius: 4px;">ホスト</span>' : ''}
        ${isMe ? '<span style="font-size: 0.7rem; color: var(--sky); font-weight: 800;">(あなた)</span>' : ''}
      </div>
      <div class="lobby-player-voice-status">
        <span class="peer-vc-icon">${!p.isVcOn ? '🔇(VC切)' : p.isMuted ? '🔇(消音)' : '🎙️'}</span>
      </div>
    `;
    lobbyPlayerRoster.appendChild(row);
  });

  // --- STRICT REQUIREMENT: Minimum 3 players required to start game ---
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

function enterLobbyView(roomCode, roomData) {
  onlineHubView.style.display = 'none';
  onlineCreateRoomView.style.display = 'none';
  onlineLobbyView.style.display = 'block';

  // Show Top-Left Chat Box
  topLeftChatContainer.style.display = 'block';
  chatExpandableArea.style.display = 'block';

  // Set Voice manager room code and sender
  voiceManager.setSignalSender((msg) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }, localPlayerId, roomCode);

  // Initialize microphone if VC is enabled
  if (voiceManager.isVcEnabled) {
    voiceManager.initLocalAudio();
  }

  updateLobbyUI(roomData);
}

// --- Start Game Action (Minimum 3 players) ---
btnLobbyStartGame.addEventListener('click', () => {
  const currentCount = currentRoomData ? Object.keys(currentRoomData.players || {}).length : 1;
  if (currentCount < 3) {
    sound.playClick();
    showToast(`⚠️ ゲームを開始するには最低3人のプレイヤーが必要です（現在: ${currentCount}/3人）`);
    return;
  }

  sound.playWolfHowl();
  showToast('🐺 ゲームを開始しています（配役を決定中...）');
  sendWs('START_GAME', { roomCode: activeRoomCode, playerId: localPlayerId });
});

// --- In-Game Screen Management ---
function startGameScreen(room) {
  closeModal(onlinePlayModal);
  gameView.style.display = 'flex';

  // Ensure Top-Left Chat is active and visible
  topLeftChatContainer.style.display = 'block';

  // Reveal Secret Role
  const roleObj = ALL_ROLES_MAP[mySecretRole] || BASE_ROLES[1];
  myRoleName.textContent = roleObj.name;
  myRoleIcon.textContent = roleObj.icon;
  myRoleDesc.textContent = roleObj.desc;
  myRoleCampBadge.textContent = roleObj.campName;
  myRoleCampBadge.className = 'role-badge ' + (roleObj.camp === 'werewolf' ? 'werewolf' : 'villager');

  updateGamePhaseUI(room);
  appendChatMessage('進行役', `ゲームが開始されました。あなたの役職は「${roleObj.name}」です`, 'system');
}

function updateGamePhaseUI(room) {
  if (!room || !room.game) return;
  const g = room.game;
  gameDayCountText.textContent = `${g.dayCount || 1}日目`;

  if (g.phase === 'night') {
    gamePhaseIcon.textContent = '🌙';
    gamePhaseText.textContent = `夜の行動 (残り${g.timerSec || 30}秒)`;
    gamePhaseBadge.className = 'game-phase-badge night';
    gameActionPrompt.textContent = mySecretRole === 'werewolf' 
      ? '🐺 襲撃するプレイヤーを選択してください:' 
      : mySecretRole === 'seer' 
      ? '🔮 占うプレイヤーを選択してください:' 
      : mySecretRole === 'hunter_guard'
      ? '🛡️ 今夜守るプレイヤーを選択してください:'
      : '🌙 夜の行動中（他のプレイヤーの行動を待っています）';
  } else if (g.phase === 'discussion') {
    gamePhaseIcon.textContent = '☀️';
    gamePhaseText.textContent = `昼の議論タイム (残り${g.timerSec || 60}秒)`;
    gamePhaseBadge.className = 'game-phase-badge day';
    gameActionPrompt.textContent = '🗣️ ボイスチャットまたは左上チャットで話し合ってください:';
  } else if (g.phase === 'voting') {
    gamePhaseIcon.textContent = '🗳️';
    gamePhaseText.textContent = `追放投票タイム (残り${g.timerSec || 30}秒)`;
    gamePhaseBadge.className = 'game-phase-badge voting';
    gameActionPrompt.textContent = '🗳️ 追放したいプレイヤーに投票してください:';
  } else if (g.phase === 'execution') {
    gamePhaseIcon.textContent = '⚖️';
    const exiledName = g.lastExiled ? g.lastExiled.nickname : 'なし';
    gamePhaseText.textContent = `追放結果発表: ${exiledName}`;
    gamePhaseBadge.className = 'game-phase-badge voting';
    gameActionPrompt.textContent = `⚖️ 投票により「${exiledName}」が追放されました。`;
  } else if (g.phase === 'game_over') {
    gamePhaseIcon.textContent = '🏆';
    const winTeam = g.winner === 'werewolf' ? '人狼チームの勝利！🐺' : '村人チームの勝利！🎉';
    gamePhaseText.textContent = `勝敗決定: ${winTeam}`;
    gameActionPrompt.textContent = `🏆 ${winTeam}`;

    // Award coins for playing
    userCoins += 50;
    updateCoinsDisplay();
    scheduleProfileSync();
    showToast(`ゲーム終了！勝利報酬として +50 コインを獲得しました🪙`);
  }

  // Render game players grid
  gamePlayersGrid.innerHTML = '';
  const players = Object.values(room.players || {});
  players.forEach((p) => {
    const isMe = p.id === localPlayerId;
    const card = document.createElement('div');
    card.className = 'game-player-card' + (!p.isAlive ? ' is-dead' : '') + (p.isSpeaking ? ' speaking' : '');
    card.id = `game_player_${p.id}`;

    let actionBtnHtml = '';
    if (p.isAlive && !isMe) {
      if (g.phase === 'night') {
        if (mySecretRole === 'werewolf') actionBtnHtml = `<button class="btn-target-select" data-target="${p.id}">襲撃</button>`;
        if (mySecretRole === 'seer') actionBtnHtml = `<button class="btn-target-select" data-target="${p.id}">占う</button>`;
        if (mySecretRole === 'hunter_guard') actionBtnHtml = `<button class="btn-target-select" data-target="${p.id}">護衛</button>`;
      } else if (g.phase === 'voting') {
        actionBtnHtml = `<button class="btn-target-select" data-target="${p.id}">投票</button>`;
      }
    }

    card.innerHTML = `
      <div style="font-size: 1.8rem; margin-bottom: 4px;">👤</div>
      <div style="font-weight: 800; font-size: 0.88rem; color: var(--text-main);">${p.nickname}</div>
      <div style="font-size: 0.72rem; color: ${p.isAlive ? 'var(--emerald)' : 'var(--crimson)'}; font-weight: 700;">
        ${p.isAlive ? '生存' : '追放/死亡'}
      </div>
      ${actionBtnHtml}
    `;

    const selectBtn = card.querySelector('.btn-target-select');
    if (selectBtn) {
      selectBtn.addEventListener('click', () => {
        sound.playClick();
        if (g.phase === 'night') {
          sendWs('GAME_ACTION', { action: 'NIGHT_TARGET', targetId: p.id });
          showToast(`「${p.nickname}」をターゲットに選択しました`);
        } else if (g.phase === 'voting') {
          sendWs('GAME_ACTION', { action: 'CAST_VOTE', targetId: p.id });
          showToast(`「${p.nickname}」に投票しました`);
        }
      });
    }

    gamePlayersGrid.appendChild(card);
  });

  // Host Next Phase button
  const isMeHost = (room.hostId === localPlayerId);
  if (isMeHost && g.phase !== 'game_over') {
    btnHostNextPhase.style.display = 'block';
  } else {
    btnHostNextPhase.style.display = 'none';
  }
}

if (btnHostNextPhase) {
  btnHostNextPhase.addEventListener('click', () => {
    sound.playClick();
    sendWs('GAME_ACTION', { action: 'NEXT_PHASE' });
  });
}

// --- Roles Guide & Shop Renderers ---
function renderRoles(campFilter = 'all') {
  rolesList.innerHTML = '';
  const filtered = BASE_ROLES.concat(SHOP_ROLES).filter((r) => {
    if (campFilter === 'all') return true;
    if (campFilter === 'shop') return SHOP_ROLES.some(s => s.id === r.id);
    return r.camp === campFilter;
  });

  filtered.forEach((r) => {
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
  SHOP_ROLES.forEach((r) => {
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
  const val = e.target.value;
  settingsCharCounter.textContent = `${val.length}/8`;
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

vcVolumeSlider.addEventListener('input', (e) => {
  updateVcVolumeUI(parseInt(e.target.value, 10));
});

presetPills.forEach((pill) => {
  pill.addEventListener('click', () => {
    const p = parseInt(pill.getAttribute('data-preset'), 10);
    updateVcVolumeUI(p);
  });
});

btnTestVolume.addEventListener('click', () => {
  sound.playVcTest();
  showToast(`🔊 音量テスト再生中 (${vcVolume}%)`);
});

// Role Guide Tab buttons
btnRoleGuide.addEventListener('click', () => {
  renderRoles('all');
  openModal(roleGuideModal);
});
btnCloseRoleGuide.addEventListener('click', () => closeModal(roleGuideModal));
btnFinishRoleGuide.addEventListener('click', () => closeModal(roleGuideModal));

tabRoleAll.addEventListener('click', () => renderRoles('all'));
tabRoleVillager.addEventListener('click', () => renderRoles('villager'));
tabRoleWerewolf.addEventListener('click', () => renderRoles('werewolf'));
tabRoleShop.addEventListener('click', () => renderRoles('shop'));

// Shop
btnOpenShop.addEventListener('click', () => {
  renderShop();
  openModal(shopModal);
});
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
});
btnCancelCreateRoom.addEventListener('click', () => {
  onlineCreateRoomView.style.display = 'none';
  onlineHubView.style.display = 'block';
});

roomPlayerCountSlider.addEventListener('input', (e) => {
  createRoomPlayerCount = parseInt(e.target.value, 10);
  playerCountDisplay.textContent = `${createRoomPlayerCount}人`;
});

btnCardShowJoinInput.addEventListener('click', () => {
  joinRoomForm.style.display = joinRoomForm.style.display === 'none' ? 'block' : 'none';
});

// Create Room Action
btnConfirmCreateRoom.addEventListener('click', async () => {
  btnConfirmCreateRoom.disabled = true;
  try {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    showToast('部屋を作成中...');

    // 1. Sync to Firestore (and local memory)
    const roomData = await createFirestoreRoom(code, localPlayerId, localNickname, {
      maxPlayers: createRoomPlayerCount,
      roleMode: createRoomMode
    });

    activeRoomCode = code;
    isHost = true;
    enterLobbyView(code, roomData);

    // 2. Notify WebSocket server
    sendWs('CREATE_ROOM', {
      code,
      playerId: localPlayerId,
      nickname: localNickname,
      maxPlayers: createRoomPlayerCount,
      roleMode: createRoomMode,
      isVcOn: voiceManager.isVcEnabled
    });

    showToast(`部屋 #${code} を作成しました！`);
  } catch (err) {
    showToast('部屋作成エラー: ' + err.message);
  } finally {
    btnConfirmCreateRoom.disabled = false;
  }
});

// Join Room Action
btnJoinRoomSubmit.addEventListener('click', async () => {
  const code = (roomCodeInput.value || '').trim();
  if (code.length < 4) {
    joinRoomErrorMsg.textContent = '4桁の部屋コードを入力してください';
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
    navigator.share({
      title: '人狼オンライン 招待',
      text: inviteText
    }).catch(() => {});
  } else {
    navigator.clipboard.writeText(inviteText).then(() => {
      showToast('✉️ 招待メッセージをコピーしました！友達に送信してください');
    });
  }
});

btnLeaveRoom.addEventListener('click', async () => {
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
  const val = e.target.value;
  initialCharCounter.textContent = `${val.length}/8`;
  if (validateNickname(val)) initialErrorMsg.classList.remove('visible');
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
  setVcState(true); // VC ON by default as requested

  if (!localNickname || !validateNickname(localNickname)) {
    openModal(initialNicknameModal);
  } else {
    topNicknameText.textContent = localNickname;
    scheduleProfileSync();
  }

  // Handle URL parameter for room code (?room=1234)
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam && /^\d{4}$/.test(roomParam)) {
    roomCodeInput.value = roomParam;
    openModal(onlinePlayModal);
    joinRoomForm.style.display = 'block';
  }
}

window.addEventListener('DOMContentLoaded', initApp);
