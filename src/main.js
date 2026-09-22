import * as THREE from 'three';
import { SoundEngine } from './audio.js';
import { RoomManager } from './firebase.js';

// --- Sound Engine & Multiplayer State ---
const sound = new SoundEngine();
let roomManager = null;
let localPlayerId = 'p_' + Math.random().toString(36).substring(2, 9);
let localPlayerName = '生存者_' + Math.floor(100 + Math.random() * 900);
let selectedItem = 'flashlight'; // 'flashlight', 'bandage', 'drink'
let isSlot1Held = true;

// Character Customization State
let characterCustomization = {
  shirtColor: '#e74c3c',
  pantsColor: '#1a252f',
  skinColor: '#ffd32a',
  hat: 'none' // 'none', 'cap', 'fedora', 'crown', 'helmet'
};

// Load saved customization
try {
  const saved = localStorage.getItem('backrooms_customization');
  if (saved) {
    characterCustomization = Object.assign(characterCustomization, JSON.parse(saved));
  }
} catch (e) {}

// Game Mechanics State
let gameState = 'title'; // 'title', 'lobby', 'playing', 'cleared'
let isHidden = false;
let currentHidingSpot = null;
let isDead = false;
let hasCleared = false;
let bandageUsed = false;
let drinkCooldown = 0;
let drinkActiveTimer = 0;

// Stance & Physics State (Crouch C, Jump Space)
let isCrouching = false;
let targetCameraY = 1.65;
let playerY = 1.65;
let playerVy = 0;
const GRAVITY = -22;
const JUMP_VELOCITY = 6.2;
const STAND_HEIGHT = 1.65;
const CROUCH_HEIGHT = 0.75;
const HIDE_HEIGHT = 0.35;

// Monsters: Two distinct entities with warning flickers
// 1. Black Monster: 3 Blackout flickers -> Must HIDE (E in bed)
// 2. Red Monster: 3 Crimson flickers -> Must CROUCH (C key)
let currentMonsterType = null; // 'black' or 'red'
let isWarningActive = false;
let isMonsterRushing = false;
let monsterProgress = 0;
let nextMonsterTimer = 22; // Seconds until next attack
let monsterSpawnPos = new THREE.Vector3();
let monsterTargetPos = new THREE.Vector3();

// Three.js instances
let scene, camera, renderer;
let flashlightLight, ambientLight;
let ceilingLights = [];
let mazeWalls = []; // Bounding boxes for collision
let hidingBeds = []; // Bed objects for hiding
let otherPlayerMeshes = {}; // Remote players
let exitDoorGroup;
let blackMonsterGroup;
let redMonsterGroup;
let firstPersonFlashlightMesh;

// Textures
let wallTexture, carpetTexture, ceilingTexture;

// Controls state
const keys = { w: false, a: false, s: false, d: false, shift: false, space: false, c: false };
let isPointerLocked = false;
let headBobTimer = 0;
let footstepTimer = 0;
let syncTimer = 0;

// DOM Elements
const hudElement = document.getElementById('hud');
const titleScreen = document.getElementById('titleScreen');
const lobbyScreen = document.getElementById('lobbyScreen');
const clearScreen = document.getElementById('clearScreen');
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

