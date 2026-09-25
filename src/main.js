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

// Coin System (Defaults to 500 so user can test-unlock roles immediately)
let userCoins = parseInt(localStorage.getItem('jinrou_coins'), 10);
if (isNaN(userCoins) || userCoins < 0) {
  userCoins = 500;
  localStorage.setItem('jinrou_coins', userCoins.toString());
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

// --- Basic Roles Definitions for 「役職確認」 (Specified Order) ---
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

// --- Shop Roles Definitions (Specified Order & Details) ---
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
    desc: '追放、または死亡時味方一人を道連れにする。命を落とす瞬間に指定した相手を道連れにします。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'archer',
    name: 'アーチ',
    icon: '🏹',
    cost: 300,
    camp: 'villager',
    campName: '村人チーム',
    desc: '弓使い。夜のターンに1度だけ人を選んで殺害できる（夜のターンに一度だけで、夜のターンに使うか使わないかを選べる）。',
    winCondition: 'すべての人狼を追放する'
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
  }, 2800);
}

// --- DOM Elements ---
const topNicknameChip = document.getElementById('topNicknameChip');
const topNicknameText = document.getElementById('topNicknameText');
const btnOpenSettings = document.getElementById('btnOpenSettings');

const topCoinsChip = document.getElementById('topCoinsChip');
const topCoinsDisplay = document.getElementById('topCoinsDisplay');

const btnOnlinePlay = document.getElementById('btnOnlinePlay');
const btnRoleGuide = document.getElementById('btnRoleGuide');
const btnOpenShop = document.getElementById('btnOpenShop');

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

// Shop Modal
const shopModal = document.getElementById('shopModal');
const btnCloseShop = document.getElementById('btnCloseShop');
const btnFinishShop = document.getElementById('btnFinishShop');
const shopCoinsDisplay = document.getElementById('shopCoinsDisplay');
const btnTestAddCoins = document.getElementById('btnTestAddCoins');
const shopItemsList = document.getElementById('shopItemsList');

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

// --- Sync Coins UI ---
function updateCoinsDisplay() {
  if (topCoinsDisplay) topCoinsDisplay.textContent = userCoins.toLocaleString();
  if (shopCoinsDisplay) shopCoinsDisplay.textContent = userCoins.toLocaleString();
  localStorage.setItem('jinrou_coins', userCoins.toString());
}

// --- Save Profile to Firebase and LocalStorage ---
function applyNickname(nickname) {
  localNickname = nickname;
  localStorage.setItem('jinrou_nickname', nickname);
  updateNicknameDisplay(nickname);
  savePlayerProfile(localPlayerId, nickname, vcVolume, userCoins, unlockedRoles);
}

// Debounce helper for Firebase updates
let profileDebounce = null;
function scheduleProfileSync() {
  if (profileDebounce) clearTimeout(profileDebounce);
  profileDebounce = setTimeout(() => {
    if (localNickname) {
      savePlayerProfile(localPlayerId, localNickname, vcVolume, userCoins, unlockedRoles);
    }
  }, 1000);
}

// --- VC Volume Management ---
function updateVcVolumeUI(vol) {
  vcVolume = Math.max(50, Math.min(500, vol));
  vcVolumeSlider.value = vcVolume;
  vcVolumeDisplay.textContent = vcVolume;
  localStorage.setItem('jinrou_vc_volume', vcVolume.toString());
  sound.setVcVolume(vcVolume);

  presetPills.forEach((pill) => {
    const pVal = parseInt(pill.getAttribute('data-preset'), 10);
    if (pVal === vcVolume) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });
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

  let listToDisplay = [];
  if (filterCamp === 'all') {
    // 6 Base roles first, followed by Shop roles
    listToDisplay = [...BASE_ROLES, ...SHOP_ROLES.map(r => ({ ...r, isShopRole: true }))];
  } else if (filterCamp === 'villager') {
    const baseV = BASE_ROLES.filter(r => r.camp === 'villager');
    const shopV = SHOP_ROLES.filter(r => r.camp === 'villager').map(r => ({ ...r, isShopRole: true }));
    listToDisplay = [...baseV, ...shopV];
  } else if (filterCamp === 'werewolf') {
    listToDisplay = BASE_ROLES.filter(r => r.camp === 'werewolf');
  } else if (filterCamp === 'shop') {
    listToDisplay = SHOP_ROLES.map(r => ({ ...r, isShopRole: true }));
  }

  listToDisplay.forEach((role) => {
    const card = document.createElement('div');
    card.className = 'role-card';

    let campBadgeClass = 'camp-villager';
    if (role.camp === 'werewolf') campBadgeClass = 'camp-werewolf';

    let shopBadgeHtml = '';
    if (role.isShopRole) {
      const isUnlocked = unlockedRoles.includes(role.id);
      if (isUnlocked) {
        shopBadgeHtml = `<span class="role-shop-badge unlocked">✅ 解放済み</span>`;
      } else {
        shopBadgeHtml = `<span class="role-shop-badge locked" data-role-id="${role.id}">🔒 ショップで開放 (${role.cost}C)</span>`;
      }
    }

    card.innerHTML = `
      <div class="role-card-header">
        <div class="role-name-row">
          <span>${role.icon}</span>
          <span>${role.name}</span>
          ${shopBadgeHtml}
        </div>
        <span class="camp-badge ${campBadgeClass}">${role.campName}</span>
      </div>
      <p class="role-desc">${role.desc}</p>
      <div class="role-win-condition">🏆 勝利条件: ${role.winCondition}</div>
    `;

    // Click handler for locked shop badge to jump to shop
    const lockedBadge = card.querySelector('.role-shop-badge.locked');
    if (lockedBadge) {
      lockedBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        closeModal(roleGuideModal);
        openShopModal();
      });
    }

    rolesList.appendChild(card);
  });
}

