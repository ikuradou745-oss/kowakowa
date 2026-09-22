import * as THREE from 'three';
import { SoundEngine } from './audio.js';
import { RoomManager } from './firebase.js';

// --- Sound Engine & Multiplayer State ---
const sound = new SoundEngine();
let roomManager = null;
let localPlayerId = 'p_' + Math.random().toString(36).substring(2, 9);
let localPlayerName = '生徒_' + Math.floor(100 + Math.random() * 900);
let selectedItem = 'flashlight'; // 'flashlight', 'bandage', 'drink'
let isSlot1Held = true;

// Character Customization State
let characterCustomization = {
  shirtColor: '#e74c3c',
  pantsColor: '#1a252f',
  skinColor: '#ffd32a',
  hat: 'none' // 'none', 'cap', 'fedora', 'crown', 'helmet'
};

try {
  const saved = localStorage.getItem('kowakowa_school_custom');
  if (saved) {
    characterCustomization = Object.assign(characterCustomization, JSON.parse(saved));
  }
} catch (e) {}

// Game Progression State
let gameState = 'title'; // 'title', 'lobby', 'playing', 'transition', 'cleared'
let currentStage = 1; // 1 to 5
const MAX_STAGES = 5;

const STAGE_CONFIGS = [
  {
    stage: 1,
    title: '1階 普通教室・廊下の迷路',
    monstersText: '出現: ⬛影のバケモノ (隠れろ [E])',
    allowedMonsters: ['black'],
    nextWait: 22
  },
  {
    stage: 2,
    title: '2階 旧特別教室街の迷路',
    monstersText: '出現: ⬛影 / 🟥首刈り鎌 (しゃがめ [C])',
    allowedMonsters: ['black', 'red'],
    nextWait: 19
  },
  {
    stage: 3,
    title: '3階 理科室・標本室・音楽室の迷路',
    monstersText: '出現: ⬛影 / 🟥首刈り / 🟦床怨霊 (跳べ [Space])',
    allowedMonsters: ['black', 'red', 'blue'],
    nextWait: 17
  },
  {
    stage: 4,
    title: '渡り廊下と旧地下倉庫の迷路',
    monstersText: '出現: ⬛影 / 🟥首刈り / 🟦床怨霊 / 🟪呪い人形 (消灯 [1])',
    allowedMonsters: ['black', 'red', 'blue', 'purple'],
    nextWait: 15
  },
  {
    stage: 5,
    title: '最深部 旧講堂・大脱出の迷路 (最終)',
    monstersText: '出現: 全4種が連続襲撃！正門へ逃げろ！',
    allowedMonsters: ['black', 'red', 'blue', 'purple'],
    nextWait: 13
  }
];

// Player State & Physics
let isHidden = false;
let currentHidingSpot = null;
let isDead = false;
let hasCleared = false;
let bandageUsed = false;
let drinkCooldown = 0;
let drinkActiveTimer = 0;

let isCrouching = false;
let targetCameraY = 1.6;
let playerY = 1.6;
let playerVy = 0;
const GRAVITY = -22;
const JUMP_VELOCITY = 6.4;
const STAND_HEIGHT = 1.6;
const CROUCH_HEIGHT = 0.75;
const HIDE_HEIGHT = 0.35;

// Monsters: 4 Entities with color-coded flickers
// 1. Black: Blackout 3 flickers -> Must HIDE [E]
// 2. Red: Crimson 3 flickers -> Must CROUCH [C]
// 3. Blue: Blue 3 flickers -> Must JUMP [Space]
// 4. Purple: Purple 3 flickers -> Must TURN OFF FLASHLIGHT [1]
let currentMonsterType = null;
let isWarningActive = false;
let isMonsterRushing = false;
let monsterProgress = 0;
let nextMonsterTimer = 20;
let monsterSpawnPos = new THREE.Vector3();
let monsterTargetPos = new THREE.Vector3();

// Three.js instances
let scene, camera, renderer;
let flashlightLight, ambientLight, schoolMoonLight;
let currentStageGroup = null; // Container for current stage (disposed on clear)
let mazeWalls = []; // Bounding boxes for collision
let hidingSpots = []; // Bed/Locker objects
let exitDoorPos = new THREE.Vector3();
let spawnWorldPos = new THREE.Vector3();
let otherPlayerMeshes = {};
let firstPersonFlashlightMesh;

// Monster Groups
let blackMonsterGroup, redMonsterGroup, blueMonsterGroup, purpleMonsterGroup;

// Shared Textures (generated once for max performance)
let woodFloorTexture, woodWallTexture, blackboardTexture, gymFloorTexture, noticeBoardTexture, shoeLockerTexture;

// Controls
const keys = { w: false, a: false, s: false, d: false, shift: false };
let isPointerLocked = false;
let headBobTimer = 0;
let footstepTimer = 0;
let syncTimer = 0;

// DOM Elements
const hudElement = document.getElementById('hud');
const titleScreen = document.getElementById('titleScreen');
const lobbyScreen = document.getElementById('lobbyScreen');
const clearScreen = document.getElementById('clearScreen');
const stageTransitionOverlay = document.getElementById('stageTransitionOverlay');
const transitionTitle = document.getElementById('transitionTitle');
const transitionDesc = document.getElementById('transitionDesc');
const hudStageBadge = document.getElementById('hudStageBadge');
const hudStageTitle = document.getElementById('hudStageTitle');
const hudStageMonsters = document.getElementById('hudStageMonsters');
const interactPrompt = document.getElementById('interactPrompt');
const warningOverlay = document.getElementById('warningOverlay');
const jumpscareOverlay = document.getElementById('jumpscareOverlay');
const stanceBadge = document.getElementById('stanceBadge');
const stanceIcon = document.getElementById('stanceIcon');
const stanceText = document.getElementById('stanceText');
const drinkCooldownBar = document.getElementById('drinkCooldownBar');
const drinkBtn = document.getElementById('drinkBtn');
const hideBtn = document.getElementById('hideBtn');
const crouchBtn = document.getElementById('crouchBtn');
const jumpBtn = document.getElementById('jumpBtn');
const hotbarSlot1 = document.getElementById('hotbarSlot1');
const slotIcon = document.getElementById('slotIcon');
const slotLabel = document.getElementById('slotLabel');
const slotState = document.getElementById('slotState');
const homeDeathToast = document.getElementById('homeDeathToast');
const partyList = document.getElementById('partyList');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const startPartyBtn = document.getElementById('startPartyBtn');
const leaveLobbyBtn = document.getElementById('leaveLobbyBtn');
const copyCodeBtn = document.getElementById('copyCodeBtn');

// --- Procedural Japanese Old Wooden School Textures ---
function createWoodFloorTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Weathered Japanese cedar/oak floorboards (brightened for clear visibility)
  ctx.fillStyle = '#4e3a29';
  ctx.fillRect(0, 0, 256, 256);

  // Planks
  const plankH = 32;
  for (let y = 0; y < 256; y += plankH) {
    ctx.fillStyle = (y % (plankH * 2) === 0) ? '#5c4532' : '#523e2c';
    ctx.fillRect(0, y, 256, plankH - 2);

    ctx.strokeStyle = '#2b1f15';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y + plankH - 1);
    ctx.lineTo(256, y + plankH - 1);
    ctx.stroke();

    // Wood grain lines
    for (let x = 0; x < 256; x += 18) {
      ctx.fillStyle = 'rgba(20, 14, 8, 0.12)';
      ctx.fillRect(x + (y % 16), y, 8, plankH - 2);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function createWoodWallTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Old wooden school classroom wall / sliding door partition (clearly visible wood tones)
  ctx.fillStyle = '#6b523b';
  ctx.fillRect(0, 0, 256, 256);

  // Vertical wood paneling
  for (let x = 0; x < 256; x += 24) {
    ctx.fillStyle = (x % 48 === 0) ? '#785d43' : '#664e38';
    ctx.fillRect(x, 0, 22, 256);

    ctx.strokeStyle = '#38281b';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, 0, 24, 256);
  }

  // Cross beam
  ctx.fillStyle = '#4c3624';
  ctx.fillRect(0, 120, 256, 16);
  ctx.fillRect(0, 235, 256, 21);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function createBlackboardTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // Dark green classic Japanese school chalkboard
  ctx.fillStyle = '#1e382b';
  ctx.fillRect(0, 0, 256, 128);

  // Wood frame border
  ctx.strokeStyle = '#5a3d28';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, 248, 120);

  // Chalk smudges
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('第　時　限', 25, 45);
  ctx.fillText('〜 脱出せよ 〜', 25, 80);

  return new THREE.CanvasTexture(canvas);
}

function createGymFloorTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Hardwood gym court floor
  ctx.fillStyle = '#b8864a';
  ctx.fillRect(0, 0, 256, 256);

  // Planks
  for (let y = 0; y < 256; y += 16) {
    ctx.fillStyle = (y % 32 === 0) ? '#c49354' : '#b27f42';
    ctx.fillRect(0, y, 256, 15);
  }

  // White court lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(128, 128, 64, 0, Math.PI * 2);
  ctx.moveTo(0, 128);
  ctx.lineTo(256, 128);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function createNoticeBoardTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // Corkboard base
  ctx.fillStyle = '#8f683a';
  ctx.fillRect(0, 0, 256, 128);

  // Wood frame
  ctx.strokeStyle = '#4a3018';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 250, 122);

  // School announcements / Calligraphy posters (習字)
  ctx.fillStyle = '#f8f4e8';
  ctx.fillRect(16, 16, 60, 96);
  ctx.fillRect(92, 16, 70, 96);
  ctx.fillRect(178, 16, 62, 96);

  ctx.fillStyle = '#111111';
  ctx.font = 'bold 22px serif';
  ctx.fillText('希望', 26, 64);
  ctx.fillText('前進', 104, 64);
  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#c0392b';
  ctx.fillText('【緊急連絡】', 182, 38);
  ctx.fillStyle = '#222';
  ctx.fillText('日没後退去', 182, 60);

  return new THREE.CanvasTexture(canvas);
}

function createShoeLockerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Japanese wooden getabako (shoe cubby rack)
  ctx.fillStyle = '#5c432d';
  ctx.fillRect(0, 0, 256, 256);

  // Grid of cubbies
  ctx.strokeStyle = '#2b1c10';
  ctx.lineWidth = 4;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * 64;
      const y = r * 64;
      ctx.strokeRect(x, y, 64, 64);

      // Dark interior
      ctx.fillStyle = '#1e140d';
      ctx.fillRect(x + 6, y + 6, 52, 52);

      // Slippers / Uwabaki inside
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(x + 14, y + 36, 16, 12);
      ctx.fillRect(x + 34, y + 36, 16, 12);
      // Red toe band
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(x + 14, y + 36, 16, 4);
      ctx.fillRect(x + 34, y + 36, 16, 4);
    }
  }

  return new THREE.CanvasTexture(canvas);
}

// --- Application Bootstrap ---
window.addEventListener('DOMContentLoaded', () => {
  initThree();
  buildFirstPersonFlashlight();
  buildAllMonsters();
  loadStage(1);
  setupEventListeners();
  setupCustomizerUI();

  // Animation Loop
  let lastTime = performance.now();
  function animate(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    if (gameState === 'playing') {
      updateGame(dt);
    } else if (gameState === 'title' || gameState === 'lobby') {
      updateCinematicCamera(now);
    }

    renderThree(dt);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
});

// --- High-Performance Three.js Setup (Shadows disabled, lightweight materials) ---
function initThree() {
  const container = document.getElementById('canvasContainer');
  scene = new THREE.Scene();
  // Atmospheric dim midnight blue background
  scene.background = new THREE.Color(0x181c25);
  // Soft linear fog that starts well ahead (18m) so near/medium range is 100% clear and visible
  scene.fog = new THREE.Fog(0x181c25, 18, 55);

  camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, 90);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, STAND_HEIGHT, 0);

  // High performance: no shadow maps, controlled pixel ratio
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = false; // Disabled for buttery 60 FPS
  container.appendChild(renderer.domElement);

  // Ambient night school light - soft, clearly visible (not pitch black!)
  ambientLight = new THREE.AmbientLight(0x8a8276, 1.35);
  scene.add(ambientLight);

  // Soft cold moonlight through school windows
  schoolMoonLight = new THREE.DirectionalLight(0x8ea2be, 0.95);
  schoolMoonLight.position.set(20, 30, 10);
  scene.add(schoolMoonLight);

  // Warm fill light for corridors
  const schoolFillLight = new THREE.DirectionalLight(0x807060, 0.55);
  schoolFillLight.position.set(-20, 25, -15);
  scene.add(schoolFillLight);

  // Player Flashlight: Wide beam, clear and bright illumination
  flashlightLight = new THREE.SpotLight(0xfffaec, 4.2, 45, Math.PI / 3.8, 0.25, 1.0);
  flashlightLight.position.set(0, 0, 0);
  flashlightLight.target = new THREE.Object3D();
  scene.add(flashlightLight.target);
  camera.add(flashlightLight);
  scene.add(camera);

  // Initialize shared procedural textures
  woodFloorTexture = createWoodFloorTexture();
  woodWallTexture = createWoodWallTexture();
  blackboardTexture = createBlackboardTexture();
  gymFloorTexture = createGymFloorTexture();
  noticeBoardTexture = createNoticeBoardTexture();
  shoeLockerTexture = createShoeLockerTexture();

  window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- First-Person 3D Flashlight in Hand ---
function buildFirstPersonFlashlight() {
  firstPersonFlashlightMesh = new THREE.Group();

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x1f2329 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.26, 12), bodyMat);
  body.rotation.x = Math.PI / 2;
  firstPersonFlashlightMesh.add(body);

  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.038, 0.09, 12), bodyMat);
  head.rotation.x = Math.PI / 2;
  head.position.z = -0.15;
  firstPersonFlashlightMesh.add(head);

  const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.054, 12), lensMat);
  lens.rotation.y = Math.PI;
  lens.position.z = -0.196;
  firstPersonFlashlightMesh.add(lens);

  firstPersonFlashlightMesh.position.set(0.22, -0.2, -0.38);
  camera.add(firstPersonFlashlightMesh);
  updateFlashlightVisibility();
}

function updateFlashlightVisibility() {
  const isHeld = (selectedItem === 'flashlight' && isSlot1Held && gameState === 'playing');
  if (firstPersonFlashlightMesh) firstPersonFlashlightMesh.visible = isHeld;
  if (flashlightLight) flashlightLight.visible = isHeld;
}

// --- Dynamic 5-Stage Maze Generator with Total Memory Disposal ---
// CELL_SIZE = 4m per maze block
const CELL_SIZE = 4.0;
const WALL_HEIGHT = 3.5;

// Layout definitions for Stages 1 to 5
// 0: Floor/Corridor, 1: Wood Wall, 2: Hiding spot (Bed/Locker), 3: Exit Stairs/Gate, 4: Player Spawn
// 10: Student Desk/Chair, 11: Teacher Podium & Chalkboard, 12: Shoe Locker, 13: Notice Board & Extinguisher
// 14: Science Lab Bench, 15: Anatomy Skeleton, 16: Music Grand Piano, 17: Library Bookshelves, 18: Gym Equipment
const STAGE_MAZES = [
  // Stage 1: 1階 普通教室棟・保健室・昇降口 (14x14)
  [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1,11, 0, 0, 1,11, 0, 0, 1, 2, 0, 2, 1, 1],
    [1, 4,10,10, 1, 0,10,10, 1, 0, 0, 0, 1, 1],
    [1, 0,10,10, 0, 0,10,10, 0, 0, 2, 0, 1, 1],
    [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1,13, 0,12, 0,13, 0,12, 0,13, 0,12, 0, 1],
    [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1],
    [1,10,10, 0, 1,10,10, 0, 1, 0, 2, 0, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1,12,12, 0, 0, 0,12,12, 0, 0, 0, 0, 3, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  ],
  // Stage 2: 2階 理科実験室・標本室・準備室 (14x14)
  [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1,11, 0, 0, 1,14, 0,14, 1,14, 0,14, 1, 1],
    [1, 4,10, 0, 1, 0,15, 0, 1, 0, 0, 0, 1, 1],
    [1, 0,10, 0, 0,14, 0,14, 0,14, 0,14, 1, 1],
    [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1,13, 0,12, 0,13, 0, 2, 0,13, 0,12, 0, 1],
    [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1],
    [1, 2, 0, 2, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1],
    [1, 0, 0, 0, 1,14, 0,14, 1, 0, 2, 0, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 3, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  ],
  // Stage 3: 3階 音楽室・美術室棟 (15x15)
  [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1,11, 0, 0, 1,16, 0, 0, 0, 1, 0, 0, 0, 2, 1],
    [1, 4,10, 0, 1, 0, 0,10,10, 1, 0,10,10, 0, 1],
    [1, 0,10, 0, 0, 0, 0,10,10, 0, 0,10,10, 0, 1],
    [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1,13, 0,12, 0,13, 0, 2, 0,13, 0,12, 0,13, 1],
    [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1],
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 1],
    [1,10, 0,10, 1,10, 0,10, 1, 0, 2, 0, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 2, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 3, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  ],
  // Stage 4: 別館 図書室迷路・旧校長室 (15x15)
  [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 4, 0, 0, 1,17, 0,17, 0,17, 1, 0, 0, 2, 1],
    [1, 0,17, 0, 1, 0, 0, 0, 0, 0, 1, 0, 2, 0, 1],
    [1, 0,17, 0, 0,17, 0,17, 0,17, 0, 0, 0, 0, 1],
    [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1,13, 0,12, 0,13, 0, 2, 0,13, 0,12, 0,13, 1],
    [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1],
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 1],
    [1,10, 0,10, 1,17, 0,17, 1, 0, 2, 0, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 2, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 3, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  ],
  // Stage 5: 最深部 体育館・大講堂・大脱出ゲート (16x16)
  [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1],
    [1, 0, 0,18, 0, 0, 0, 0, 0, 0,18, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0,18, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0,18, 0, 1],
    [1, 0, 0, 0, 0, 1, 2, 0, 0, 2, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0,18, 0, 0,18, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  ]
];

