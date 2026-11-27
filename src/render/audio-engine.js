/**
 * Frozen Aperture — Procedural Spatial Web Audio Engine
 * Zero external audio assets; purely procedural, user-gesture gated, with mute,
 * volume, pause, and clean resource disposal.
 */

export class SpatialAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
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
      this.unlocked = true;
      return true;
    } catch (_) {
      return false;
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

  playEvent(type, payload = {}) {
    if (this.muted || !this.unlocked || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    if (type === 'contact' || type === 'propagation') {
      if (now - this.lastContactTime < 0.045) return; // Prevent audio flooding during cascades
      this.lastContactTime = now;
    }

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const panner = typeof this.ctx.createStereoPanner === 'function' ? this.ctx.createStereoPanner() : null;

    if (panner && Array.isArray(payload.position)) {
      panner.pan.value = Math.max(-0.85, Math.min(0.85, payload.position[0] / 6.0));
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      osc.connect(gain);
      gain.connect(this.masterGain);
    }

    if (type === 'release') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(240, now);
      osc.frequency.exponentialRampToValueAtTime(520, now + 0.16);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.23);
    } else if (type === 'suspend') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.exponentialRampToValueAtTime(190, now + 0.18);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
      osc.start(now);
      osc.stop(now + 0.21);
    } else if (type === 'vortex_activated') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(68, now);
      osc.frequency.exponentialRampToValueAtTime(142, now + 0.55);
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
      osc.start(now);
      osc.stop(now + 0.66);
    } else if (type === 'propagation') {
      osc.type = 'sine';
      const imp = Math.min(1, (payload.impulse || 0.5) * 0.4);
      osc.frequency.setValueAtTime(320 + imp * 260, now);
      osc.frequency.exponentialRampToValueAtTime(640, now + 0.14);
      gain.gain.setValueAtTime(0.12 + imp * 0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc.start(now);
      osc.stop(now + 0.17);
    } else if (type === 'contact') {
      osc.type = 'triangle';
      const imp = Math.min(1, (payload.impulse || 0.5) * 0.25);
      osc.frequency.setValueAtTime(140 + imp * 90, now);
      osc.frequency.exponentialRampToValueAtTime(62, now + 0.09);
      gain.gain.setValueAtTime(0.08 + imp * 0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.11);
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
      this.unlocked = false;
    }
  }
}
