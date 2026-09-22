// Web Audio Synthesizer for 3D Roblox Horror Game
export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.isMuted = false;
    this.heartbeatOsc = null;
    this.heartbeatTimer = null;
    this.droneGain = null;
    this.droneOsc = null;
    this.initialized = false;
  }

  init() {
    if (this.initialized && this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.7, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);
    this.initialized = true;

    this.startAmbientDrone();
  }

  startAmbientDrone() {
    if (!this.ctx || this.droneOsc) return;
    try {
      // 60Hz and 120Hz fluorescent electrical hum
      const osc = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      this.droneGain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(60, this.ctx.currentTime); // 60Hz AC hum

      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(120, this.ctx.currentTime); // 120Hz harmonic

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(240, this.ctx.currentTime);

      this.droneGain.gain.setValueAtTime(0.01, this.ctx.currentTime);
      this.droneGain.gain.exponentialRampToValueAtTime(0.045, this.ctx.currentTime + 2);

      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(this.droneGain);
      this.droneGain.connect(this.masterGain);
      osc.start();
      osc2.start();
      this.droneOsc = osc;
    } catch (e) {
      console.warn('Ambient drone error', e);
    }
  }

  // Flashlight click on / off
  playFlashlightClick() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1800, now);
      osc.frequency.exponentialRampToValueAtTime(400, now + 0.04);
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.045);
    } catch (e) {}
  }

  // 3-Flicker electric spark warning
  playFlickerSpark() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      // White noise burst with bandpass
      const bufferSize = this.ctx.sampleRate * 0.12;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      const whiteNoise = this.ctx.createBufferSource();
      whiteNoise.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1200, now);
      filter.Q.setValueAtTime(3, now);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      whiteNoise.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      whiteNoise.start(now);

      // Low thump
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.15);
      oscGain.gain.setValueAtTime(0.4, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      osc.connect(oscGain);
      oscGain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch (e) {}
  }

  // Monster Screech & Roar
  playMonsterRoar() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      // Low roaring oscillators
      const freqs = [65, 82, 110, 130];
      freqs.forEach((f, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = idx % 2 === 0 ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(f + (Math.random() * 8 - 4), now);
        osc.frequency.linearRampToValueAtTime(f * 0.7, now + 2.5);

        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 2.5);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 2.6);
      });

      // High demonic screech
      const screech = this.ctx.createOscillator();
      const screechGain = this.ctx.createGain();
      screech.type = 'sawtooth';
      screech.frequency.setValueAtTime(800, now);
      screech.frequency.exponentialRampToValueAtTime(320, now + 1.8);

      screechGain.gain.setValueAtTime(0.25, now);
      screechGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);

      screech.connect(screechGain);
      screechGain.connect(this.masterGain);
      screech.start(now);
      screech.stop(now + 1.9);
    } catch (e) {}
  }

  // Jumpscare Death Blast
  playJumpscare() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      // Massive cluster chord + white noise burst
      const cluster = [150, 220, 311, 466, 622, 932];
      cluster.forEach(f => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, now);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now);
        osc.stop(now + 1.6);
      });

      // White noise explosion
      const bufferSize = this.ctx.sampleRate * 0.8;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (this.ctx.sampleRate * 0.3));
      }
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.5, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
      noise.connect(nGain);
      nGain.connect(this.masterGain);
      noise.start(now);
    } catch (e) {}
  }

  // Heartbeat sound
  playHeartbeat(fast = false) {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(fast ? 75 : 55, now);
      osc.frequency.exponentialRampToValueAtTime(30, now + 0.14);

      gain.gain.setValueAtTime(fast ? 0.35 : 0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.18);
    } catch (e) {}
  }

  // Footstep sound
  playFootstep(isSprint = false) {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(90 + Math.random() * 30, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.08);

      gain.gain.setValueAtTime(isSprint ? 0.18 : 0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch (e) {}
  }

  // Energy drink gulp + boost sound
  playEnergyDrink() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      // Rising high chime
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.4);

      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.55);
    } catch (e) {}
  }

  // Bandage shield protection sound
  playBandageHeal() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      [440, 554, 659, 880].forEach((f, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, now + i * 0.08);
        gain.gain.setValueAtTime(0.2, now + i * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.3);
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(now + i * 0.08);
        osc.stop(now + i * 0.08 + 0.35);
      });
    } catch (e) {}
  }

  // Door Creak & Clear Chime
  playDoorClear() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      // Deep heavy door rumble
      const rumble = this.ctx.createOscillator();
      const rGain = this.ctx.createGain();
      rumble.type = 'sawtooth';
      rumble.frequency.setValueAtTime(80, now);
      rumble.frequency.linearRampToValueAtTime(40, now + 1.2);
      rGain.gain.setValueAtTime(0.3, now);
      rGain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
      rumble.connect(rGain);
      rGain.connect(this.masterGain);
      rumble.start(now);
      rumble.stop(now + 1.3);

      // Heavenly escape bell chime
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const bell = this.ctx.createOscillator();
        const bGain = this.ctx.createGain();
        bell.type = 'sine';
        bell.frequency.setValueAtTime(f, now + 0.3 + i * 0.15);
        bGain.gain.setValueAtTime(0.22, now + 0.3 + i * 0.15);
        bGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
        bell.connect(bGain);
        bGain.connect(this.masterGain);
        bell.start(now + 0.3 + i * 0.15);
        bell.stop(now + 2.6);
      });
    } catch (e) {}
  }

  // Hide in bed / wall whoosh
  playHide() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.exponentialRampToValueAtTime(50, now + 0.25);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.3);
    } catch (e) {}
  }

  // Crouch sound (C key)
  playCrouch() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(110, now);
      osc.frequency.exponentialRampToValueAtTime(45, now + 0.15);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch (e) {}
  }

  // Jump sound (Space key)
  playJump() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.exponentialRampToValueAtTime(280, now + 0.18);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.19);
    } catch (e) {}
  }

  // Red Warning Strobe Alarm (Distorted pulsating siren)
  playRedWarning() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.linearRampToValueAtTime(620, now + 0.12);
      gain.gain.setValueAtTime(0.24, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.22);
    } catch (e) {}
  }

  // Red Monster Sweeping Scythe / Air Blade Swoosh
  playRedMonsterSwoosh() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      // High pitch metallic razor whistle
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(950, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 0.8);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.85);
    } catch (e) {}
  }
}
