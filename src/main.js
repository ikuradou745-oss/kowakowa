import { WerewolfAudio } from './audio.js';
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

// Active Online Room State
let activeRoomCode = null;
let roomUnsubscribe = null;
let isHost = false;

// --- Werewolf Roles Definitions for 「役職確認」 ---
const ROLES_DATA = [
  {
    id: 'villager',
    name: '市民 (村人)',
    icon: '🧑‍🌾',
    camp: 'villager',
    campName: '村人陣営',
    desc: '特殊な能力はありません。昼の議論と投票で誰が嘘をついているか見極め、人狼を追放しましょう。',
    winCondition: 'すべての人狼を処刑する'
  },
  {
    id: 'werewolf',
    name: '人狼 (ジンロウ)',
    icon: '🐺',
    camp: 'werewolf',
    campName: '人狼陣営',
    desc: '夜のターンに仲間の人狼と連携し、村人を1人選んで襲撃します。昼は村人のフリをして議論を混乱させましょう。',
    winCondition: '人狼の数が生存村人の数と同数以上になる'
  },
  {
    id: 'seer',
    name: '占い師 (預言者)',
    icon: '🔮',
    camp: 'villager',
    campName: '村人陣営',
    desc: '毎晩、誰か1人を占うことで、その人物が「人狼」か「人狼でない」かを知ることができます。村人側の最重要キーパーソンです。',
    winCondition: 'すべての人狼を処刑する'
  },
  {
    id: 'medium',
    name: '霊媒師 (霊能者)',
    icon: '🕯️',
    camp: 'villager',
    campName: '村人陣営',
    desc: '毎晩、その日の昼に処刑された人物が「人狼」だったのか「人狼でなかった」のかを霊視できます。占い師の真偽判定にも役立ちます。',
    winCondition: 'すべての人狼を処刑する'
  },
  {
    id: 'knight',
    name: '騎士 (狩人/ボディーガード)',
    icon: '🛡️',
    camp: 'villager',
    campName: '村人陣営',
    desc: '毎晩、自分以外の村人1人を指定して護衛します。人狼の襲撃対象と重なった場合、その夜の犠牲者を防ぐことができます。',
    winCondition: 'すべての人狼を処刑する'
  },
  {
    id: 'madman',
    name: '狂人 (裏切り者)',
    icon: '🤡',
    camp: 'werewolf',
    campName: '人狼陣営',
    desc: '人間の狂信者。誰が人狼かは分かりませんが、人狼陣営の勝利が自身の勝利となります。占い結果は「人狼でない」と出ます。',
    winCondition: '人狼陣営が勝利する'
  },
  {
    id: 'fox',
    name: '妖狐 (狐)',
    icon: '🦊',
    camp: 'third',
    campName: '第三陣営',
    desc: '村人陣営でも人狼陣営でもない単独勢力。人狼に襲撃されても死亡しませんが、占い師に占われると呪殺されます。最後まで生き残れば単独勝利！',
    winCondition: '村人か人狼のいずれかの決着時に生存していること'
  }
];

// --- Toast Notification Helper ---
let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('globalToast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2600);
}

// --- DOM Elements ---
const topNicknameChip = document.getElementById('topNicknameChip');
const topNicknameText = document.getElementById('topNicknameText');
const btnOpenSettings = document.getElementById('btnOpenSettings');

const btnOnlinePlay = document.getElementById('btnOnlinePlay');
const btnRoleGuide = document.getElementById('btnRoleGuide');

// Initial Nickname Modal
const initialNicknameModal = document.getElementById('initialNicknameModal');
const initialNicknameInput = document.getElementById('initialNicknameInput');
const initialCharCounter = document.getElementById('initialCharCounter');
const initialErrorMsg = document.getElementById('initialErrorMsg');
const btnConfirmInitialNickname = document.getElementById('btnConfirmInitialNickname');

// Settings Modal
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
const presetPills = document.querySelectorAll('.preset-pill');

// Role Guide Modal
const roleGuideModal = document.getElementById('roleGuideModal');
const btnCloseRoleGuide = document.getElementById('btnCloseRoleGuide');
const btnFinishRoleGuide = document.getElementById('btnFinishRoleGuide');
const rolesList = document.getElementById('rolesList');
const roleTabs = document.querySelectorAll('.role-tab');