// --- Procedural Backrooms Texture Generators ---
function createBackroomsWallTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Base vintage mustard-yellow Level 0 wallpaper
  ctx.fillStyle = '#d5be65';
  ctx.fillRect(0, 0, 256, 256);

  // Vertical wallpaper stripes
  for (let x = 0; x < 256; x += 16) {
    ctx.fillStyle = 'rgba(180, 150, 60, 0.22)';
    ctx.fillRect(x, 0, 8, 256);
    ctx.fillStyle = 'rgba(235, 215, 130, 0.18)';
    ctx.fillRect(x + 8, 0, 8, 256);
  }

  // Wallpaper grain
  const imgData = ctx.getImageData(0, 0, 256, 256);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 20;
    data[i] = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
  ctx.putImageData(imgData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function createBackroomsCarpetTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Damp dingy brownish-yellow carpet
  ctx.fillStyle = '#6b5e3c';
  ctx.fillRect(0, 0, 256, 256);

  // Mold / water stains
  for (let i = 0; i < 6; i++) {
    const rx = Math.random() * 256;
    const ry = Math.random() * 256;
    const grad = ctx.createRadialGradient(rx, ry, 5, rx, ry, 45);
    grad.addColorStop(0, 'rgba(40, 32, 16, 0.45)');
    grad.addColorStop(1, 'rgba(107, 94, 60, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(rx, ry, 45, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function createBackroomsCeilingTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Off-white/beige acoustic ceiling tiles
  ctx.fillStyle = '#cfc9b6';
  ctx.fillRect(0, 0, 256, 256);

  // Tile grids
  ctx.strokeStyle = '#857d6b';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, 128, 128);
  ctx.strokeRect(128, 0, 128, 128);
  ctx.strokeRect(0, 128, 128, 128);
  ctx.strokeRect(128, 128, 128, 128);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// --- Application Bootstrap ---
window.addEventListener('DOMContentLoaded', () => {
  initThree();
  buildMazeLabyrinth();
  buildFirstPersonFlashlight();
  buildMonsters();
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

// --- Three.js Setup (Bright, Eerie Backrooms Lighting) ---
function initThree() {
  const container = document.getElementById('canvasContainer');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x3a3220);
  scene.fog = new THREE.FogExp2(0x3a3220, 0.02);

  // First-Person Perspective
  camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.1, 140);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, STAND_HEIGHT, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // Ambient lighting: Bright enough to clearly see Backrooms walls and carpet
  ambientLight = new THREE.AmbientLight(0xd9cd9f, 0.82);
  scene.add(ambientLight);

  // Flashlight attached to camera
  flashlightLight = new THREE.SpotLight(0xfff3d8, 3.8, 50, Math.PI / 5.0, 0.35, 1.1);
  flashlightLight.position.set(0, 0, 0);
  flashlightLight.target = new THREE.Object3D();
  scene.add(flashlightLight.target);
  camera.add(flashlightLight);
  scene.add(camera);

  window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- First-Person 3D Flashlight Model (Held in hand) ---
function buildFirstPersonFlashlight() {
  firstPersonFlashlightMesh = new THREE.Group();

  const bodyGeo = new THREE.CylinderGeometry(0.038, 0.038, 0.28, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1f2329, roughness: 0.5 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.rotation.x = Math.PI / 2;
  firstPersonFlashlightMesh.add(body);

  const ringGeo = new THREE.CylinderGeometry(0.044, 0.044, 0.04, 16);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xf1c40f, roughness: 0.3 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.z = -0.06;
  firstPersonFlashlightMesh.add(ring);

  const headGeo = new THREE.CylinderGeometry(0.062, 0.042, 0.1, 16);
  const head = new THREE.Mesh(headGeo, bodyMat);
  head.rotation.x = Math.PI / 2;
  head.position.z = -0.16;
  firstPersonFlashlightMesh.add(head);

  const lensGeo = new THREE.CircleGeometry(0.058, 16);
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.rotation.y = Math.PI;
  lens.position.z = -0.211;
  firstPersonFlashlightMesh.add(lens);

  firstPersonFlashlightMesh.position.set(0.24, -0.21, -0.42);
  camera.add(firstPersonFlashlightMesh);

  updateFlashlightVisibility();
}

function updateFlashlightVisibility() {
  const isHeld = (selectedItem === 'flashlight' && isSlot1Held && gameState === 'playing');
  if (firstPersonFlashlightMesh) {
    firstPersonFlashlightMesh.visible = isHeld;
  }
  if (flashlightLight) {
    flashlightLight.visible = isHeld;
  }
}

// --- Genuine Backrooms Maze Labyrinth Generator ---
// 14x14 grid with authentic corridors, intersections, multiple bed rooms, and escape exit
const CELL_SIZE = 4.0; // 4 meters per grid cell
const MAZE_GRID = [
  // 0: Corridor/Room (walkable), 1: Wall, 2: Bed Room (safe hiding spot), 3: Exit Chamber, 4: Spawn Room
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 4, 4, 0, 1, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2, 1],
  [1, 4, 4, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1],
  [1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1],
  [1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  [1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1],
  [1, 0, 0, 0, 1, 0, 1, 2, 0, 1, 1, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 2, 1],
  [1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1],
  [1, 2, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 3, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 3, 3, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
];

const MAZE_ROWS = MAZE_GRID.length;
const MAZE_COLS = MAZE_GRID[0].length;
let spawnWorldPos = new THREE.Vector3();
let exitWorldPos = new THREE.Vector3();

function buildMazeLabyrinth() {
  const mazeGroup = new THREE.Group();
  scene.add(mazeGroup);

  wallTexture = createBackroomsWallTexture();
  wallTexture.repeat.set(1.5, 1);

  carpetTexture = createBackroomsCarpetTexture();
  carpetTexture.repeat.set(MAZE_COLS * 2, MAZE_ROWS * 2);

  ceilingTexture = createBackroomsCeilingTexture();
  ceilingTexture.repeat.set(MAZE_COLS * 2, MAZE_ROWS * 2);

  const floorMat = new THREE.MeshStandardMaterial({
    map: carpetTexture,
    roughness: 0.95,
    metalness: 0.05
  });

  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTexture,
    roughness: 0.85,
    metalness: 0.05
  });

  const ceilingMat = new THREE.MeshStandardMaterial({
    map: ceilingTexture,
    roughness: 0.85
  });

  const WALL_HEIGHT = 3.6;
  const totalWidth = MAZE_COLS * CELL_SIZE;
  const totalLength = MAZE_ROWS * CELL_SIZE;

  // Massive continuous floor & ceiling
  const floorGeo = new THREE.PlaneGeometry(totalWidth, totalLength);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(totalWidth / 2 - CELL_SIZE / 2, 0, totalLength / 2 - CELL_SIZE / 2);
  floor.receiveShadow = true;
  mazeGroup.add(floor);

  const ceiling = new THREE.Mesh(floorGeo, ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(totalWidth / 2 - CELL_SIZE / 2, WALL_HEIGHT, totalLength / 2 - CELL_SIZE / 2);
  mazeGroup.add(ceiling);

  const wallGeo = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, CELL_SIZE);

  // Iterate over maze grid
  for (let r = 0; r < MAZE_ROWS; r++) {
    for (let c = 0; c < MAZE_COLS; c++) {
      const cellType = MAZE_GRID[r][c];
      const wx = c * CELL_SIZE;
      const wz = r * CELL_SIZE;

      if (cellType === 1) {
        // Solid wall
        const wall = new THREE.Mesh(wallGeo, wallMat);
        wall.position.set(wx, WALL_HEIGHT / 2, wz);
        wall.castShadow = true;
        wall.receiveShadow = true;
        mazeGroup.add(wall);

        // Store bounding box for player collision
        mazeWalls.push({
          minX: wx - CELL_SIZE / 2,
          maxX: wx + CELL_SIZE / 2,
          minZ: wz - CELL_SIZE / 2,
          maxZ: wz + CELL_SIZE / 2
        });
      } else {
        // Walkable area: Place Fluorescent Ceiling Troffer periodically
        if ((r + c) % 3 === 0) {
          buildCeilingLight(mazeGroup, wx, WALL_HEIGHT, wz);
        }

        if (cellType === 4 && spawnWorldPos.length() === 0) {
          // Player initial spawn point
          spawnWorldPos.set(wx, STAND_HEIGHT, wz);
        }

        if (cellType === 2) {
          // Bed Chamber: Build 3D bed for hiding!
          build3DBed(mazeGroup, wx, wz);
        }

        if (cellType === 3 && exitWorldPos.length() === 0) {
          // Exit Chamber
          exitWorldPos.set(wx, 0, wz);
          buildExitChamber(mazeGroup, wx, WALL_HEIGHT, wz);
        }
      }
    }
  }

  // Set initial camera to spawn position
  camera.position.copy(spawnWorldPos);
}

// Build 3D Bed Frame with open underbed space where player hides
function build3DBed(parent, x, z) {
  const bedGroup = new THREE.Group();

  const woodMat = new THREE.MeshLambertMaterial({ color: 0x422d1b });
  const mattressMat = new THREE.MeshStandardMaterial({ color: 0xd9d3c5, roughness: 0.9 });
  const sheetMat = new THREE.MeshStandardMaterial({ color: 0x8a7b66, roughness: 0.8 });
  const pillowMat = new THREE.MeshStandardMaterial({ color: 0xffffff });

  // 4 Legs
  const legGeo = new THREE.BoxGeometry(0.12, 0.45, 0.12);
  const legPositions = [
    [-0.8, 0.225, -1.1],
    [0.8, 0.225, -1.1],
    [-0.8, 0.225, 1.1],
    [0.8, 0.225, 1.1]
  ];
  legPositions.forEach(p => {
    const leg = new THREE.Mesh(legGeo, woodMat);
    leg.position.set(...p);
    bedGroup.add(leg);
  });

  // Bed Base / Frame (above legs leaving 0.45m clearance underneath)
  const baseGeo = new THREE.BoxGeometry(1.8, 0.1, 2.4);
  const base = new THREE.Mesh(baseGeo, woodMat);
  base.position.set(0, 0.48, 0);
  bedGroup.add(base);

  // Mattress
  const matGeo = new THREE.BoxGeometry(1.7, 0.35, 2.3);
  const mattress = new THREE.Mesh(matGeo, mattressMat);
  mattress.position.set(0, 0.7, 0);
  bedGroup.add(mattress);

  // Blanket / Sheet
  const blanketGeo = new THREE.BoxGeometry(1.72, 0.36, 1.5);
  const blanket = new THREE.Mesh(blanketGeo, sheetMat);
  blanket.position.set(0, 0.71, 0.38);
  bedGroup.add(blanket);

  // Pillow
  const pillowGeo = new THREE.BoxGeometry(1.2, 0.18, 0.5);
  const pillow = new THREE.Mesh(pillowGeo, pillowMat);
  pillow.position.set(0, 0.92, -0.78);
  bedGroup.add(pillow);

  // Headboard
  const headboardGeo = new THREE.BoxGeometry(1.8, 1.1, 0.12);
  const headboard = new THREE.Mesh(headboardGeo, woodMat);
  headboard.position.set(0, 0.95, -1.18);
  bedGroup.add(headboard);

  bedGroup.position.set(x, 0, z);
  parent.add(bedGroup);

  // Register hiding spot
  hidingBeds.push({
    pos: new THREE.Vector3(x, 0, z),
    hideCamPos: new THREE.Vector3(x, HIDE_HEIGHT, z + 0.1),
    bedGroup
  });
}

// Fluorescent Light Fixture with warm 60Hz humming troffers
function buildCeilingLight(parent, x, height, z) {
  const fixtureGeo = new THREE.BoxGeometry(0.85, 0.08, 2.4);
  const fixtureMat = new THREE.MeshStandardMaterial({ color: 0x8a8474 });
  const fixture = new THREE.Mesh(fixtureGeo, fixtureMat);
  fixture.position.set(x, height - 0.04, z);
  parent.add(fixture);

  const tubeGeo = new THREE.BoxGeometry(0.55, 0.02, 2.1);
  const tubeMat = new THREE.MeshStandardMaterial({
    color: 0xfffae0,
    emissive: 0xfff6cf,
    emissiveIntensity: 1.15
  });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.position.set(x, height - 0.06, z);
  parent.add(tube);

  const light = new THREE.PointLight(0xfff6d0, 1.25, 14, 1.4);
  light.position.set(x, height - 0.35, z);
  parent.add(light);

  ceilingLights.push({
    light,
    tubeMat,
    baseIntensity: 1.25,
    pos: new THREE.Vector3(x, height - 0.35, z)
  });
}

// Build Escape Exit Door in the exit chamber
function buildExitChamber(parent, x, height, z) {
  exitDoorGroup = new THREE.Group();

  // Heavy Metal Door
  const doorGeo = new THREE.BoxGeometry(1.8, 2.7, 0.18);
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x22332a, metalness: 0.8, roughness: 0.3 });
  const door = new THREE.Mesh(doorGeo, doorMat);
  door.position.set(0, 1.35, 0);
  exitDoorGroup.add(door);

  // Door Handle
  const handleGeo = new THREE.BoxGeometry(0.3, 0.08, 0.15);
  const handleMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9, roughness: 0.2 });
  const handle = new THREE.Mesh(handleGeo, handleMat);
  handle.position.set(-0.65, 1.35, 0.12);
  exitDoorGroup.add(handle);

  // Glowing Green EXIT Sign (非常口)
  const signGeo = new THREE.BoxGeometry(1.2, 0.45, 0.1);
  const signMat = new THREE.MeshBasicMaterial({ color: 0x00ff66 });
  const sign = new THREE.Mesh(signGeo, signMat);
  sign.position.set(0, 2.95, 0.08);
  exitDoorGroup.add(sign);

  // Green Emergency Spotlight
  const exitLight = new THREE.PointLight(0x00ff66, 2.8, 18, 1.2);
  exitLight.position.set(0, 2.5, 0.8);
  exitDoorGroup.add(exitLight);

  exitDoorGroup.position.set(x, 0, z + 1.2);
  parent.add(exitDoorGroup);
}