// Load and build a stage, thoroughly disposing previous stage
function loadStage(stageNum) {
  currentStage = stageNum;

  // 1. Destroy and dispose old stage completely
  if (currentStageGroup) {
    currentStageGroup.traverse((child) => {
      if (child.isMesh) {
        if (child.geometry) child.geometry.dispose();
      }
    });
    scene.remove(currentStageGroup);
    currentStageGroup = null;
  }

  mazeWalls = [];
  hidingSpots = [];
  exitDoorPos.set(0, 0, 0);

  // 2. Build new stage
  currentStageGroup = new THREE.Group();
  scene.add(currentStageGroup);

  const grid = STAGE_MAZES[stageNum - 1];
  const rows = grid.length;
  const cols = grid[0].length;
  const totalW = cols * CELL_SIZE;
  const totalL = rows * CELL_SIZE;

  // Scan grid for player spawn point (type === 4)
  let spawnFound = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === 4) {
        spawnWorldPos.set(c * CELL_SIZE, STAND_HEIGHT, r * CELL_SIZE);
        spawnFound = true;
        break;
      }
    }
    if (spawnFound) break;
  }
  if (!spawnFound) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c] === 0) {
          spawnWorldPos.set(c * CELL_SIZE, STAND_HEIGHT, r * CELL_SIZE);
          spawnFound = true;
          break;
        }
      }
      if (spawnFound) break;
    }
  }

  // Floor & Ceiling with shared Lambert material (lightweight & visible)
  const floorMat = new THREE.MeshLambertMaterial({ map: (stageNum === 5 ? gymFloorTexture : woodFloorTexture) });
  const ceilingMat = new THREE.MeshLambertMaterial({ color: 0x423428 });
  const wallMat = new THREE.MeshLambertMaterial({ map: woodWallTexture });

  const floorGeo = new THREE.PlaneGeometry(totalW, totalL);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(totalW / 2 - CELL_SIZE / 2, 0, totalL / 2 - CELL_SIZE / 2);
  currentStageGroup.add(floor);

  const ceiling = new THREE.Mesh(floorGeo, ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(totalW / 2 - CELL_SIZE / 2, WALL_HEIGHT, totalL / 2 - CELL_SIZE / 2);
  currentStageGroup.add(ceiling);

  const wallGeo = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, CELL_SIZE);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const type = grid[r][c];
      const wx = c * CELL_SIZE;
      const wz = r * CELL_SIZE;

      if (type === 1) {
        const wall = new THREE.Mesh(wallGeo, wallMat);
        wall.position.set(wx, WALL_HEIGHT / 2, wz);
        currentStageGroup.add(wall);

        mazeWalls.push({
          minX: wx - CELL_SIZE / 2,
          maxX: wx + CELL_SIZE / 2,
          minZ: wz - CELL_SIZE / 2,
          maxZ: wz + CELL_SIZE / 2
        });
      } else {
        // Hallway warm ceiling lamps for dim, atmospheric visibility
        if (type === 0 && (r * 5 + c * 7) % 9 === 0) {
          const lampMesh = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.22, 0.08, 8),
            new THREE.MeshBasicMaterial({ color: 0xffeed8 })
          );
          lampMesh.position.set(wx, WALL_HEIGHT - 0.05, wz);
          currentStageGroup.add(lampMesh);

          const corridorLight = new THREE.PointLight(0xffeacc, 0.95, 14);
          corridorLight.position.set(wx, WALL_HEIGHT - 0.2, wz);
          currentStageGroup.add(corridorLight);
        }

        if (type === 2) {
          // School Hiding Spot: Infirmary Bed or Wooden Locker
          if ((r + c) % 2 === 0) {
            buildSchoolInfirmaryBed(currentStageGroup, wx, wz);
          } else {
            buildSchoolLocker(currentStageGroup, wx, wz);
          }
        } else if (type === 3) {
          exitDoorPos.set(wx, 0, wz);
          buildSchoolExitStairs(currentStageGroup, wx, wz, stageNum === MAX_STAGES);
        } else if (type === 10) {
          buildStudentDeskAndChair(currentStageGroup, wx, wz);
        } else if (type === 11) {
          buildChalkboard(currentStageGroup, wx, 1.8, wz - 1.2, 0, `第${stageNum}時限`, '〜 夜の旧校舎 〜');
          buildTeacherPodium(currentStageGroup, wx, wz + 0.6);
        } else if (type === 12) {
          buildShoeLocker(currentStageGroup, wx, wz);
        } else if (type === 13) {
          buildNoticeBoard(currentStageGroup, wx, 1.8, wz);
          buildFireExtinguisher(currentStageGroup, wx + 0.8, wz);
        } else if (type === 14) {
          buildScienceLabBench(currentStageGroup, wx, wz);
        } else if (type === 15) {
          buildAnatomySkeleton(currentStageGroup, wx, wz);
        } else if (type === 16) {
          buildMusicPiano(currentStageGroup, wx, wz);
          buildComposerPortraits(currentStageGroup, wx, 2.0, wz - 1.5);
        } else if (type === 17) {
          buildLibraryBookshelf(currentStageGroup, wx, wz);
        } else if (type === 18) {
          buildGymEquipment(currentStageGroup, wx, wz);
        }
      }
    }
  }

  // Warm light right over the spawn point
  const spawnLight = new THREE.PointLight(0xfffaee, 1.35, 18);
  spawnLight.position.set(spawnWorldPos.x, WALL_HEIGHT - 0.2, spawnWorldPos.z);
  currentStageGroup.add(spawnLight);

  // Position camera at spawn facing down the room
  camera.position.copy(spawnWorldPos);
  camera.rotation.set(0, 0, 0);
  playerY = STAND_HEIGHT;
  playerVy = 0;
  isCrouching = false;
  isHidden = false;
  currentHidingSpot = null;

  // Update HUD Stage info
  const config = STAGE_CONFIGS[stageNum - 1];
  hudStageBadge.textContent = `STAGE ${stageNum} / ${MAX_STAGES}`;
  hudStageTitle.textContent = config.title;
  hudStageMonsters.textContent = config.monstersText;
  nextMonsterTimer = config.nextWait;
}

// --- Authentic Japanese School 3D Furniture & Props Builders ---
// Student Desk and Chair
function buildStudentDeskAndChair(parent, x, z, rotY = 0) {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x8a633c });
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x2c3e50 });

  // Desk top
  const deskTop = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.6), woodMat);
  deskTop.position.set(0, 0.72, 0);
  group.add(deskTop);

  // Desk book tray
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.03, 0.54), frameMat);
  tray.position.set(0, 0.62, 0);
  group.add(tray);

  // Notebook on desk
  const book = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.02, 0.2), new THREE.MeshBasicMaterial({ color: 0xecf0f1 }));
  book.position.set(0.12, 0.75, 0.05);
  group.add(book);

  // 4 Desk Legs
  const legGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.72, 6);
  [[-0.4, 0.36, -0.26], [0.4, 0.36, -0.26], [-0.4, 0.36, 0.26], [0.4, 0.36, 0.26]].forEach(p => {
    const leg = new THREE.Mesh(legGeo, frameMat);
    leg.position.set(...p);
    group.add(leg);
  });

  // Chair
  const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.04, 0.48), woodMat);
  chairSeat.position.set(0, 0.45, 0.56);
  group.add(chairSeat);

  const chairBack = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.22, 0.04), woodMat);
  chairBack.position.set(0, 0.78, 0.78);
  group.add(chairBack);

  // Chair legs
  const chairLegGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.45, 6);
  [[-0.2, 0.225, 0.36], [0.2, 0.225, 0.36], [-0.2, 0.225, 0.76], [0.2, 0.225, 0.76]].forEach(p => {
    const cl = new THREE.Mesh(chairLegGeo, frameMat);
    cl.position.set(...p);
    group.add(cl);
  });

  group.position.set(x, 0, z);
  group.rotation.y = rotY;
  parent.add(group);
}