// Online Play Modal
const onlinePlayModal = document.getElementById('onlinePlayModal');
const btnCloseOnlinePlay = document.getElementById('btnCloseOnlinePlay');
const onlineHubView = document.getElementById('onlineHubView');
const btnCardCreateRoom = document.getElementById('btnCardCreateRoom');
const btnCardShowJoinInput = document.getElementById('btnCardShowJoinInput');
const joinRoomForm = document.getElementById('joinRoomForm');
const roomCodeInput = document.getElementById('roomCodeInput');
const btnJoinRoomSubmit = document.getElementById('btnJoinRoomSubmit');
const joinRoomErrorMsg = document.getElementById('joinRoomErrorMsg');

const onlineLobbyView = document.getElementById('onlineLobbyView');
const lobbyRoomCodeText = document.getElementById('lobbyRoomCodeText');
const btnCopyRoomCode = document.getElementById('btnCopyRoomCode');
const lobbyPlayerCount = document.getElementById('lobbyPlayerCount');
const lobbyPlayerRoster = document.getElementById('lobbyPlayerRoster');
const btnLobbyStartGame = document.getElementById('btnLobbyStartGame');
const btnLeaveRoom = document.getElementById('btnLeaveRoom');

// --- Helper: Validate Nickname (2~8 chars) ---
function validateNickname(val) {
  const trimmed = (val || '').trim();
  return trimmed.length >= 2 && trimmed.length <= 8;
}

// --- Sync UI with Nickname ---
function updateNicknameDisplay(nickname) {
  topNicknameText.textContent = nickname || 'ゲスト';
  settingsNicknameInput.value = nickname;
  settingsCharCounter.textContent = `${nickname.length} / 8`;
}

// --- Save Profile to Firebase and LocalStorage ---
function applyNickname(nickname) {
  localNickname = nickname;
  localStorage.setItem('jinrou_nickname', nickname);
  updateNicknameDisplay(nickname);
  savePlayerProfile(localPlayerId, nickname, vcVolume);
}

// --- VC Volume Management ---
function updateVcVolumeUI(vol) {
  vcVolume = Math.max(50, Math.min(500, vol));
  vcVolumeSlider.value = vcVolume;
  vcVolumeDisplay.textContent = vcVolume;
  localStorage.setItem('jinrou_vc_volume', vcVolume.toString());
  sound.setVcVolume(vcVolume);

  // Update active preset pill
  presetPills.forEach((pill) => {
    const pVal = parseInt(pill.getAttribute('data-preset'), 10);
    if (pVal === vcVolume) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });
}

// Debounce helper for Firebase updates
let profileDebounce = null;
function scheduleProfileSync() {
  if (profileDebounce) clearTimeout(profileDebounce);
  profileDebounce = setTimeout(() => {
    if (localNickname) {
      savePlayerProfile(localPlayerId, localNickname, vcVolume);
    }
  }, 1000);
}

// --- Modal Utilities ---
function openModal(modalEl) {
  sound.playClick();
  modalEl.classList.add('active');
}

function closeModal(modalEl) {
  sound.playClick();
  modalEl.classList.remove('active');
}

// --- Render Role Guide Cards ---
function renderRoles(filterCamp = 'all') {
  rolesList.innerHTML = '';
  const filtered = filterCamp === 'all' 
    ? ROLES_DATA 
    : ROLES_DATA.filter((r) => r.camp === filterCamp);

  filtered.forEach((role) => {
    const card = document.createElement('div');
    card.className = 'role-card';

    let campBadgeClass = 'camp-villager';
    if (role.camp === 'werewolf') campBadgeClass = 'camp-werewolf';
    if (role.camp === 'third') campBadgeClass = 'camp-third';

    card.innerHTML = `
      <div class="role-card-header">
        <div class="role-name-row">
          <span>${role.icon}</span>
          <span>${role.name}</span>
        </div>
        <span class="camp-badge ${campBadgeClass}">${role.campName}</span>
      </div>
      <p class="role-desc">${role.desc}</p>
      <div class="role-win-condition">🏆 勝利条件: ${role.winCondition}</div>
    `;
    rolesList.appendChild(card);
  });
}