// --- Monsters Construction: Black Monster & Red Monster ---
function buildMonsters() {
  // 1. 黒のバケモノ (Shadow Rusher: Pitch black towering figure)
  blackMonsterGroup = new THREE.Group();
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x030304 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.6, 0.7), shadowMat);
  torso.position.y = 2.2;
  blackMonsterGroup.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), shadowMat);
  head.position.y = 3.9;
  blackMonsterGroup.add(head);

  // Piercing Glowing White/Red eyes
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const bLeftEye = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.08), eyeMat);
  bLeftEye.position.set(-0.3, 4.0, 0.56);
  const bRightEye = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.08), eyeMat);
  bRightEye.position.set(0.3, 4.0, 0.56);
  blackMonsterGroup.add(bLeftEye, bRightEye);

  // Wide gaping grin with jagged teeth
  const teethMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
  const grin = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.28, 0.1), teethMat);
  grin.position.set(0, 3.55, 0.56);
  blackMonsterGroup.add(grin);

  const armGeo = new THREE.BoxGeometry(0.4, 3.0, 0.4);
  const bLeftArm = new THREE.Mesh(armGeo, shadowMat);
  bLeftArm.position.set(-1.05, 1.8, 0);
  const bRightArm = new THREE.Mesh(armGeo, shadowMat);
  bRightArm.position.set(1.05, 1.8, 0);
  blackMonsterGroup.add(bLeftArm, bRightArm);

  blackMonsterGroup.position.set(0, -100, 0);
  blackMonsterGroup.visible = false;
  scene.add(blackMonsterGroup);

  // 2. 赤のバケモノ (Crimson Reaper: Floating red wraith with horizontal scythes at head height)
  redMonsterGroup = new THREE.Group();
  const redMat = new THREE.MeshBasicMaterial({ color: 0xaa0000 });
  const crimsonEyeMat = new THREE.MeshBasicMaterial({ color: 0xffdd00 });

  const rBody = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 8), redMat);
  rBody.rotation.x = Math.PI;
  rBody.position.y = 2.0;
  redMonsterGroup.add(rBody);

  const rHead = new THREE.Mesh(new THREE.SphereGeometry(0.65, 8, 8), redMat);
  rHead.position.y = 2.7;
  redMonsterGroup.add(rHead);

  const rEye1 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.1), crimsonEyeMat);
  rEye1.position.set(-0.25, 2.75, 0.55);
  const rEye2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.1), crimsonEyeMat);
  rEye2.position.set(0.25, 2.75, 0.55);
  redMonsterGroup.add(rEye1, rEye2);

  // Giant sweeping horizontal scythe blades at head height (1.4m to 2.2m)
  const scytheGeo = new THREE.BoxGeometry(3.6, 0.12, 0.45);
  const scytheMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.9, roughness: 0.1 });
  const scythe = new THREE.Mesh(scytheGeo, scytheMat);
  scythe.position.y = 1.65; // Exactly player head height!
  redMonsterGroup.add(scythe);

  const redLight = new THREE.PointLight(0xff0000, 3.5, 20);
  redLight.position.set(0, 2.2, 0);
  redMonsterGroup.add(redLight);

  redMonsterGroup.position.set(0, -100, 0);
  redMonsterGroup.visible = false;
  scene.add(redMonsterGroup);
}