// Teacher's Raised Podium & Desk
function buildTeacherPodium(parent, x, z) {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x5a3d24 });

  // Raised platform
  const plat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 1.4), woodMat);
  plat.position.set(0, 0.07, 0);
  group.add(plat);

  // Large teacher desk
  const desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.76, 0.8), woodMat);
  desk.position.set(0, 0.52, 0);
  group.add(desk);

  // Red teacher attendance book & chalk box
  const book = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, 0.24), new THREE.MeshLambertMaterial({ color: 0xc0392b }));
  book.position.set(-0.35, 0.92, 0);
  const chalkBox = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.12), new THREE.MeshLambertMaterial({ color: 0xf1c40f }));
  chalkBox.position.set(0.35, 0.92, 0);
  group.add(book, chalkBox);

  group.position.set(x, 0, z);
  parent.add(group);
}

// Japanese School Chalkboard
function buildChalkboard(parent, x, y, z, rotY = 0) {
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(3.0, 1.4),
    new THREE.MeshBasicMaterial({ map: blackboardTexture })
  );
  board.position.set(x, y, z);
  board.rotation.y = rotY;
  parent.add(board);
}

// Shoe Locker (下駄箱)
function buildShoeLocker(parent, x, z) {
  const locker = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1.5, 0.7),
    new THREE.MeshLambertMaterial({ map: shoeLockerTexture })
  );
  locker.position.set(x, 0.75, z);
  parent.add(locker);
}

// School Notice Board & Calligraphy
function buildNoticeBoard(parent, x, y, z) {
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 1.1),
    new THREE.MeshBasicMaterial({ map: noticeBoardTexture })
  );
  board.position.set(x, y, z);
  parent.add(board);
}

// Fire Extinguisher (消火器)
function buildFireExtinguisher(parent, x, z) {
  const ext = new THREE.Group();
  const redMat = new THREE.MeshLambertMaterial({ color: 0xd63031 });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x2d3436 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.45, 10), redMat);
  body.position.y = 0.225;
  const nozzle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.08), darkMat);
  nozzle.position.set(0, 0.48, 0);
  ext.add(body, nozzle);

  ext.position.set(x, 0, z);
  parent.add(ext);
}

// Science Lab Bench with Sink & Flask
function buildScienceLabBench(parent, x, z) {
  const bench = new THREE.Group();
  const blackMat = new THREE.MeshLambertMaterial({ color: 0x1f2421 });
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x4a3728 });

  // Black chemical resistant table top
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 1.0), blackMat);
  top.position.y = 0.76;
  bench.add(top);

  // Wooden base cabinet
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.72, 0.9), woodMat);
  base.position.y = 0.36;
  bench.add(base);

  // Faucet
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.3, 8), new THREE.MeshBasicMaterial({ color: 0xbdc3c7 }));
  pipe.position.set(0, 0.95, -0.2);
  bench.add(pipe);

  // Glowing chemical flask (eerie neon blue / green)
  const flask = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.09, 0.18, 8), new THREE.MeshBasicMaterial({ color: 0x00ffcc }));
  flask.position.set(0.5, 0.88, 0.1);
  bench.add(flask);

  bench.position.set(x, 0, z);
  parent.add(bench);
}

// Creepy Japanese School Anatomy Skeleton (人体模型)
function buildAnatomySkeleton(parent, x, z) {
  const skeleton = new THREE.Group();
  const boneMat = new THREE.MeshLambertMaterial({ color: 0xe5e0d4 });
  const redMat = new THREE.MeshLambertMaterial({ color: 0x8b0000 });
  const standMat = new THREE.MeshLambertMaterial({ color: 0x1e272e });

  // Stand pole
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.8, 6), standMat);
  pole.position.y = 0.9;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.04, 12), standMat);
  base.position.y = 0.02;
  skeleton.add(pole, base);

  // Skull
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.28, 0.24), boneMat);
  skull.position.set(0, 1.65, 0.06);
  skeleton.add(skull);

  // Glowing red creepy eye sockets
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  eye.position.set(-0.05, 1.66, 0.18);
  const eye2 = eye.clone();
  eye2.position.x = 0.05;
  skeleton.add(eye, eye2);

  // Half Ribcage (Bone) & Half Muscle (Red organ)
  const ribcage = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.45, 0.18), boneMat);
  ribcage.position.set(-0.09, 1.25, 0.06);
  const muscle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.45, 0.18), redMat);
  muscle.position.set(0.09, 1.25, 0.06);
  skeleton.add(ribcage, muscle);

  skeleton.position.set(x, 0, z);
  parent.add(skeleton);
}

// Music Room Grand Piano
function buildMusicPiano(parent, x, z) {
  const piano = new THREE.Group();
  const glossBlack = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const keyMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 1.4), glossBlack);
  body.position.y = 0.75;
  piano.add(body);

  // Keyboard
  const keys = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.22), keyMat);
  keys.position.set(0, 0.78, 0.65);
  piano.add(keys);

  // 3 Piano legs
  const pLegGeo = new THREE.CylinderGeometry(0.04, 0.03, 0.5, 8);
  [[-0.8, 0.25, -0.5], [0.8, 0.25, -0.5], [0, 0.25, 0.5]].forEach(p => {
    const l = new THREE.Mesh(pLegGeo, glossBlack);
    l.position.set(...p);
    piano.add(l);
  });

  // Piano stool
  const stool = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 0.3), glossBlack);
  stool.position.set(0, 0.225, 1.1);
  piano.add(stool);

  piano.position.set(x, 0, z);
  parent.add(piano);
}

// Classical Composer Wall Portraits (Beethoven, Bach)
function buildComposerPortraits(parent, x, y, z) {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.3, 0.04),
    new THREE.MeshLambertMaterial({ color: 0x5a3d24 })
  );
  frame.position.set(x, y, z);
  parent.add(frame);
}

// Library Tall Bookshelf
function buildLibraryBookshelf(parent, x, z) {
  const shelf = new THREE.Group();
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x4a321e });

  // Outer frame
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.6, 0.6), woodMat);
  frame.position.y = 1.3;
  shelf.add(frame);

  // Rows of colorful book spines
  const colors = [0x9b59b6, 0x34495e, 0x16a085, 0xd35400, 0x27ae60];
  for (let s = 0; s < 4; s++) {
    const row = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.38, 0.02),
      new THREE.MeshLambertMaterial({ color: colors[s % colors.length] })
    );
    row.position.set(0, 0.5 + s * 0.55, 0.31);
    shelf.add(row);
  }

  shelf.position.set(x, 0, z);
  parent.add(shelf);
}

// Gym Vaulting Box (跳び箱) and Blue Mat
function buildGymEquipment(parent, x, z) {
  const gym = new THREE.Group();
  const woodMat = new THREE.MeshLambertMaterial({ color: 0xb88950 });
  const padMat = new THREE.MeshLambertMaterial({ color: 0xe0d6b5 });
  const matMat = new THREE.MeshLambertMaterial({ color: 0x2980b9 });

  // 5-layer vaulting box
  for (let l = 0; l < 5; l++) {
    const w = 1.2 - l * 0.08;
    const d = 0.7 - l * 0.05;
    const layer = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), (l === 4 ? padMat : woodMat));
    layer.position.y = 0.08 + l * 0.16;
    gym.add(layer);
  }

  // Thick Blue Gym Mat
  const mat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 1.2), matMat);
  mat.position.set(0, 0.04, 1.2);
  gym.add(mat);

  gym.position.set(x, 0, z);
  parent.add(gym);
}

// Build School Infirmary Bed
function buildSchoolInfirmaryBed(parent, x, z) {
  const bed = new THREE.Group();
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x3d2716 });
  const sheetMat = new THREE.MeshLambertMaterial({ color: 0xdfdad2 });

  // 4 Legs
  const legGeo = new THREE.BoxGeometry(0.1, 0.45, 0.1);
  [[-0.7, 0.225, -1], [0.7, 0.225, -1], [-0.7, 0.225, 1], [0.7, 0.225, 1]].forEach(p => {
    const leg = new THREE.Mesh(legGeo, woodMat);
    leg.position.set(...p);
    bed.add(leg);
  });

  // Base frame
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 2.2), woodMat);
  base.position.y = 0.47;
  bed.add(base);

  // Mattress & White sheet
  const mat = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.26, 2.1), sheetMat);
  mat.position.y = 0.63;
  bed.add(mat);

  // Pillow
  const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.14, 0.45), sheetMat);
  pillow.position.set(0, 0.8, -0.75);
  bed.add(pillow);

  bed.position.set(x, 0, z);
  parent.add(bed);

  hidingSpots.push({
    pos: new THREE.Vector3(x, 0, z),
    hideCamPos: new THREE.Vector3(x, HIDE_HEIGHT, z),
    type: 'bed'
  });
}