// --- Render Shop Modal ---
function renderShop() {
  updateCoinsDisplay();
  shopItemsList.innerHTML = '';

  SHOP_ROLES.forEach((role) => {
    const isUnlocked = unlockedRoles.includes(role.id);
    const card = document.createElement('div');
    card.className = `shop-card ${isUnlocked ? 'unlocked-card' : ''}`;

    let actionBtnHtml = '';
    if (isUnlocked) {
      actionBtnHtml = `<span class="badge-unlocked-status">✅ 開放済み</span>`;
    } else {
      const canAfford = userCoins >= role.cost;
      actionBtnHtml = `
        <button class="btn-buy-role" data-role-id="${role.id}" ${canAfford ? '' : 'disabled'}>
          <span>🪙 ${role.cost}コインで開放</span>
        </button>
      `;
    }

    card.innerHTML = `
      <div class="shop-card-header">
        <div class="shop-role-name">
          <span style="font-size: 1.4rem;">${role.icon}</span>
          <span>${role.name}</span>
          <span class="camp-badge camp-villager">${role.campName}</span>
        </div>
        <span class="shop-cost-tag">🪙 ${role.cost} コイン</span>
      </div>
      <p class="shop-card-desc">${role.desc}</p>
      <div class="shop-card-footer">
        <span style="font-size: 0.78rem; color: #94a3b8;">勝利条件: ${role.winCondition}</span>
        <div>${actionBtnHtml}</div>
      </div>
    `;

    // Bind purchase event
    const buyBtn = card.querySelector('.btn-buy-role');
    if (buyBtn && !isUnlocked) {
      buyBtn.addEventListener('click', () => {
        handlePurchaseRole(role);
      });
    }

    shopItemsList.appendChild(card);
  });
}

// --- Handle Role Purchase ---
function handlePurchaseRole(role) {
  if (unlockedRoles.includes(role.id)) {
    showToast(`役職「${role.name}」は既に開放済みです`);
    return;
  }
  if (userCoins < role.cost) {
    showToast(`🪙 コインが足りません（必要: ${role.cost}コイン / 所持: ${userCoins}コイン）`);
    return;
  }

  // Deduct coins & unlock
  userCoins -= role.cost;
  unlockedRoles.push(role.id);
  localStorage.setItem('jinrou_unlocked_roles', JSON.stringify(unlockedRoles));
  updateCoinsDisplay();

  // Play fanfare sound
  sound.playUnlockSound();
  showToast(`🎉 新役職「${role.name}」を開放しました！`);

  // Sync to Firebase
  scheduleProfileSync();

  // Re-render
  renderShop();
  renderRoles('all');
}

function openShopModal() {
  renderShop();
  openModal(shopModal);
}

// --- Initial Setup / App Start ---
function initApp() {
  updateCoinsDisplay();

  // Check if nickname already exists
  if (!localNickname || !validateNickname(localNickname)) {
    initialNicknameModal.classList.add('active');
  } else {
    updateNicknameDisplay(localNickname);
    // Background fetch from Firebase
    fetchPlayerProfile(localPlayerId).then((profile) => {
      if (profile) {
        if (profile.nickname && validateNickname(profile.nickname)) {
          localNickname = profile.nickname;
          localStorage.setItem('jinrou_nickname', profile.nickname);
          updateNicknameDisplay(profile.nickname);
        }
        if (typeof profile.coins === 'number') {
          userCoins = profile.coins;
          localStorage.setItem('jinrou_coins', userCoins.toString());
          updateCoinsDisplay();
        }
        if (Array.isArray(profile.unlockedRoles)) {
          unlockedRoles = profile.unlockedRoles;
          localStorage.setItem('jinrou_unlocked_roles', JSON.stringify(unlockedRoles));
        }
        renderRoles('all');
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
  renderRoles('all');
  roleTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-camp') === 'all'));
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

// --- Event Listeners: ショップ (Role Shop) ---
btnOpenShop.addEventListener('click', () => {
  openShopModal();
});

topCoinsChip.addEventListener('click', () => {
  openShopModal();
});

btnCloseShop.addEventListener('click', () => closeModal(shopModal));
btnFinishShop.addEventListener('click', () => closeModal(shopModal));

// Test Coin Add Button
btnTestAddCoins.addEventListener('click', () => {
  sound.playCoinSound();
  userCoins += 100;
  updateCoinsDisplay();
  scheduleProfileSync();
  renderShop();
  renderRoles('all');
  showToast(`🪙 100コインを獲得しました！(所持: ${userCoins}コイン)`);
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