// --- Cinematic Camera in 3D Home Screen & Lobby ---
function updateCinematicCamera(now) {
  const t = now * 0.0006;
  camera.position.x = spawnWorldPos.x + Math.sin(t * 0.8) * 1.8;
  camera.position.y = STAND_HEIGHT + Math.sin(t * 1.2) * 0.08;
  camera.position.z = spawnWorldPos.z + Math.cos(t * 0.6) * 1.8;

  camera.lookAt(
    spawnWorldPos.x + Math.sin(t * 0.5) * 4.0,
    STAND_HEIGHT,
    spawnWorldPos.z - 8.0
  );
}

// --- Event Listeners & Controls ---
function setupEventListeners() {
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w') keys.w = true;
    if (k === 'a') keys.a = true;
    if (k === 's') keys.s = true;
    if (k === 'd') keys.d = true;
    if (e.key === 'Shift') keys.shift = true;

    // Jump [Space]
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      handleJump();
    }

    // Crouch [C]
    if (k === 'c') {
      toggleCrouch();
    }

    // Hotbar Slot 1 toggle [1]
    if (e.key === '1') {
      toggleSlot1();
    }

    // Interaction / Hide [E]
    if (k === 'e') {
      handleInteract();
    }

    // Energy Drink [Q]
    if (k === 'q') {
      useEnergyDrink();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w') keys.w = false;
    if (k === 'a') keys.a = false;
    if (k === 's') keys.s = false;
    if (k === 'd') keys.d = false;
    if (e.key === 'Shift') keys.shift = false;
  });

  // Pointer lock for 3D FPS camera
  const canvas = renderer.domElement;
  canvas.addEventListener('click', () => {
    if (gameState === 'playing' && !isPointerLocked) {
      canvas.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    isPointerLocked = (document.pointerLockElement === canvas);
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPointerLocked || isHidden || gameState !== 'playing') return;
    const sens = 0.0022;
    camera.rotation.y -= e.movementX * sens;
    camera.rotation.x -= e.movementY * sens;
    camera.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, camera.rotation.x));
  });

  // HUD Button controls
  crouchBtn.addEventListener('click', () => toggleCrouch());
  jumpBtn.addEventListener('click', () => handleJump());
  hideBtn.addEventListener('click', () => handleInteract());
  drinkBtn.addEventListener('click', () => useEnergyDrink());
  hotbarSlot1.addEventListener('click', () => toggleSlot1());

  // Solo & Lobby buttons
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
      alert("部屋コードを入力してください");
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
      startGameplay();
    }
  });

  leaveLobbyBtn.addEventListener('click', () => {
    if (roomManager) {
      roomManager.leaveRoom();
    }
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
  // Shirt Swatches
  document.querySelectorAll('#shirtSwatches .color-swatch').forEach(swatch => {
    if (swatch.dataset.color === characterCustomization.shirtColor) {
      swatch.classList.add('active');
    }
    swatch.addEventListener('click', () => {
      document.querySelectorAll('#shirtSwatches .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      characterCustomization.shirtColor = swatch.dataset.color;
      saveCustomization();
    });
  });

  // Pants Swatches
  document.querySelectorAll('#pantsSwatches .color-swatch').forEach(swatch => {
    if (swatch.dataset.color === characterCustomization.pantsColor) {
      swatch.classList.add('active');
    }
    swatch.addEventListener('click', () => {
      document.querySelectorAll('#pantsSwatches .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      characterCustomization.pantsColor = swatch.dataset.color;
      saveCustomization();
    });
  });

  // Skin Swatches
  document.querySelectorAll('#skinSwatches .color-swatch').forEach(swatch => {
    if (swatch.dataset.color === characterCustomization.skinColor) {
      swatch.classList.add('active');
    }
    swatch.addEventListener('click', () => {
      document.querySelectorAll('#skinSwatches .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      characterCustomization.skinColor = swatch.dataset.color;
      saveCustomization();
    });
  });

  // Hat Pills
  document.querySelectorAll('#hatPills .hat-pill').forEach(pill => {
    if (pill.dataset.hat === characterCustomization.hat) {
      pill.classList.add('active');
    }
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
    localStorage.setItem('backrooms_customization', JSON.stringify(characterCustomization));
  } catch (e) {}
  if (roomManager) {
    roomManager.updateCustomization(characterCustomization);
  }
}

// --- Player Jump [Space] ---
function handleJump() {
  if (gameState !== 'playing' || isHidden || isDead || hasCleared) return;
  // Can only jump if on or near ground
  const currentBaseY = isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT;
  if (Math.abs(playerY - currentBaseY) < 0.12 && playerVy <= 0.5) {
    playerVy = JUMP_VELOCITY;
    sound.playJump();
  }
}

// --- Player Crouch [C] ---
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
    stanceBadge.style.borderColor = '#f1c40f';
    stanceBadge.style.color = '#f1c40f';
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
    slotState.style.display = 'block';
  } else {
    hotbarSlot1.classList.remove('active');
    slotState.textContent = '収納中';
    slotState.style.display = 'block';
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

// --- Interaction (Bed Hide/Emerge or Escape Door) ---
function handleInteract() {
  if (gameState !== 'playing' || isDead || hasCleared) return;

  // If already hidden, emerge from bed
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

  // Check proximity to Exit Door
  const distToExit = camera.position.distanceTo(new THREE.Vector3(exitWorldPos.x, camera.position.y, exitWorldPos.z + 1.2));
  if (distToExit < 3.2) {
    triggerGameClear();
    return;
  }

  // Check proximity to Bed
  const bed = getNearbyBed();
  if (bed) {
    isHidden = true;
    currentHidingSpot = bed;
    sound.playHide();
    hideBtn.classList.add('active');
    stanceIcon.textContent = '🛏️';
    stanceText.textContent = 'ベッド下に潜伏中 [Eで出る]';
    stanceBadge.style.borderColor = '#3498db';
    stanceBadge.style.color = '#3498db';
    interactPrompt.textContent = '【E】ベッドから出る';
    interactPrompt.style.display = 'block';
  }
}

function getNearbyBed() {
  for (let bed of hidingBeds) {
    const dist = camera.position.distanceTo(bed.pos);
    if (dist < 3.2) {
      return bed;
    }
  }
  return null;
}

function updateInteractPrompt() {
  if (gameState !== 'playing' || isDead || hasCleared) {
    showInteractPrompt(false);
    return;
  }

  if (isHidden) {
    interactPrompt.textContent = '【E】ベッドから出る';
    showInteractPrompt(true);
    return;
  }

  const distToExit = camera.position.distanceTo(new THREE.Vector3(exitWorldPos.x, camera.position.y, exitWorldPos.z + 1.2));
  if (distToExit < 3.2) {
    interactPrompt.textContent = '【E】非常ドアを開けて脱出する！';
    showInteractPrompt(true);
    return;
  }

  const bed = getNearbyBed();
  if (bed) {
    interactPrompt.textContent = '【E】ベッドの下に潜る';
    showInteractPrompt(true);
    return;
  }

  showInteractPrompt(false);
}

function showInteractPrompt(show) {
  interactPrompt.style.display = show ? 'block' : 'none';
}

// --- Wall Collision Detection (Prevents clipping into maze walls) ---
function checkWallCollision(newX, newZ, radius = 0.45) {
  for (let wall of mazeWalls) {
    // Circle-AABB test
    const closestX = Math.max(wall.minX, Math.min(newX, wall.maxX));
    const closestZ = Math.max(wall.minZ, Math.min(newZ, wall.maxZ));
    const distX = newX - closestX;
    const distZ = newZ - closestZ;
    if ((distX * distX + distZ * distZ) < (radius * radius)) {
      return true; // Collision detected
    }
  }
  return false;
}

// --- Main Game Loop Update ---
function updateGame(dt) {
  // Update cooldowns
  if (drinkCooldown > 0) {
    drinkCooldown -= dt;
    const pct = Math.max(0, drinkCooldown / 60) * 100;
    drinkCooldownBar.style.width = pct + '%';
    drinkBtn.disabled = true;
  } else {
    drinkBtn.disabled = false;
    drinkCooldownBar.style.width = '0%';
  }

  if (drinkActiveTimer > 0) {
    drinkActiveTimer -= dt;
  }

  // Handle Movement and Gravity
  if (!isHidden && !isDead && !hasCleared) {
    let speedMult = 1.0;
    if (isCrouching) speedMult = 0.6; // Crouch walk is slower
    if (keys.shift) speedMult = 1.35;
    if (drinkActiveTimer > 0) speedMult = 2.4; // Energy drink super speed

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

      // Separate X and Z movement for smooth wall sliding
      const deltaX = moveDir.x * baseSpeed * dt;
      const deltaZ = moveDir.z * baseSpeed * dt;

      if (!checkWallCollision(camera.position.x + deltaX, camera.position.z)) {
        camera.position.x += deltaX;
      }
      if (!checkWallCollision(camera.position.x, camera.position.z + deltaZ)) {
        camera.position.z += deltaZ;
      }

      // Footstep & Head bobbing
      headBobTimer += dt * 10 * speedMult;
      footstepTimer += dt * speedMult;
      if (footstepTimer > 0.44) {
        sound.playFootstep(keys.shift || drinkActiveTimer > 0);
        footstepTimer = 0;
      }
    }

    // Vertical Physics (Jump & Gravity)
    const baseTargetY = isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    playerVy += GRAVITY * dt;
    playerY += playerVy * dt;

    if (playerY <= baseTargetY) {
      playerY = baseTargetY;
      playerVy = 0;
    }

    // Camera height interpolation
    camera.position.y = playerY + Math.sin(headBobTimer) * 0.035;
  } else if (isHidden && currentHidingSpot) {
    // Lerp camera smoothly under the bed frame
    camera.position.lerp(currentHidingSpot.hideCamPos, dt * 10);
  }

  // Sway first-person flashlight in hand
  if (firstPersonFlashlightMesh && firstPersonFlashlightMesh.visible) {
    const bobX = Math.sin(headBobTimer * 0.5) * 0.015;
    const bobY = Math.abs(Math.sin(headBobTimer)) * 0.012;
    firstPersonFlashlightMesh.position.set(0.24 + bobX, -0.21 + bobY, -0.42);
  }

  updateInteractPrompt();
  updateMonstersSequence(dt);

  // Sync to RoomManager / Multiplayer
  syncTimer += dt;
  if (syncTimer > 0.12 && roomManager) {
    syncTimer = 0;
    roomManager.updatePosition(
      camera.position.x,
      camera.position.z,
      camera.position.y,
      camera.rotation.y,
      isHidden,
      isDead,
      isCrouching
    );
  }
}

// --- Multiple Monsters Sequence ---
// 1. Black Monster: 3 Blackout flickers -> Must HIDE [E]
// 2. Red Monster: 3 Crimson flickers -> Must CROUCH [C]
function updateMonstersSequence(dt) {
  if (isMonsterRushing) {
    monsterProgress += dt * 38;
    const activeGroup = (currentMonsterType === 'black') ? blackMonsterGroup : redMonsterGroup;

    // Move monster towards and past the player
    const rushDir = new THREE.Vector3().subVectors(monsterTargetPos, monsterSpawnPos).normalize();
    activeGroup.position.copy(monsterSpawnPos).addScaledVector(rushDir, monsterProgress);

    // Rotate red scythe blades
    if (currentMonsterType === 'red') {
      activeGroup.children[3].rotation.y += dt * 18; // Fast spinning scythe
    }

    // Camera shake when monster is near
    const distToPlayer = activeGroup.position.distanceTo(camera.position);
    if (distToPlayer < 20) {
      const shake = (1 - distToPlayer / 20) * 0.1;
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
    }

    // Check hit condition
    if (distToPlayer < 3.2 && !isDead) {
      if (currentMonsterType === 'black') {
        // Black Monster: Requires being HIDDEN (E in bed)
        if (isHidden) {
          sound.playHeartbeat(true);
        } else {
          handleMonsterCatch();
        }
      } else if (currentMonsterType === 'red') {
        // Red Monster: Sweeps high blades at eye level -> Requires being CROUCHED (C key)
        if (isCrouching && camera.position.y <= 0.9) {
          sound.playRedMonsterSwoosh();
        } else {
          handleMonsterCatch();
        }
      }
    }

    if (monsterProgress > 75) {
      isMonsterRushing = false;
      activeGroup.visible = false;
      nextMonsterTimer = 22 + Math.random() * 12;
    }
    return;
  }

  // Countdown to next monster attack
  nextMonsterTimer -= dt;
  if (nextMonsterTimer <= 0 && !isWarningActive) {
    chooseAndTriggerMonsterWarning();
  }
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

function chooseAndTriggerMonsterWarning() {
  isWarningActive = true;
  // Alternate or randomize monster type: 'black' or 'red'
  currentMonsterType = (Math.random() < 0.5) ? 'black' : 'red';

  if (currentMonsterType === 'black') {
    // 3 Blackout Flickers (Hide!)
    triggerBlackFlickers();
  } else {
    // 3 Red Strobe Flickers (Crouch!)
    triggerRedFlickers();
  }
}

// 3 Blackout Flickers: screen flickers black 3 times
function triggerBlackFlickers() {
  doSingleBlackFlicker(1, () => {
    setTimeout(() => {
      doSingleBlackFlicker(2, () => {
        setTimeout(() => {
          doSingleBlackFlicker(3, () => {
            // 3 flickers completed with ZERO text, brief 2.8s suspense then rush!
            setTimeout(() => {
              startMonsterRush('black');
            }, 2800);
          });
        }, 550);
      });
    }, 550);
  });
}

function doSingleBlackFlicker(count, onDone) {
  sound.playFlickerSpark();
  warningOverlay.className = 'flicker-blackout';

  ceilingLights.forEach(c => {
    c.light.intensity = 0.08;
    c.tubeMat.emissiveIntensity = 0.05;
  });

  const duration = 220 + count * 35;
  setTimeout(() => {
    warningOverlay.className = '';
    ceilingLights.forEach(c => {
      c.light.intensity = c.baseIntensity;
      c.tubeMat.emissiveIntensity = 1.15;
    });
    if (onDone) onDone();
  }, duration);
}

// 3 Red Strobe Flickers: screen pulses crimson red 3 times
function triggerRedFlickers() {
  doSingleRedFlicker(1, () => {
    setTimeout(() => {
      doSingleRedFlicker(2, () => {
        setTimeout(() => {
          doSingleRedFlicker(3, () => {
            // 3 flickers completed, 2.8s suspense then rush!
            setTimeout(() => {
              startMonsterRush('red');
            }, 2800);
          });
        }, 550);
      });
    }, 550);
  });
}

function doSingleRedFlicker(count, onDone) {
  sound.playRedWarning();
  warningOverlay.className = 'flicker-red';

  const duration = 240 + count * 30;
  setTimeout(() => {
    warningOverlay.className = '';
    if (onDone) onDone();
  }, duration);
}

function startMonsterRush(type) {
  isMonsterRushing = true;
  isWarningActive = false;
  monsterProgress = 0;

  // Determine rush path: from behind or ahead through current corridor
  const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), camera.rotation.y);
  monsterSpawnPos.copy(camera.position).subScaledVector(forward, 45);
  monsterTargetPos.copy(camera.position).addScaledVector(forward, 45);

  const activeGroup = (type === 'black') ? blackMonsterGroup : redMonsterGroup;
  activeGroup.position.copy(monsterSpawnPos);
  activeGroup.lookAt(monsterTargetPos);
  activeGroup.visible = true;

  if (type === 'black') {
    sound.playMonsterRoar();
  } else {
    sound.playRedMonsterSwoosh();
  }
}

// Jumpscare -> Direct return to 3D Home Screen
function triggerJumpscare() {
  isDead = true;
  sound.playJumpscare();
  jumpscareOverlay.style.display = 'flex';

  setTimeout(() => {
    jumpscareOverlay.style.display = 'none';
    returnToHomeScreen();
  }, 850);
}

function returnToHomeScreen() {
  if (document.exitPointerLock) {
    document.exitPointerLock();
  }

  gameState = 'title';
  isDead = false;
  isMonsterRushing = false;
  isWarningActive = false;
  blackMonsterGroup.visible = false;
  redMonsterGroup.visible = false;
  hudElement.style.display = 'none';
  titleScreen.style.display = 'flex';
  lobbyScreen.style.display = 'none';
  clearScreen.style.display = 'none';

  if (firstPersonFlashlightMesh) firstPersonFlashlightMesh.visible = false;
  if (flashlightLight) flashlightLight.visible = false;

  if (homeDeathToast) {
    homeDeathToast.textContent = '☠️ バケモノに追いつかれた…… 再挑戦してください！';
    homeDeathToast.style.display = 'block';
    setTimeout(() => {
      homeDeathToast.style.display = 'none';
    }, 4500);
  }
}

function flashScreenRed() {
  warningOverlay.className = 'flicker-red';
  setTimeout(() => {
    warningOverlay.className = '';
  }, 350);
}

function triggerGameClear() {
  hasCleared = true;
  sound.playDoorClear();
  if (document.exitPointerLock) document.exitPointerLock();
  hudElement.style.display = 'none';
  clearScreen.style.display = 'flex';
}

// --- Solo & Multiplayer Room Management ---
function startSoloGame() {
  titleScreen.style.display = 'none';
  lobbyScreen.style.display = 'none';
  clearScreen.style.display = 'none';
  hudElement.style.display = 'block';
  startGameplay();
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
    roomManager.onRoomUpdate = (data) => {
      renderLobbyParty(data);
      if (data.gameState === 'playing' && gameState !== 'playing') {
        lobbyScreen.style.display = 'none';
        hudElement.style.display = 'block';
        startGameplay();
      }
    };
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

    const shirtColor = custom.shirtColor || '#e74c3c';
    const hatName = custom.hat === 'cap' ? '🧢' : custom.hat === 'fedora' ? '🎩' : custom.hat === 'crown' ? '👑' : custom.hat === 'helmet' ? '👷' : '👤';

    card.innerHTML = `
      <div style="font-size: 2.2rem; margin-bottom: 4px;">${hatName}</div>
      <div style="font-weight: 800; font-size: 0.95rem; color: #fff; margin-bottom: 2px;">
        ${p.name || 'プレイヤー'} ${p.isHost ? '👑' : ''}
      </div>
      <div style="font-size: 0.75rem; color: #f1c40f;">
        装備: ${p.item === 'flashlight' ? '🔦 懐中電灯' : p.item === 'bandage' ? '🩹 絆創膏' : '⚡ エナドリ'}
      </div>
      <div style="width: 20px; height: 6px; background: ${shirtColor}; margin: 6px auto 0; border-radius: 3px;"></div>
    `;
    partyList.appendChild(card);
  });
}

function startGameplay() {
  gameState = 'playing';
  isDead = false;
  hasCleared = false;
  bandageUsed = false;
  isHidden = false;
  isCrouching = false;
  currentHidingSpot = null;
  targetCameraY = STAND_HEIGHT;
  playerY = STAND_HEIGHT;
  playerVy = 0;
  nextMonsterTimer = 22 + Math.random() * 8;

  camera.position.copy(spawnWorldPos);
  camera.rotation.set(0, 0, 0);

  updateItemSlotView();
  updateSlotUI();
  sound.startBackroomsHum();

  // Try pointer lock
  renderer.domElement.requestPointerLock();
}

// --- Multiplayer 3D Character Models (Custom Roblox Avatar) ---
function getOrCreatePlayerMesh(pId, data) {
  if (otherPlayerMeshes[pId]) return otherPlayerMeshes[pId];

  const group = new THREE.Group();
  const custom = data.customization || {};
  const skinMat = new THREE.MeshStandardMaterial({ color: custom.skinColor || '#ffd32a' });
  const shirtMat = new THREE.MeshStandardMaterial({ color: custom.shirtColor || '#e74c3c' });
  const pantsMat = new THREE.MeshStandardMaterial({ color: custom.pantsColor || '#1a252f' });

  // Head
  const headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const head = new THREE.Mesh(headGeo, skinMat);
  head.position.y = 1.45;
  group.add(head);

  // Hat
  if (custom.hat === 'cap') {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.12, 0.65), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    cap.position.set(0, 1.72, 0.05);
    group.add(cap);
  } else if (custom.hat === 'crown') {
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 5), new THREE.MeshStandardMaterial({ color: 0xf1c40f }));
    crown.position.set(0, 1.76, 0);
    group.add(crown);
  } else if (custom.hat === 'helmet') {
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), new THREE.MeshStandardMaterial({ color: 0xf39c12 }));
    helmet.position.set(0, 1.72, 0);
    group.add(helmet);
  }

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 0.35), shirtMat);
  torso.position.y = 0.8;
  group.add(torso);

  // Arms
  const armGeo = new THREE.BoxGeometry(0.25, 0.75, 0.25);
  const lArm = new THREE.Mesh(armGeo, shirtMat);
  lArm.position.set(-0.5, 0.8, 0);
  const rArm = new THREE.Mesh(armGeo, shirtMat);
  rArm.position.set(0.5, 0.8, 0);
  group.add(lArm, rArm);

  // Legs
  const legGeo = new THREE.BoxGeometry(0.3, 0.8, 0.3);
  const lLeg = new THREE.Mesh(legGeo, pantsMat);
  lLeg.position.set(-0.2, 0.0, 0);
  const rLeg = new THREE.Mesh(legGeo, pantsMat);
  rLeg.position.set(0.2, 0.0, 0);
  group.add(lLeg, rLeg);

  // Floating Name Tag
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.font = 'bold 30px sans-serif';
  ctx.fillStyle = '#f1c40f';
  ctx.textAlign = 'center';
  ctx.fillText(data.name || '生存者', 128, 44);

  const tagTexture = new THREE.CanvasTexture(canvas);
  const tagMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.2, 0.3),
    new THREE.MeshBasicMaterial({ map: tagTexture, transparent: true })
  );
  tagMesh.position.y = 1.95;
  group.add(tagMesh);

  scene.add(group);
  otherPlayerMeshes[pId] = group;
  return group;
}

// Render loop for Three.js
function renderThree(dt) {
  // Update remote multiplayer characters
  if (roomManager && roomManager.roomData && roomManager.roomData.players) {
    const players = roomManager.roomData.players;
    Object.keys(players).forEach(pId => {
      if (pId !== localPlayerId) {
        const p = players[pId];
        const mesh = getOrCreatePlayerMesh(pId, p);
        if (p.x !== undefined && p.z !== undefined) {
          mesh.position.lerp(new THREE.Vector3(p.x, p.y ? p.y - STAND_HEIGHT : 0, p.z), dt * 10);
          mesh.rotation.y = p.rotation || 0;
          mesh.visible = !p.isHidden && !p.isDead;
        }
      }
    });
  }

  renderer.render(scene, camera);
}