// Build School Locker
function buildSchoolLocker(parent, x, z) {
  const locker = new THREE.Group();
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x4a3420 });

  // Main locker body (tall wooden locker)
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.4, 0.8), woodMat);
  body.position.y = 1.2;
  locker.add(body);

  // Dark interior / slit
  const slitMat = new THREE.MeshBasicMaterial({ color: 0x110c08 });
  const slit = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 0.02), slitMat);
  slit.position.set(-0.3, 1.4, 0.41);
  const slit2 = slit.clone();
  slit2.position.x = 0.3;
  locker.add(slit, slit2);

  locker.position.set(x, 0, z);
  parent.add(locker);

  hidingSpots.push({
    pos: new THREE.Vector3(x, 0, z),
    hideCamPos: new THREE.Vector3(x, HIDE_HEIGHT, z),
    type: 'locker'
  });
}

// Build School Exit: Stairs to next floor, or Main Gates on Stage 5
function buildSchoolExitStairs(parent, x, z, isFinalGate) {
  const exitGroup = new THREE.Group();

  if (isFinalGate) {
    // Grand glowing exit gate of the school
    const gateFrame = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 3.4, 0.3),
      new THREE.MeshLambertMaterial({ color: 0x221a14 })
    );
    gateFrame.position.set(0, 1.7, 0);
    exitGroup.add(gateFrame);

    // Glowing golden escape portal
    const portal = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 3.0, 0.1),
      new THREE.MeshBasicMaterial({ color: 0xffd700 })
    );
    portal.position.set(0, 1.5, 0.05);
    exitGroup.add(portal);

    const exitLight = new THREE.PointLight(0xffd700, 2.5, 16);
    exitLight.position.set(0, 2.0, 0.8);
    exitGroup.add(exitLight);
  } else {
    // Wooden staircase leading upwards to next floor
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x3d2716 });
    for (let i = 0; i < 6; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.25, 0.45), woodMat);
      step.position.set(0, 0.125 + i * 0.25, -i * 0.4);
      exitGroup.add(step);
    }

    // Green emergency exit sign above stairs (非常口)
    const sign = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 0.1), new THREE.MeshBasicMaterial({ color: 0x00ff66 }));
    sign.position.set(0, 2.7, 0);
    exitGroup.add(sign);

    const stairLight = new THREE.PointLight(0x00ff66, 1.8, 12);
    stairLight.position.set(0, 2.2, 0.4);
    exitGroup.add(stairLight);
  }

  exitGroup.position.set(x, 0, z);
  parent.add(exitGroup);
}

// --- Monsters Construction: 4 Distinct Entities ---
function buildAllMonsters() {
  // 1. 黒のバケモノ (Shadow Rusher: Pitch black towering entity)
  blackMonsterGroup = new THREE.Group();
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x020202 });
  const bTorso = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.6, 0.7), shadowMat);
  bTorso.position.y = 2.2;
  const bHead = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 1.0), shadowMat);
  bHead.position.y = 3.8;
  const whiteEyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const bEye1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.08), whiteEyeMat);
  bEye1.position.set(-0.25, 3.9, 0.52);
  const bEye2 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.08), whiteEyeMat);
  bEye2.position.set(0.25, 3.9, 0.52);
  blackMonsterGroup.add(bTorso, bHead, bEye1, bEye2);
  blackMonsterGroup.visible = false;
  scene.add(blackMonsterGroup);

  // 2. 赤のバケモノ (Crimson Reaper: Head-height scythe blades)
  redMonsterGroup = new THREE.Group();
  const redMat = new THREE.MeshBasicMaterial({ color: 0x990000 });
  const rBody = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.2, 8), redMat);
  rBody.rotation.x = Math.PI;
  rBody.position.y = 2.0;
  const rHead = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 8), redMat);
  rHead.position.y = 2.7;
  // Sweeping scythe blade at 1.6m (head level)
  const scythe = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.1, 0.4), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  scythe.position.y = 1.6;
  redMonsterGroup.add(rBody, rHead, scythe);
  redMonsterGroup.visible = false;
  scene.add(redMonsterGroup);

  // 3. 青のバケモノ (Floor Spirit: Crawls on the ground at 0.2m)
  blueMonsterGroup = new THREE.Group();
  const blueMat = new THREE.MeshBasicMaterial({ color: 0x0088ff });
  const blBody = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, 2.4), blueMat);
  blBody.position.y = 0.2;
  const blEye = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  blEye.position.set(0, 0.35, 0.5);
  blueMonsterGroup.add(blBody, blEye);
  blueMonsterGroup.visible = false;
  scene.add(blueMonsterGroup);

  // 4. 紫のバケモノ (Curse Doll: Attracted to light, creeps quickly)
  purpleMonsterGroup = new THREE.Group();
  const purpleMat = new THREE.MeshBasicMaterial({ color: 0x7700aa });
  const pBody = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 1.8, 8), purpleMat);
  pBody.position.y = 1.2;
  const pHead = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  pHead.position.y = 2.3;
  const pEyes = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, 0.1), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  pEyes.position.set(0, 2.35, 0.45);
  purpleMonsterGroup.add(pBody, pHead, pEyes);
  purpleMonsterGroup.visible = false;
  scene.add(purpleMonsterGroup);
}

// --- Cinematic Camera for Title / Lobby ---
function updateCinematicCamera(now) {
  const t = now * 0.0005;
  camera.position.x = spawnWorldPos.x + Math.sin(t) * 1.5;
  camera.position.y = STAND_HEIGHT + Math.sin(t * 1.5) * 0.05;
  camera.position.z = spawnWorldPos.z + Math.cos(t) * 1.5;
  camera.lookAt(spawnWorldPos.x + Math.sin(t * 0.4) * 3, STAND_HEIGHT, spawnWorldPos.z - 6);
}

// --- Event Listeners & Controls ---
function setupEventListeners() {
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w' || e.key === 'ArrowUp') keys.w = true;
    if (k === 'a' || e.key === 'ArrowLeft') keys.a = true;
    if (k === 's' || e.key === 'ArrowDown') keys.s = true;
    if (k === 'd' || e.key === 'ArrowRight') keys.d = true;
    if (e.key === 'Shift') keys.shift = true;

    // Jump [Space]
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      handleJump();
    }

    // Crouch [C]
    if (k === 'c') toggleCrouch();

    // Hotbar Flashlight toggle [1]
    if (e.key === '1') toggleSlot1();

    // Interaction / Hide [E]
    if (k === 'e') handleInteract();

    // Energy Drink [Q]
    if (k === 'q') useEnergyDrink();
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w' || e.key === 'ArrowUp') keys.w = false;
    if (k === 'a' || e.key === 'ArrowLeft') keys.a = false;
    if (k === 's' || e.key === 'ArrowDown') keys.s = false;
    if (k === 'd' || e.key === 'ArrowRight') keys.d = false;
    if (e.key === 'Shift') keys.shift = false;
  });

  // Pointer lock and mouse look controls
  const canvas = renderer.domElement;
  let isMouseDown = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  canvas.addEventListener('mousedown', (e) => {
    if (gameState === 'playing') {
      isMouseDown = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      if (!isPointerLocked) {
        try { canvas.requestPointerLock(); } catch(err) {}
      }
    }
  });

  window.addEventListener('mouseup', () => {
    isMouseDown = false;
  });

  document.addEventListener('pointerlockchange', () => {
    isPointerLocked = (document.pointerLockElement === canvas);
  });

  document.addEventListener('mousemove', (e) => {
    if (isHidden || gameState !== 'playing') return;
    const sens = 0.0024;
    if (isPointerLocked) {
      camera.rotation.y -= e.movementX * sens;
      camera.rotation.x -= e.movementY * sens;
      camera.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, camera.rotation.x));
    } else if (isMouseDown) {
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      camera.rotation.y -= dx * sens;
      camera.rotation.x -= dy * sens;
      camera.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, camera.rotation.x));
    }
  });

  // HUD buttons
  crouchBtn.addEventListener('click', () => toggleCrouch());
  jumpBtn.addEventListener('click', () => handleJump());
  hideBtn.addEventListener('click', () => handleInteract());
  drinkBtn.addEventListener('click', () => useEnergyDrink());
  hotbarSlot1.addEventListener('click', () => toggleSlot1());

  // Solo & Online Lobby buttons
  document.getElementById('soloStartBtn').addEventListener('click', () => {
    sound.init();
    localPlayerName = document.getElementById('playerNameInput').value.trim() || localPlayerName;
    startSoloGame();
  });

  document.getElementById('createRoomBtn').addEventListener('click', async () => {
    sound.init();
    localPlayerName = document.getElementById('playerNameInput').value.trim() || localPlayerName;
    roomManager = new RoomManager(localPlayerId, localPlayerName);
    const code = await roomManager.createRoom(selectedItem, characterCustomization);
    openLobby(code, true);
  });

  document.getElementById('joinRoomBtn').addEventListener('click', async () => {
    sound.init();
    const code = document.getElementById('joinCodeInput').value.trim();
    if (!code) {
      alert("部屋コード（4桁）を入力してください");
      return;
    }
    localPlayerName = document.getElementById('playerNameInput').value.trim() || localPlayerName;
    roomManager = new RoomManager(localPlayerId, localPlayerName);
    try {
      await roomManager.joinRoom(code, selectedItem, characterCustomization);
      openLobby(code, false);
    } catch (err) {
      alert(err.message || "部屋への参加に失敗しました");
    }
  });

  startPartyBtn.addEventListener('click', () => {
    if (roomManager && roomManager.isHost) {
      roomManager.startPartyGame();
      startGameplay(1);
    }
  });

  leaveLobbyBtn.addEventListener('click', () => {
    if (roomManager) roomManager.leaveRoom();
    lobbyScreen.style.display = 'none';
    titleScreen.style.display = 'flex';
  });

  copyCodeBtn.addEventListener('click', () => {
    if (roomManager && roomManager.roomCode) {
      navigator.clipboard.writeText(roomManager.roomCode).then(() => {
        copyCodeBtn.textContent = '✅ コピー済';
        setTimeout(() => { copyCodeBtn.textContent = '📋 コピー'; }, 2000);
      });
    }
  });

  document.getElementById('clearRetryBtn').addEventListener('click', () => {
    returnToHomeScreen();
  });

  // Item card selection
  document.querySelectorAll('.item-select-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.item-select-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedItem = card.dataset.item;
      updateItemSlotView();
    });
  });

  setupTouchControls();
}

