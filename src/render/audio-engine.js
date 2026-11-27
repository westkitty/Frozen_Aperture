/**
 * Frozen Aperture — HRTF 3D Spatial Audio & Velocity-Layered Foley Engine (#20)
 * Purely procedural Web Audio API (zero external audio files), user-gesture gated,
 * with PannerNode (HRTF) synced to the Three.js camera listener, filtered noise
 * impact foley + mass-tuned harmonic partials, mute, volume, and cleanup.
 */

export class SpatialAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.noiseBuffer = null;
    this.muted = false;
    this.volume = 0.5;
    this.unlocked = false;
    this.lastContactTime = 0;
  }

  unlock() {
    if (this.unlocked && this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return true;
    }
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) return false;
    try {
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : this.volume;
      this.masterGain.connect(this.ctx.destination);
      this.noiseBuffer = this.createNoiseBuffer(this.ctx);
      this.unlocked = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  createNoiseBuffer(ctx) {
    const len = Math.floor(ctx.sampleRate * 0.25);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.25));
    }
    return buf;
  }

  /**
   * Syncs Web Audio listener position & orientation with the active Three.js camera (#20).
   */
  updateListener(camera) {
    if (!this.unlocked || !this.ctx || !camera) return;
    const l = this.ctx.listener;
    if (!l) return;
    const p = camera.position;
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
    } else if (typeof l.setPosition === 'function') {
      l.setPosition(p.x, p.y, p.z);
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol) || 0));
    if (this.masterGain && this.ctx && !this.muted) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  createSpatialNode(position) {
    if (!this.ctx) return this.masterGain;
    if (Array.isArray(position) && typeof this.ctx.createPanner === 'function') {
      const panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 2.0;
      panner.maxDistance = 40.0;
      panner.rolloffFactor = 0.85;
      panner.positionX.value = position[0] || 0;
      panner.positionY.value = position[1] || 0;
      panner.positionZ.value = position[2] || 0;
      panner.connect(this.masterGain);
      return panner;
    }
    return this.masterGain;
  }

  playEvent(type, payload = {}) {
    if (this.muted || !this.unlocked || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    if (type === 'contact' || type === 'propagation') {
      if (now - this.lastContactTime < 0.04) return;
      this.lastContactTime = now;
    }

    const dest = this.createSpatialNode(payload.position);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(dest);

    const mass = Math.max(0.2, Math.min(8, Number(payload.mass) || 1.2));
    const massPitchFactor = 1 / Math.pow(mass, 0.25);

    if (type === 'release') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(240 * massPitchFactor, now);
      osc.frequency.exponentialRampToValueAtTime(520 * massPitchFactor, now + 0.16);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.23);
    } else if (type === 'suspend') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(480 * massPitchFactor, now);
      osc.frequency.exponentialRampToValueAtTime(190 * massPitchFactor, now + 0.18);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
      osc.start(now);
      osc.stop(now + 0.21);
    } else if (type === 'vortex_activated') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(64, now);
      osc.frequency.exponentialRampToValueAtTime(148, now + 0.55);
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
      osc.start(now);
      osc.stop(now + 0.66);
    } else if (type === 'propagation') {
      const imp = Math.min(1, (payload.impulse || 0.5) * 0.4);
      osc.type = 'sine';
      osc.frequency.setValueAtTime((310 + imp * 250) * massPitchFactor, now);
      osc.frequency.exponentialRampToValueAtTime(640 * massPitchFactor, now + 0.14);
      gain.gain.setValueAtTime(0.12 + imp * 0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc.start(now);
      osc.stop(now + 0.17);
    } else if (type === 'contact') {
      const imp = Math.min(1, (payload.impulse || 0.5) * 0.25);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime((135 + imp * 85) * massPitchFactor, now);
      osc.frequency.exponentialRampToValueAtTime(58 * massPitchFactor, now + 0.09);
      gain.gain.setValueAtTime(0.08 + imp * 0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.11);

      // (#20) Velocity-layered filtered noise burst foley
      if (this.noiseBuffer && imp > 0.12) {
        const noise = this.ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 650 + imp * 1600;
        filter.Q.value = 1.4;
        const nGain = this.ctx.createGain();
        nGain.gain.setValueAtTime(0.06 + imp * 0.14, now);
        nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
        noise.connect(filter);
        filter.connect(nGain);
        nGain.connect(dest);
        noise.start(now);
        noise.stop(now + 0.09);
      }
    } else if (type === 'reset' || type === 'undo') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(380, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.15);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.17);
      osc.start(now);
      osc.stop(now + 0.18);
    }
  }

  dispose() {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.masterGain = null;
      this.noiseBuffer = null;
      this.unlocked = false;
    }
  }
}
