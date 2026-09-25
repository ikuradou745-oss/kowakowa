// WebRTC Voice Chat Manager for Jinrou Online (人狼オンライン)
// Provides P2P mesh audio, voice activity detection (speaking indicator), VC ON/OFF, and Mic Mute/Unmute

export class VoiceManager {
  constructor({ onSpeakingChange, onPeerVoiceState, onRemoteTrack, onLog }) {
    this.onSpeakingChange = onSpeakingChange || (() => {});
    this.onPeerVoiceState = onPeerVoiceState || (() => {});
    this.onRemoteTrack = onRemoteTrack || (() => {});
    this.onLog = onLog || (() => {});

    // State
    this.isVcEnabled = true; // User request: VC is ON by default
    this.isMicMuted = false; // Microphone is ON by default
    this.volumePercent = 100; // 50% to 500%
    this.localStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.analyserTimer = null;
    this.isSpeaking = false;
    this.isAudioInitialized = false;

    // WebRTC Peers: peerId -> { pc, audioElement, gainNode }
    this.peers = new Map();

    // Signal send function (injected by main.js)
    this.sendSignal = null;
    this.localPlayerId = null;
    this.roomCode = null;

    // ICE Servers configuration
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };
  }

  setSignalSender(sender, localPlayerId, roomCode) {
    this.sendSignal = sender;
    this.localPlayerId = localPlayerId;
    this.roomCode = roomCode;
  }

  // Initialize or resume microphone stream
  async initLocalAudio() {
    if (this.localStream) {
      this.updateTrackState();
      return true;
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.onLog('お使いの環境ではマイク機能がサポートされていません');
        return false;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.localStream = stream;
      this.isAudioInitialized = true;
      this.setupAudioAnalysis(stream);
      this.updateTrackState();

      // Attach track to any existing peer connections
      for (const [peerId, peerData] of this.peers.entries()) {
        stream.getAudioTracks().forEach(track => {
          peerData.pc.addTrack(track, stream);
        });
      }

      this.onLog('マイクが正常に接続されました');
      return true;
    } catch (err) {
      console.warn('[WebRTC Voice] Microphone permission denied or unavailable:', err);
      this.onLog('マイクへのアクセスが拒否されたか、利用できません（チャット機能をお使いいただけます）');
      return false;
    }
  }

  // Voice Activity Detection (VAD) using AnalyserNode
  setupAudioAnalysis(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.4;
      source.connect(this.analyser);

      const buffer = new Uint8Array(this.analyser.frequencyBinCount);
      let speakingFrames = 0;

      if (this.analyserTimer) clearInterval(this.analyserTimer);
      this.analyserTimer = setInterval(() => {
        if (!this.localStream || !this.isVcEnabled || this.isMicMuted) {
          if (this.isSpeaking) {
            this.isSpeaking = false;
            this.onSpeakingChange(false);
            this.broadcastVoiceState();
          }
          return;
        }

        this.analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const avg = sum / buffer.length;

        // Threshold for speaking
        const currentlySpeaking = avg > 14;
        if (currentlySpeaking) {
          speakingFrames = Math.min(speakingFrames + 1, 5);
        } else {
          speakingFrames = Math.max(speakingFrames - 1, 0);
        }

        const isNowSpeaking = speakingFrames >= 2;
        if (isNowSpeaking !== this.isSpeaking) {
          this.isSpeaking = isNowSpeaking;
          this.onSpeakingChange(isNowSpeaking);
          this.broadcastVoiceState();
        }
      }, 100);
    } catch (e) {
      console.warn('[WebRTC] Audio analysis setup error:', e);
    }
  }

  // Apply track enabled status based on isVcEnabled and isMicMuted
  updateTrackState() {
    if (this.localStream) {
      const audioTracks = this.localStream.getAudioTracks();
      const shouldBeActive = this.isVcEnabled && !this.isMicMuted;
      audioTracks.forEach(track => {
        track.enabled = shouldBeActive;
      });
    }

    // Update remote peer audio elements
    for (const peer of this.peers.values()) {
      if (peer.audioElement) {
        peer.audioElement.muted = !this.isVcEnabled;
        if (peer.gainNode) {
          peer.gainNode.gain.setValueAtTime(this.isVcEnabled ? (this.volumePercent / 100) : 0, 0);
        }
      }
    }

    this.broadcastVoiceState();
  }

  // Toggle VC ON/OFF
  setVcEnabled(enabled) {
    this.isVcEnabled = !!enabled;
    this.updateTrackState();
    if (this.isVcEnabled && !this.localStream) {
      this.initLocalAudio();
    }
  }

  // Toggle Mic ON/OFF (Mute/Unmute)
  setMicMuted(muted) {
    this.isMicMuted = !!muted;
    this.updateTrackState();
  }

  // Set VC Volume (50% ~ 500%)
  setVolume(percent) {
    this.volumePercent = Math.max(50, Math.min(500, Number(percent) || 100));
    const gainValue = this.isVcEnabled ? (this.volumePercent / 100) : 0;
    for (const peer of this.peers.values()) {
      if (peer.gainNode) {
        peer.gainNode.gain.setValueAtTime(gainValue, 0);
      }
    }
  }

  broadcastVoiceState() {
    if (this.sendSignal && this.localPlayerId && this.roomCode) {
      this.sendSignal({
        type: 'VOICE_STATE',
        payload: {
          roomCode: this.roomCode,
          senderId: this.localPlayerId,
          isVcOn: this.isVcEnabled,
          isMuted: this.isMicMuted,
          isSpeaking: this.isSpeaking
        }
      });
    }
  }

  // Handle peer joining room -> initiate connection if needed
  async handlePeerJoined(peerId, isInitiator = false) {
    if (peerId === this.localPlayerId) return;
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection(this.rtcConfig);

    // Audio element & Web Audio GainNode for volume scaling
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.muted = !this.isVcEnabled;

    let gainNode = null;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(this.isVcEnabled ? (this.volumePercent / 100) : 0, ctx.currentTime);
        gainNode.connect(ctx.destination);
      }
    } catch (e) {}

    const peerData = {
      pc,
      audioElement: audioEl,
      gainNode,
      peerId
    };
    this.peers.set(peerId, peerData);

    // Send ICE candidates to remote peer
    pc.onicecandidate = (event) => {
      if (event.candidate && this.sendSignal) {
        this.sendSignal({
          type: 'WEBRTC_SIGNAL',
          payload: {
            roomCode: this.roomCode,
            targetId: peerId,
            signal: {
              type: 'candidate',
              candidate: event.candidate
            }
          }
        });
      }
    };

    // Receive remote audio track
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      audioEl.srcObject = remoteStream;
      audioEl.play().catch(() => {});
      this.onRemoteTrack(peerId, remoteStream);
    };

    // Add local tracks if available
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // If initiator, create offer
    if (isInitiator) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        if (this.sendSignal) {
          this.sendSignal({
            type: 'WEBRTC_SIGNAL',
            payload: {
              roomCode: this.roomCode,
              targetId: peerId,
              signal: {
                type: 'offer',
                sdp: offer
              }
            }
          });
        }
      } catch (err) {
        console.warn('[WebRTC] Create offer failed:', err);
      }
    }
  }

  // Handle incoming WebRTC signaling message
  async handleSignal(senderId, signal) {
    if (!signal || senderId === this.localPlayerId) return;

    let peer = this.peers.get(senderId);
    if (!peer) {
      await this.handlePeerJoined(senderId, false);
      peer = this.peers.get(senderId);
    }
    if (!peer) return;

    const pc = peer.pc;

    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (this.sendSignal) {
          this.sendSignal({
            type: 'WEBRTC_SIGNAL',
            payload: {
              roomCode: this.roomCode,
              targetId: senderId,
              signal: {
                type: 'answer',
                sdp: answer
              }
            }
          });
        }
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'candidate' && signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (e) {
      console.warn('[WebRTC] handleSignal error:', e);
    }
  }

  // Handle peer leaving
  handlePeerLeft(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        peer.pc.close();
        if (peer.audioElement) {
          peer.audioElement.srcObject = null;
          peer.audioElement.remove();
        }
      } catch (e) {}
      this.peers.delete(peerId);
    }
  }

  // Leave room: close all connections
  leaveRoom() {
    for (const [peerId, peer] of this.peers.entries()) {
      try {
        peer.pc.close();
        if (peer.audioElement) {
          peer.audioElement.srcObject = null;
          peer.audioElement.remove();
        }
      } catch (e) {}
    }
    this.peers.clear();
    this.roomCode = null;

    if (this.analyserTimer) {
      clearInterval(this.analyserTimer);
      this.analyserTimer = null;
    }
    this.isSpeaking = false;
  }
}