// --- Character Appearance Customization UI ---
function setupCustomizerUI() {
  document.querySelectorAll('#shirtSwatches .color-swatch').forEach(swatch => {
    if (swatch.dataset.color === characterCustomization.shirtColor) swatch.classList.add('active');
    swatch.addEventListener('click', () => {
      document.querySelectorAll('#shirtSwatches .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      characterCustomization.shirtColor = swatch.dataset.color;
      saveCustomization();
    });
  });

  document.querySelectorAll('#pantsSwatches .color-swatch').forEach(swatch => {
    if (swatch.dataset.color === characterCustomization.pantsColor) swatch.classList.add('active');
    swatch.addEventListener('click', () => {
      document.querySelectorAll('#pantsSwatches .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      characterCustomization.pantsColor = swatch.dataset.color;
      saveCustomization();
    });
  });

  document.querySelectorAll('#skinSwatches .color-swatch').forEach(swatch => {
    if (swatch.dataset.color === characterCustomization.skinColor) swatch.classList.add('active');
    swatch.addEventListener('click', () => {
      document.querySelectorAll('#skinSwatches .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      characterCustomization.skinColor = swatch.dataset.color;
      saveCustomization();
    });
  });

  document.querySelectorAll('#hatPills .hat-pill').forEach(pill => {
    if (pill.dataset.hat === characterCustomization.hat) pill.classList.add('active');
    pill.addEventListener('click', () => {
      document.querySelectorAll('#hatPills .hat-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      characterCustomization.hat = pill.dataset.hat;
      saveCustomization();
    });
  });
}

function saveCustomization() {
  try {
    localStorage.setItem('kowakowa_school_custom', JSON.stringify(characterCustomization));
  } catch (e) {}
  if (roomManager) {
    roomManager.updateCustomization(characterCustomization);
  }
}

// --- Player Actions: Jump, Crouch, Flashlight, Items ---
function handleJump() {
  if (gameState !== 'playing' || isHidden || isDead || hasCleared) return;
  const currentBaseY = isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT;
  if (Math.abs(playerY - currentBaseY) < 0.12 && playerVy <= 0.5) {
    playerVy = JUMP_VELOCITY;
    sound.playJump();
  }
}

function toggleCrouch() {
  if (gameState !== 'playing' || isHidden || isDead || hasCleared) return;
  isCrouching = !isCrouching;
  sound.playCrouch();

  if (isCrouching) {
    targetCameraY = CROUCH_HEIGHT;
    crouchBtn.classList.add('active');
    stanceIcon.textContent = '🦆';
    stanceText.textContent = 'しゃがみ中 [Cで立つ]';
    stanceBadge.style.borderColor = '#2ecc71';
    stanceBadge.style.color = '#2ecc71';
  } else {
    targetCameraY = STAND_HEIGHT;
    crouchBtn.classList.remove('active');
    stanceIcon.textContent = '🧍';
    stanceText.textContent = '立ち [Cでしゃがむ]';
    stanceBadge.style.borderColor = '#f39c12';
    stanceBadge.style.color = '#f39c12';
  }
}

function toggleSlot1() {
  isSlot1Held = !isSlot1Held;
  sound.playFlashlightClick();
  updateSlotUI();
  updateFlashlightVisibility();
}

function updateSlotUI() {
  if (isSlot1Held) {
    hotbarSlot1.classList.add('active');
    slotState.textContent = '装備中';
  } else {
    hotbarSlot1.classList.remove('active');
    slotState.textContent = '消灯/収納';
  }
}

function updateItemSlotView() {
  if (selectedItem === 'flashlight') {
    slotIcon.textContent = '🔦';
    slotLabel.textContent = '懐中電灯';
    drinkBtn.style.display = 'none';
  } else if (selectedItem === 'bandage') {
    slotIcon.textContent = '🩹';
    slotLabel.textContent = '絆創膏';
    drinkBtn.style.display = 'none';
  } else if (selectedItem === 'drink') {
    slotIcon.textContent = '⚡';
    slotLabel.textContent = 'エナドリ';
    drinkBtn.style.display = 'flex';
  }
  updateFlashlightVisibility();
}

function useEnergyDrink() {
  if (selectedItem !== 'drink' || drinkCooldown > 0 || gameState !== 'playing') return;
  drinkCooldown = 60;
  drinkActiveTimer = 8;
  sound.playEnergyDrink();
}

function setupTouchControls() {
  const touchArea = document.getElementById('touchLookArea');
  if (!touchArea) return;
  let lastTouchX = 0, lastTouchY = 0;

  touchArea.addEventListener('touchstart', (e) => {
    if (e.touches.length > 0) {
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
    }
  });

  touchArea.addEventListener('touchmove', (e) => {
    if (isHidden || e.touches.length === 0 || gameState !== 'playing') return;
    const dx = e.touches[0].clientX - lastTouchX;
    const dy = e.touches[0].clientY - lastTouchY;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;

    const sens = 0.0035;
    camera.rotation.y -= dx * sens;
    camera.rotation.x -= dy * sens;
    camera.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, camera.rotation.x));
  });

  const joyPad = document.getElementById('virtualJoypad');
  if (joyPad) {
    let joyStartX = 0, joyStartY = 0;
    joyPad.addEventListener('touchstart', (e) => {
      joyStartX = e.touches[0].clientX;
      joyStartY = e.touches[0].clientY;
    });
    joyPad.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - joyStartX;
      const dy = e.touches[0].clientY - joyStartY;
      keys.w = dy < -15;
      keys.s = dy > 15;
      keys.a = dx < -15;
      keys.d = dx > 15;
    });
    joyPad.addEventListener('touchend', () => {
      keys.w = keys.s = keys.a = keys.d = false;
    });
  }
}

// --- Interaction (Bed/Locker Hide & Stage Clear Exit) ---
function handleInteract() {
  if (gameState !== 'playing' || isDead || hasCleared) return;

  if (isHidden) {
    isHidden = false;
    currentHidingSpot = null;
    sound.playHide();
    targetCameraY = isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    playerY = targetCameraY;
    playerVy = 0;
    hideBtn.classList.remove('active');
    stanceIcon.textContent = isCrouching ? '🦆' : '🧍';
    stanceText.textContent = isCrouching ? 'しゃがみ中 [Cで立つ]' : '立ち [Cでしゃがむ]';
    showInteractPrompt(false);
    return;
  }

  // Proximity to Exit Stairs / Gate
  const distToExit = camera.position.distanceTo(new THREE.Vector3(exitDoorPos.x, camera.position.y, exitDoorPos.z));
  if (distToExit < 3.2) {
    triggerStageClear();
    return;
  }

  // Proximity to Hiding Spot (Bed / Locker)
  const spot = getNearbyHidingSpot();
  if (spot) {
    isHidden = true;
    currentHidingSpot = spot;
    sound.playHide();
    hideBtn.classList.add('active');
    stanceIcon.textContent = '👁️';
    stanceText.textContent = '潜伏中 [Eで出る]';
    stanceBadge.style.borderColor = '#3498db';
    stanceBadge.style.color = '#3498db';
    interactPrompt.textContent = '【E】出る';
    interactPrompt.style.display = 'block';
  }
}

function getNearbyHidingSpot() {
  for (let spot of hidingSpots) {
    const dist = camera.position.distanceTo(spot.pos);
    if (dist < 3.0) return spot;
  }
  return null;
}