// --- Initial Setup / App Start ---
function initApp() {
  // Check if nickname already exists
  if (!localNickname || !validateNickname(localNickname)) {
    // Show initial nickname prompt modal
    initialNicknameModal.classList.add('active');
  } else {
    updateNicknameDisplay(localNickname);
    // Background fetch from Firebase
    fetchPlayerProfile(localPlayerId).then((profile) => {
      if (profile && profile.nickname && validateNickname(profile.nickname)) {
        localNickname = profile.nickname;
        localStorage.setItem('jinrou_nickname', profile.nickname);
        updateNicknameDisplay(profile.nickname);
      }
    });
  }

  // Set initial VC volume
  updateVcVolumeUI(vcVolume);

  // Render roles guide initial
  renderRoles('all');
}

// --- Event Listeners: Initial Nickname Modal ---
initialNicknameInput.addEventListener('input', (e) => {
  const len = e.target.value.length;
  initialCharCounter.textContent = `${len} / 8`;
  if (validateNickname(e.target.value)) {
    initialErrorMsg.classList.remove('visible');
  }
});

btnConfirmInitialNickname.addEventListener('click', () => {
  const candidate = (initialNicknameInput.value || '').trim();
  if (!validateNickname(candidate)) {
    initialErrorMsg.classList.add('visible');
    return;
  }
  applyNickname(candidate);
  initialNicknameModal.classList.remove('active');
  sound.playSuccess();
  showToast(`ニックネーム「${candidate}」で開始しました！`);
});

initialNicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    btnConfirmInitialNickname.click();
  }
});

// --- Event Listeners: Top-Right & Settings Modal ---
btnOpenSettings.addEventListener('click', () => {
  settingsNicknameInput.value = localNickname;
  settingsCharCounter.textContent = `${localNickname.length} / 8`;
  settingsErrorMsg.classList.remove('visible');
  openModal(settingsModal);
});

topNicknameChip.addEventListener('click', () => {
  btnOpenSettings.click();
});

btnCloseSettings.addEventListener('click', () => closeModal(settingsModal));
btnFinishSettings.addEventListener('click', () => closeModal(settingsModal));

settingsNicknameInput.addEventListener('input', (e) => {
  const len = e.target.value.length;
  settingsCharCounter.textContent = `${len} / 8`;
  if (validateNickname(e.target.value)) {
    settingsErrorMsg.classList.remove('visible');
  }
});

btnSaveNickname.addEventListener('click', () => {
  const candidate = (settingsNicknameInput.value || '').trim();
  if (!validateNickname(candidate)) {
    settingsErrorMsg.classList.add('visible');
    return;
  }
  applyNickname(candidate);
  sound.playSuccess();
  showToast(`ニックネームを「${candidate}」に変更しました`);
});

// VC Volume Slider
vcVolumeSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  updateVcVolumeUI(val);
  scheduleProfileSync();
});

// Preset Pills (50% ~ 500%)
presetPills.forEach((pill) => {
  pill.addEventListener('click', () => {
    const val = parseInt(pill.getAttribute('data-preset'), 10);
    sound.playClick();
    updateVcVolumeUI(val);
    scheduleProfileSync();
  });
});

// VC Volume Test Sound Button
btnTestVolume.addEventListener('click', () => {
  sound.playVcTest();
  showToast(`🔊 VC音量テスト再生中 (${vcVolume}%)`);
});

// --- Event Listeners: 役職確認 (Role Guide) ---
btnRoleGuide.addEventListener('click', () => {
  openModal(roleGuideModal);
});

btnCloseRoleGuide.addEventListener('click', () => closeModal(roleGuideModal));
btnFinishRoleGuide.addEventListener('click', () => closeModal(roleGuideModal));

roleTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    sound.playClick();
    roleTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const camp = tab.getAttribute('data-camp');
    renderRoles(camp);
  });
});

// --- Event Listeners: オンラインプレイ (Online Play) ---
btnOnlinePlay.addEventListener('click', () => {
  if (!activeRoomCode) {
    onlineHubView.style.display = 'block';
    onlineLobbyView.style.display = 'none';
  } else {
    onlineHubView.style.display = 'none';
    onlineLobbyView.style.display = 'block';
  }
  openModal(onlinePlayModal);
});

btnCloseOnlinePlay.addEventListener('click', () => closeModal(onlinePlayModal));

// Toggle Join Room input
btnCardShowJoinInput.addEventListener('click', () => {
  sound.playClick();
  joinRoomForm.style.display = joinRoomForm.style.display === 'none' ? 'block' : 'none';
  if (joinRoomForm.style.display === 'block') {
    roomCodeInput.focus();
  }
});