function updateInteractPrompt() {
  if (gameState !== 'playing' || isDead || hasCleared) {
    showInteractPrompt(false);
    return;
  }

  if (isHidden) {
    interactPrompt.textContent = '【E】出る';
    showInteractPrompt(true);
    return;
  }

  const distToExit = camera.position.distanceTo(new THREE.Vector3(exitDoorPos.x, camera.position.y, exitDoorPos.z));
  if (distToExit < 3.2) {
    if (currentStage === MAX_STAGES) {
      interactPrompt.textContent = '【E】正門を開けて脱出する！';
    } else {
      interactPrompt.textContent = `【E】階段を上がり第${currentStage + 1}ステージへ進む`;
    }
    showInteractPrompt(true);
    return;
  }

  const spot = getNearbyHidingSpot();
  if (spot) {
    interactPrompt.textContent = spot.type === 'bed' ? '【E】ベッド下に隠れる' : '【E】ロッカーに隠れる';
    showInteractPrompt(true);
    return;
  }

  showInteractPrompt(false);
}

function showInteractPrompt(show) {
  interactPrompt.style.display = show ? 'block' : 'none';
}

// --- Wall Collision Detection ---
function checkWallCollision(newX, newZ, radius = 0.42) {
  for (let wall of mazeWalls) {
    const closestX = Math.max(wall.minX, Math.min(newX, wall.maxX));
    const closestZ = Math.max(wall.minZ, Math.min(newZ, wall.maxZ));
    const distX = newX - closestX;
    const distZ = newZ - closestZ;
    if ((distX * distX + distZ * distZ) < (radius * radius)) {
      return true;
    }
  }
  return false;
}

// --- Main Game Update Loop ---
function updateGame(dt) {
  if (drinkCooldown > 0) {
    drinkCooldown -= dt;
    const pct = Math.max(0, drinkCooldown / 60) * 100;
    drinkCooldownBar.style.width = pct + '%';
    drinkBtn.disabled = true;
  } else {
    drinkBtn.disabled = false;
    drinkCooldownBar.style.width = '0%';
  }

  if (drinkActiveTimer > 0) drinkActiveTimer -= dt;

  // Player Movement & Gravity
  if (!isHidden && !isDead && !hasCleared) {
    let speedMult = 1.0;
    if (isCrouching) speedMult = 0.58;
    if (keys.shift) speedMult = 1.35;
    if (drinkActiveTimer > 0) speedMult = 2.4;

    const baseSpeed = 5.2 * speedMult;
    const moveDir = new THREE.Vector3();
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), camera.rotation.y);
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), camera.rotation.y);

    if (keys.w) moveDir.add(forward);
    if (keys.s) moveDir.sub(forward);
    if (keys.a) moveDir.sub(right);
    if (keys.d) moveDir.add(right);

    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();

      const deltaX = moveDir.x * baseSpeed * dt;
      const deltaZ = moveDir.z * baseSpeed * dt;

      if (!checkWallCollision(camera.position.x + deltaX, camera.position.z)) {
        camera.position.x += deltaX;
      }
      if (!checkWallCollision(camera.position.x, camera.position.z + deltaZ)) {
        camera.position.z += deltaZ;
      }

      headBobTimer += dt * 10 * speedMult;
      footstepTimer += dt * speedMult;
      if (footstepTimer > 0.42) {
        sound.playWoodFootstep(keys.shift || drinkActiveTimer > 0);
        footstepTimer = 0;
      }
    }

    // Vertical Physics (Jump / Falling)
    const baseTargetY = isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    playerVy += GRAVITY * dt;
    playerY += playerVy * dt;

    if (playerY <= baseTargetY) {
      playerY = baseTargetY;
      playerVy = 0;
    }

    camera.position.y = playerY + Math.sin(headBobTimer) * 0.03;
  } else if (isHidden && currentHidingSpot) {
    camera.position.lerp(currentHidingSpot.hideCamPos, dt * 10);
  }

  // Flashlight hand sway
  if (firstPersonFlashlightMesh && firstPersonFlashlightMesh.visible) {
    const bobX = Math.sin(headBobTimer * 0.5) * 0.012;
    const bobY = Math.abs(Math.sin(headBobTimer)) * 0.01;
    firstPersonFlashlightMesh.position.set(0.22 + bobX, -0.2 + bobY, -0.38);
  }

  updateInteractPrompt();
  updateMonstersSequence(dt);

  // Sync to RoomManager (WebSocket)
  syncTimer += dt;
  if (syncTimer > 0.1 && roomManager) {
    syncTimer = 0;
    roomManager.updatePosition(
      camera.position.x,
      camera.position.z,
      camera.position.y,
      camera.rotation.y,
      isHidden,
      isDead,
      isCrouching,
      currentStage
    );
  }
}

// --- 4 Monster Types Sequence & Mechanics ---
function updateMonstersSequence(dt) {
  if (isMonsterRushing) {
    monsterProgress += dt * 40;
    const activeGroup = getActiveMonsterGroup(currentMonsterType);

    const rushDir = new THREE.Vector3().subVectors(monsterTargetPos, monsterSpawnPos).normalize();
    activeGroup.position.copy(monsterSpawnPos).addScaledVector(rushDir, monsterProgress);

    // Red monster spins scythe
    if (currentMonsterType === 'red') {
      activeGroup.children[2].rotation.y += dt * 20;
    }

    // Proximity screen shake
    const dist = activeGroup.position.distanceTo(camera.position);
    if (dist < 18) {
      const shake = (1 - dist / 18) * 0.08;
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
    }

    // Collision check based on monster type mechanics
    if (dist < 3.2 && !isDead) {
      let isSafe = false;

      if (currentMonsterType === 'black') {
        // Must HIDE [E]
        isSafe = isHidden;
      } else if (currentMonsterType === 'red') {
        // Must CROUCH [C] below 0.9m
        isSafe = (isCrouching && camera.position.y <= 0.95);
      } else if (currentMonsterType === 'blue') {
        // Must JUMP [Space] above 1.2m
        isSafe = (playerY > 1.2 && Math.abs(playerVy) > 0.5);
      } else if (currentMonsterType === 'purple') {
        // Must TURN OFF FLASHLIGHT [1]
        isSafe = (!isSlot1Held || selectedItem !== 'flashlight');
      }

      if (isSafe) {
        sound.playHeartbeat(true);
      } else {
        handleMonsterCatch();
      }
    }

    if (monsterProgress > 80) {
      isMonsterRushing = false;
      activeGroup.visible = false;
      const config = STAGE_CONFIGS[currentStage - 1];
      nextMonsterTimer = config.nextWait + Math.random() * 8;
    }
    return;
  }

  nextMonsterTimer -= dt;
  if (nextMonsterTimer <= 0 && !isWarningActive) {
    chooseAndTriggerMonsterWarning();
  }
}

function getActiveMonsterGroup(type) {
  if (type === 'red') return redMonsterGroup;
  if (type === 'blue') return blueMonsterGroup;
  if (type === 'purple') return purpleMonsterGroup;
  return blackMonsterGroup;
}

function chooseAndTriggerMonsterWarning() {
  isWarningActive = true;
  const config = STAGE_CONFIGS[currentStage - 1];
  const pool = config.allowedMonsters;
  currentMonsterType = pool[Math.floor(Math.random() * pool.length)];

  if (currentMonsterType === 'black') triggerColorFlickers('flicker-blackout', sound.playBlackWarning.bind(sound));
  else if (currentMonsterType === 'red') triggerColorFlickers('flicker-red', sound.playRedWarning.bind(sound));
  else if (currentMonsterType === 'blue') triggerColorFlickers('flicker-blue', sound.playBlueWarning.bind(sound));
  else if (currentMonsterType === 'purple') triggerColorFlickers('flicker-purple', sound.playPurpleWarning.bind(sound));
}

// 3 Color-coded Flickers with 0 text
function triggerColorFlickers(className, soundFunc) {
  doSingleFlicker(className, soundFunc, 1, () => {
    setTimeout(() => {
      doSingleFlicker(className, soundFunc, 2, () => {
        setTimeout(() => {
          doSingleFlicker(className, soundFunc, 3, () => {
            // 3 flickers completed, 2.6s suspense then rush!
            setTimeout(() => {
              startMonsterRush(currentMonsterType);
            }, 2600);
          });
        }, 500);
      });
    }, 500);
  });
}

function doSingleFlicker(className, soundFunc, count, onDone) {
  soundFunc();
  warningOverlay.className = className;
  setTimeout(() => {
    warningOverlay.className = '';
    if (onDone) onDone();
  }, 220 + count * 30);
}

function startMonsterRush(type) {
  isMonsterRushing = true;
  isWarningActive = false;
  monsterProgress = 0;

  const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), camera.rotation.y);
  monsterSpawnPos.copy(camera.position).subScaledVector(forward, 45);
  monsterTargetPos.copy(camera.position).addScaledVector(forward, 45);

  const activeGroup = getActiveMonsterGroup(type);
  activeGroup.position.copy(monsterSpawnPos);
  activeGroup.lookAt(monsterTargetPos);
  activeGroup.visible = true;

  if (type === 'black') sound.playBlackMonsterRoar();
  else if (type === 'red') sound.playRedMonsterSwoosh();
  else if (type === 'blue') sound.playBlueMonsterCrawl();
  else if (type === 'purple') sound.playPurpleMonsterWhisper();
}

function handleMonsterCatch() {
  if (selectedItem === 'bandage' && !bandageUsed) {
    bandageUsed = true;
    sound.playBandageHeal();
    flashScreenRed();
  } else {
    triggerJumpscare();
  }
}

function flashScreenRed() {
  warningOverlay.className = 'flicker-red';
  setTimeout(() => { warningOverlay.className = ''; }, 350);
}

function triggerJumpscare() {
  isDead = true;
  sound.playJumpscare();
  jumpscareOverlay.style.display = 'flex';

  setTimeout(() => {
    jumpscareOverlay.style.display = 'none';
    returnToHomeScreen();
  }, 850);
}

// --- Stage Clearance & Progression ---
function triggerStageClear() {
  sound.playStageClear();

  if (currentStage >= MAX_STAGES) {
    // Game Completed!
    hasCleared = true;
    if (document.exitPointerLock) document.exitPointerLock();
    hudElement.style.display = 'none';
    clearScreen.style.display = 'flex';
    return;
  }

  // Advance to next stage!
  const nextStageNum = currentStage + 1;

  if (roomManager && roomManager.isHost) {
    roomManager.notifyStageClear(nextStageNum);
  }

  // Show Stage Transition Screen
  gameState = 'transition';
  transitionTitle.textContent = `第${currentStage}ステージ クリア！`;
  transitionDesc.textContent = `階段を駆け上がり、第${nextStageNum}ステージへ突入します……`;
  stageTransitionOverlay.style.display = 'flex';

  setTimeout(() => {
    stageTransitionOverlay.style.display = 'none';
    loadStage(nextStageNum);
    gameState = 'playing';
  }, 2200);
}

function returnToHomeScreen() {
  if (document.exitPointerLock) document.exitPointerLock();

  gameState = 'title';
  isDead = false;
  isMonsterRushing = false;
  isWarningActive = false;
  blackMonsterGroup.visible = false;
  redMonsterGroup.visible = false;
  blueMonsterGroup.visible = false;
  purpleMonsterGroup.visible = false;

  hudElement.style.display = 'none';
  titleScreen.style.display = 'flex';
  lobbyScreen.style.display = 'none';
  clearScreen.style.display = 'none';
  stageTransitionOverlay.style.display = 'none';

  if (firstPersonFlashlightMesh) firstPersonFlashlightMesh.visible = false;
  if (flashlightLight) flashlightLight.visible = false;

  if (homeDeathToast) {
    homeDeathToast.textContent = `☠️ バケモノに追いつかれた…… 第1ステージから再挑戦！`;
    homeDeathToast.style.display = 'block';
    setTimeout(() => { homeDeathToast.style.display = 'none'; }, 4500);
  }

  // Reset to Stage 1
  loadStage(1);
}

// --- Solo & Multiplayer Room Management ---
function startSoloGame() {
  titleScreen.style.display = 'none';
  lobbyScreen.style.display = 'none';
  clearScreen.style.display = 'none';
  hudElement.style.display = 'block';
  startGameplay(1);
}

function openLobby(code, isHost) {
  titleScreen.style.display = 'none';
  lobbyScreen.style.display = 'flex';
  roomCodeDisplay.textContent = '#' + code;

  if (isHost) {
    startPartyBtn.style.display = 'block';
    startPartyBtn.textContent = '全員で脱出を開始する！';
  } else {
    startPartyBtn.style.display = 'none';
  }

  if (roomManager) {
    roomManager.onRoomUpdate = (data) => renderLobbyParty(data);
    roomManager.onGameStart = () => {
      lobbyScreen.style.display = 'none';
      hudElement.style.display = 'block';
      startGameplay(1);
    };
    roomManager.onNextStage = (nextStage) => {
      transitionTitle.textContent = `第${currentStage}ステージ クリア！`;
      transitionDesc.textContent = `全員で第${nextStage}ステージへ突入します……`;
      stageTransitionOverlay.style.display = 'flex';
      setTimeout(() => {
        stageTransitionOverlay.style.display = 'none';
        loadStage(nextStage);
        gameState = 'playing';
      }, 2000);
    };
    roomManager.onPlayerMove = (id, data) => handleRemotePlayerMove(id, data);
    renderLobbyParty(roomManager.roomData);
  }
}

function renderLobbyParty(data) {
  if (!data || !data.players) return;
  partyList.innerHTML = '';

  const playerKeys = Object.keys(data.players);
  playerKeys.forEach(pId => {
    const p = data.players[pId];
    const custom = p.customization || {};
    const card = document.createElement('div');
    card.className = 'lobby-player-card';

    const hatIcon = custom.hat === 'cap' ? '🧢' : custom.hat === 'fedora' ? '🎩' : custom.hat === 'crown' ? '👑' : custom.hat === 'helmet' ? '👷' : '👤';
    const shirtColor = custom.shirtColor || '#e74c3c';

    card.innerHTML = `
      <div style="font-size: 2.2rem; margin-bottom: 4px;">${hatIcon}</div>
      <div style="font-weight: 800; font-size: 0.95rem; color: #fff; margin-bottom: 2px;">
        ${p.name || '生徒'} ${p.isHost ? '👑' : ''}
      </div>
      <div style="font-size: 0.75rem; color: #f39c12;">
        装備: ${p.item === 'flashlight' ? '🔦 懐中電灯' : p.item === 'bandage' ? '🩹 絆創膏' : '⚡ エナドリ'}
      </div>
      <div style="width: 20px; height: 6px; background: ${shirtColor}; margin: 6px auto 0; border-radius: 3px;"></div>
    `;
    partyList.appendChild(card);
  });
}

function startGameplay(startStage = 1) {
  gameState = 'playing';
  isDead = false;
  hasCleared = false;
  bandageUsed = false;
  isHidden = false;
  isCrouching = false;
  currentHidingSpot = null;
  loadStage(startStage);

  updateItemSlotView();
  updateSlotUI();
  sound.startSchoolAmbience();

  try {
    renderer.domElement.requestPointerLock();
  } catch (e) {}
}

// --- Multiplayer 3D Character Models (Custom Roblox Avatar) ---
function getOrCreatePlayerMesh(pId, data) {
  if (otherPlayerMeshes[pId]) return otherPlayerMeshes[pId];

  const group = new THREE.Group();
  const custom = data.customization || {};
  const skinMat = new THREE.MeshLambertMaterial({ color: custom.skinColor || '#ffd32a' });
  const shirtMat = new THREE.MeshLambertMaterial({ color: custom.shirtColor || '#e74c3c' });
  const pantsMat = new THREE.MeshLambertMaterial({ color: custom.pantsColor || '#1a252f' });

  // Head
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), skinMat);
  head.position.y = 1.45;
  group.add(head);

  // Hat
  if (custom.hat === 'cap') {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.12, 0.65), new THREE.MeshLambertMaterial({ color: 0x111111 }));
    cap.position.set(0, 1.72, -0.06);
    group.add(cap);
  } else if (custom.hat === 'fedora') {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 12), new THREE.MeshLambertMaterial({ color: 0x2c3e50 }));
    brim.position.y = 1.72;
    group.add(brim);
  } else if (custom.hat === 'crown') {
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.28, 0.22, 5), new THREE.MeshLambertMaterial({ color: 0xf1c40f }));
    crown.position.y = 1.82;
    group.add(crown);
  }

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.75, 0.35), shirtMat);
  torso.position.y = 0.85;
  group.add(torso);

  // Limbs
  const limbMat = skinMat;
  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.75, 0.25), limbMat);
  leftArm.position.set(-0.48, 0.85, 0);
  const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.75, 0.25), limbMat);
  rightArm.position.set(0.48, 0.85, 0);
  const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.75, 0.28), pantsMat);
  leftLeg.position.set(-0.16, 0.38, 0);
  const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.75, 0.28), pantsMat);
  rightLeg.position.set(0.16, 0.38, 0);
  group.add(leftArm, rightArm, leftLeg, rightLeg);

  scene.add(group);
  otherPlayerMeshes[pId] = group;
  return group;
}

function handleRemotePlayerMove(id, data) {
  if (id === localPlayerId) return;
  const mesh = getOrCreatePlayerMesh(id, data);
  if (!mesh) return;

  mesh.position.set(data.x, data.y - 1.4, data.z);
  mesh.rotation.y = data.rotation;
  mesh.visible = !data.isHidden && !data.isDead;
}

// --- Render Loop ---
function renderThree(dt) {
  renderer.render(scene, camera);
}