// Create Room Handler
btnCardCreateRoom.addEventListener('click', async () => {
  sound.playClick();
  btnCardCreateRoom.style.pointerEvents = 'none';
  try {
    const generatedCode = Math.floor(1000 + Math.random() * 9000).toString();
    showToast('部屋を作成中...');
    const roomData = await createFirestoreRoom(generatedCode, localPlayerId, localNickname);

    activeRoomCode = generatedCode;
    isHost = true;
    enterLobbyView(generatedCode, {
      players: roomData ? roomData.players : { [localPlayerId]: { nickname: localNickname, isHost: true } }
    });

    // Subscribe to Firestore room updates
    subscribeRoomUpdates(generatedCode);
    showToast(`部屋 #${generatedCode} を作成しました！`);
  } catch (err) {
    showToast('部屋作成に失敗しました: ' + err.message);
  } finally {
    btnCardCreateRoom.style.pointerEvents = 'auto';
  }
});

// Join Room Handler
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
    subscribeRoomUpdates(code);
    showToast(`部屋 #${code} に参加しました！`);
  } catch (err) {
    joinRoomErrorMsg.textContent = err.message || '部屋が見つかりませんでした';
    joinRoomErrorMsg.classList.add('visible');
  } finally {
    btnJoinRoomSubmit.disabled = false;
  }
});

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    btnJoinRoomSubmit.click();
  }
});

function enterLobbyView(code, roomData) {
  onlineHubView.style.display = 'none';
  onlineLobbyView.style.display = 'block';
  lobbyRoomCodeText.textContent = `#${code}`;
  updateLobbyPlayersList(roomData ? roomData.players : null);
}

function updateLobbyPlayersList(playersObj) {
  lobbyPlayerRoster.innerHTML = '';
  const players = playersObj ? Object.values(playersObj) : [];
  lobbyPlayerCount.textContent = players.length;

  if (players.length === 0) {
    const item = document.createElement('div');
    item.className = 'lobby-player-item';
    item.innerHTML = `<span>${localNickname} (あなた)</span><span class="lobby-player-host-tag">ホスト</span>`;
    lobbyPlayerRoster.appendChild(item);
  } else {
    players.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'lobby-player-item';
      const isMe = p.id === localPlayerId;
      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>👤</span>
          <span>${p.nickname} ${isMe ? '<strong style="color: #38bdf8;">(あなた)</strong>' : ''}</span>
        </div>
        ${p.isHost ? '<span class="lobby-player-host-tag">ホスト</span>' : ''}
      `;
      lobbyPlayerRoster.appendChild(item);
    });
  }

  // Show host controls if host
  if (isHost) {
    btnLobbyStartGame.style.display = 'inline-block';
  } else {
    btnLobbyStartGame.style.display = 'none';
  }
}

function subscribeRoomUpdates(code) {
  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }
  roomUnsubscribe = subscribeToRoom(code, (data) => {
    if (data) {
      isHost = (data.hostId === localPlayerId);
      updateLobbyPlayersList(data.players);
    }
  }, (err) => {
    console.warn("Room sync:", err);
  });
}

// Copy Room Code Button
btnCopyRoomCode.addEventListener('click', () => {
  if (!activeRoomCode) return;
  sound.playClick();
  navigator.clipboard.writeText(activeRoomCode).then(() => {
    showToast(`部屋コード #${activeRoomCode} をコピーしました！`);
  }).catch(() => {
    showToast(`部屋コード: ${activeRoomCode}`);
  });
});

// Leave Room Button
btnLeaveRoom.addEventListener('click', async () => {
  sound.playClick();
  if (activeRoomCode) {
    await leaveFirestoreRoom(activeRoomCode, localPlayerId);
  }
  if (roomUnsubscribe) {
    roomUnsubscribe();
    roomUnsubscribe = null;
  }
  activeRoomCode = null;
  isHost = false;
  onlineLobbyView.style.display = 'none';
  onlineHubView.style.display = 'block';
  showToast('部屋を退出しました');
});

// Start Game from Lobby
btnLobbyStartGame.addEventListener('click', () => {
  sound.playWolfHowl();
  showToast('🐺 まもなくゲームが開始されます（配役準備中）');
});

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
