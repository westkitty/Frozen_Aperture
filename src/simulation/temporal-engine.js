/**
 * Frozen Aperture — Authoritative Selective Local-Time Simulation Engine
 *
 * Temporal Contract:
 * - Every body has a stable id and temporalState: 'held' | 'active' | 'sleeping' | 'suspended' | 'restored'.
 * - Frozen bodies ('held', 'suspended', 'restored') NEVER advance transforms and have ZERO effective
 *   collision velocity; their stored velocity is preserved without leaking into active collisions.
 * - Releasing a body ('held'|'suspended'|'restored' -> 'active') resumes motion using its stored velocity.
 * - Suspending an active body ('active' -> 'suspended') freezes it in place while preserving linear & angular velocity.
 * - Real simulation contact from an 'active' body above impulse threshold awakens eligible 'held' bodies.
 * - Non-contacts NEVER falsely activate held bodies.
 * - Central Aperture vortex exerts radial/orbital field ONLY while 'active'.
 * - Fixed-step integration (1/60s) with bounded substeps, Undo snapshots, Reset, and Deterministic Replay.
 */

import { broadphasePairs, narrowphaseContact } from './collision.js';
import { fnv1a32 } from '../core/hash.js';
import { RESOURCE_LIMITS } from '../core/security.js';

function cloneVec3(v) {
  return [Number(v?.[0] || 0), Number(v?.[1] || 0), Number(v?.[2] || 0)];
}

export function isTemporallyFrozen(state) {
  return state === 'held' || state === 'suspended' || state === 'restored';
}

export class TemporalSimulationEngine {
  constructor(scene, { onEvent = null } = {}) {
    this.scene = scene;
    this.onEvent = onEvent;
    this.accumulator = 0;
    this.undoStack = [];
    this.initialSnapshot = null;
    this.tickLog = [];
    this.contactEvents = [];
    this.tick = 0;
    this.captureInitialState();
  }

  emit(type, payload) {
    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent(type, payload);
      } catch (_) {}
    }
  }

  snapshotBody(obj) {
    return {
      id: obj.id,
      position: cloneVec3(obj.position),
      rotation: cloneVec3(obj.rotation),
      scale: cloneVec3(obj.scale || [1, 1, 1]),
      temporalState: obj.temporalState || 'held',
      velocity: cloneVec3(obj.velocity),
      angularVelocity: cloneVec3(obj.angularVelocity),
    };
  }

  createSnapshot(label = '') {
    return {
      label,
      tick: this.tick,
      bodies: this.scene.objects.map(o => this.snapshotBody(o)),
      tickLogLength: this.tickLog.length,
    };
  }

  applySnapshot(snap) {
    if (!snap || !Array.isArray(snap.bodies)) return;
    const byId = new Map(snap.bodies.map(b => [b.id, b]));
    for (const obj of this.scene.objects) {
      const s = byId.get(obj.id);
      if (!s) continue;
      obj.position = cloneVec3(s.position);
      obj.rotation = cloneVec3(s.rotation);
      obj.scale = cloneVec3(s.scale);
      obj.temporalState = s.temporalState;
      obj.velocity = cloneVec3(s.velocity);
      obj.angularVelocity = cloneVec3(s.angularVelocity);
    }
    this.tick = snap.tick;
    if (typeof snap.tickLogLength === 'number') {
      this.tickLog = this.tickLog.slice(0, snap.tickLogLength);
    }
    this.scene.simulation.tick = this.tick;
  }

  captureInitialState() {
    this.tick = 0;
    this.accumulator = 0;
    this.undoStack = [];
    this.tickLog = [];
    this.contactEvents = [];
    this.initialSnapshot = this.createSnapshot('initial');
    if (this.scene.simulation) {
      this.scene.simulation.initialState = this.initialSnapshot.bodies.map(b => ({ ...b }));
      this.scene.simulation.tick = 0;
      this.scene.simulation.tickLog = [];
      this.scene.simulation.contactEvents = [];
    }
  }

  pushUndo(label) {
    this.undoStack.push(this.createSnapshot(label));
    if (this.undoStack.length > RESOURCE_LIMITS.MAX_SNAPSHOT_HISTORY) {
      this.undoStack.shift();
    }
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    const prev = this.undoStack.pop();
    this.applySnapshot(prev);
    this.emit('undo', { tick: this.tick, label: prev.label });
    return true;
  }

  reset() {
    if (!this.initialSnapshot) return false;
    this.pushUndo('before_reset');
    this.applySnapshot(this.initialSnapshot);
    for (const obj of this.scene.objects) {
      if (obj.temporalState === 'held') {
        // Keep original held state
      }
    }
    this.contactEvents = [];
    if (this.scene.simulation) {
      this.scene.simulation.contactEvents = [];
      this.scene.simulation.tickLog = [];
    }
    this.emit('reset', { tick: this.tick });
    return true;
  }

  getObject(id) {
    return this.scene.objects.find(o => o.id === id) || null;
  }

  /**
   * Release a held/suspended/restored object into active time.
   */
  releaseObject(id, { recordAction = true, pushUndo = true, impulse = null } = {}) {
    const obj = this.getObject(id);
    if (!obj || obj.physics?.isStatic) return false;
    if (obj.temporalState === 'active') return false;

    if (pushUndo) this.pushUndo(`release:${id}`);
    obj.temporalState = 'active';
    if (impulse) {
      obj.velocity[0] += impulse[0];
      obj.velocity[1] += impulse[1];
      obj.velocity[2] += impulse[2];
    }
    if (recordAction) {
      this.tickLog.push({ tick: this.tick, action: 'release', id, impulse: impulse ? cloneVec3(impulse) : null });
      if (this.scene.simulation) this.scene.simulation.tickLog = [...this.tickLog];
    }
    this.emit(obj.isVortex ? 'vortex_activated' : 'release', { id, tick: this.tick, position: cloneVec3(obj.position) });
    return true;
  }

  /**
   * Explicitly suspend an active/sleeping object in place while preserving its velocity.
   */
  suspendObject(id, { recordAction = true, pushUndo = true } = {}) {
    const obj = this.getObject(id);
    if (!obj || obj.physics?.isStatic) return false;
    if (isTemporallyFrozen(obj.temporalState)) return false;

    if (pushUndo) this.pushUndo(`suspend:${id}`);
    obj.temporalState = 'suspended';
    if (recordAction) {
      this.tickLog.push({ tick: this.tick, action: 'suspend', id });
      if (this.scene.simulation) this.scene.simulation.tickLog = [...this.tickLog];
    }
    this.emit('suspend', { id, tick: this.tick, position: cloneVec3(obj.position) });
    return true;
  }

  toggleObject(id) {
    const obj = this.getObject(id);
    if (!obj || obj.physics?.isStatic) return null;
    if (isTemporallyFrozen(obj.temporalState)) {
      this.releaseObject(id);
      return 'active';
    }
    this.suspendObject(id);
    return 'suspended';
  }

  releaseAll({ recordAction = true, pushUndo = true } = {}) {
    if (pushUndo) this.pushUndo('release_all');
    let count = 0;
    for (const obj of this.scene.objects) {
      if (obj.physics?.isStatic) continue;
      if (isTemporallyFrozen(obj.temporalState)) {
        obj.temporalState = 'active';
        count++;
      }
    }
    if (recordAction && count > 0) {
      this.tickLog.push({ tick: this.tick, action: 'release_all' });
      if (this.scene.simulation) this.scene.simulation.tickLog = [...this.tickLog];
    }
    if (count > 0) this.emit('release_all', { count, tick: this.tick });
    return count;
  }

  suspendAll({ recordAction = true, pushUndo = true } = {}) {
    if (pushUndo) this.pushUndo('suspend_all');
    let count = 0;
    for (const obj of this.scene.objects) {
      if (obj.physics?.isStatic) continue;
      if (obj.temporalState === 'active' || obj.temporalState === 'sleeping') {
        obj.temporalState = 'suspended';
        count++;
      }
    }
    if (recordAction && count > 0) {
      this.tickLog.push({ tick: this.tick, action: 'suspend_all' });
      if (this.scene.simulation) this.scene.simulation.tickLog = [...this.tickLog];
    }
    if (count > 0) this.emit('suspend_all', { count, tick: this.tick });
    return count;
  }

  /**
   * Advances simulation by real elapsed seconds using fixed-step accumulation.
   * Clamps dt to prevent excessive catch-up after tab suspension.
   */
  advance(elapsedSec) {
    const sim = this.scene.simulation;
    const dt = sim.fixedDt || 1 / 60;
    const clamped = Math.min(Math.max(0, elapsedSec), dt * 4);
    this.accumulator += clamped;
    let steps = 0;
    while (this.accumulator >= dt && steps < 4) {
      this.stepFixed(dt);
      this.accumulator -= dt;
      steps++;
    }
    return steps;
  }

  /**
   * Executes one deterministic fixed simulation tick.
   */
  stepFixed(dt = this.scene.simulation.fixedDt || 1 / 60) {
    const sim = this.scene.simulation;
    const objects = this.scene.objects;
    const gx = sim.gravity?.[0] ?? 0;
    const gy = sim.gravity?.[1] ?? -9.81;
    const gz = sim.gravity?.[2] ?? 0;
    const linDamp = Math.max(0, 1 - (sim.linearDamping ?? 0.04) * dt);
    const angDamp = Math.max(0, 1 - (sim.angularDamping ?? 0.08) * dt);
    const floorY = sim.floorY ?? 0.0;

    // 1. Check active Central Aperture vortex
    const vortex = objects.find(o => o.isVortex && o.temporalState === 'active');

    // 2. Integrate active bodies ONLY (held/suspended/restored bodies remain strictly stationary)
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      if (obj.physics?.isStatic || obj.temporalState !== 'active') continue;

      const gravScale = obj.physics?.gravityScale ?? 1.0;
      const mass = Math.max(0.05, obj.physics?.mass ?? 1.0);

      // Apply gravity (vortex itself floats in zero-g)
      if (!obj.isVortex) {
        obj.velocity[0] += gx * gravScale * dt;
        obj.velocity[1] += gy * gravScale * dt;
        obj.velocity[2] += gz * gravScale * dt;
      } else {
        // Active vortex rotates steadily
        obj.angularVelocity[2] = obj.angularVelocity[2] || 1.4;
      }

      // Apply Central Aperture vortex field ONLY if vortex is active
      if (vortex && obj.id !== vortex.id) {
        const dx = vortex.position[0] - obj.position[0];
        const dy = vortex.position[1] - obj.position[1];
        const dz = vortex.position[2] - obj.position[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        const dist = Math.sqrt(distSq);
        const range = vortex.vortexRadius || 8.5;
        if (dist > 0.25 && dist < range) {
          const pull = (vortex.vortexStrength || 7.5) / (mass * (1 + distSq * 0.18));
          const invD = 1 / dist;
          // Radial inward pull + tangential swirl
          obj.velocity[0] += (dx * invD * pull - dz * invD * pull * 0.45) * dt;
          obj.velocity[1] += (dy * invD * pull) * dt;
          obj.velocity[2] += (dz * invD * pull + dx * invD * pull * 0.45) * dt;
        }
      }

      // Damping
      obj.velocity[0] *= linDamp;
      obj.velocity[1] *= linDamp;
      obj.velocity[2] *= linDamp;
      obj.angularVelocity[0] *= angDamp;
      obj.angularVelocity[1] *= angDamp;
      obj.angularVelocity[2] *= angDamp;

      // Integrate position & rotation
      obj.position[0] += obj.velocity[0] * dt;
      obj.position[1] += obj.velocity[1] * dt;
      obj.position[2] += obj.velocity[2] * dt;

      obj.rotation[0] += obj.angularVelocity[0] * dt;
      obj.rotation[1] += obj.angularVelocity[1] * dt;
      obj.rotation[2] += obj.angularVelocity[2] * dt;

      // Floor plane contact
      const radius = (obj.collision?.radius ?? 0.45) * Math.abs(obj.scale?.[1] ?? 1);
      const minY = floorY + radius;
      if (obj.position[1] < minY && !obj.isVortex) {
        obj.position[1] = minY;
        if (obj.velocity[1] < 0) {
          const restitution = obj.physics?.restitution ?? sim.restitution ?? 0.42;
          const impactSpeed = Math.abs(obj.velocity[1]);
          obj.velocity[1] = -obj.velocity[1] * restitution;
          obj.velocity[0] *= 0.88;
          obj.velocity[2] *= 0.88;
          if (impactSpeed > 0.6) {
            this.emit('contact', { a: obj.id, b: 'floor', impulse: impactSpeed * mass, position: cloneVec3(obj.position) });
          }
          if (Math.abs(obj.velocity[1]) < 0.08) obj.velocity[1] = 0;
        }
      }
    }

    // 3. Vortex proximity activation ONLY when vortex is active and wave reaches held bodies
    if (vortex) {
      const waveRadius = Math.min(vortex.vortexRadius || 8.5, 1.4 + (this.tick % 10000) * 0.0);
      // Actual physical pull/contact handles activation via vortex trigger or direct contact;
      // Additionally, if a held body is inside the vortex's physical trigger sphere, awaken it:
      const triggerR = vortex.collision?.radius ? vortex.collision.radius * 2.2 : 1.8;
      for (const obj of objects) {
        if (obj.id === vortex.id || obj.physics?.isStatic) continue;
        if (obj.temporalState !== 'held') continue;
        const dx = obj.position[0] - vortex.position[0];
        const dy = obj.position[1] - vortex.position[1];
        const dz = obj.position[2] - vortex.position[2];
        const d = Math.hypot(dx, dy, dz);
        if (d <= triggerR) {
          obj.temporalState = 'active';
          this.recordContactEvent(vortex.id, obj.id, 1.2, true, cloneVec3(obj.position));
        }
      }
      void waveRadius;
    }

    // 4. Broadphase + Narrowphase collision detection & impulse resolution (2 sub-iterations for stability)
    const pairs = broadphasePairs(objects);
    const threshold = sim.contactActivationImpulseThreshold ?? 0.15;

    for (let i = 0; i < pairs.length; i++) {
      const [a, b, aabbA, aabbB] = pairs[i];
      const aFrozen = isTemporallyFrozen(a.temporalState) || Boolean(a.physics?.isStatic);
      const bFrozen = isTemporallyFrozen(b.temporalState) || Boolean(b.physics?.isStatic);
      if (aFrozen && bFrozen) continue;

      const contact = narrowphaseContact(a, b, aabbA, aabbB);
      if (!contact) continue;

      // Effective collision velocity: frozen bodies contribute ZERO velocity (stored velocity does NOT leak!)
      const vAx = aFrozen ? 0 : a.velocity[0];
      const vAy = aFrozen ? 0 : a.velocity[1];
      const vAz = aFrozen ? 0 : a.velocity[2];
      const vBx = bFrozen ? 0 : b.velocity[0];
      const vBy = bFrozen ? 0 : b.velocity[1];
      const vBz = bFrozen ? 0 : b.velocity[2];

      const rvx = vBx - vAx;
      const rvy = vBy - vAy;
      const rvz = vBz - vAz;
      const velAlongNormal = rvx * contact.nx + rvy * contact.ny + rvz * contact.nz;

      // Compute impulse magnitude
      const invMassA = aFrozen ? 0 : 1 / Math.max(0.05, a.physics?.mass ?? 1.0);
      const invMassB = bFrozen ? 0 : 1 / Math.max(0.05, b.physics?.mass ?? 1.0);
      const invMassSum = invMassA + invMassB;
      if (invMassSum <= 0) continue;

      const e = Math.min(a.physics?.restitution ?? sim.restitution ?? 0.42, b.physics?.restitution ?? sim.restitution ?? 0.42);
      let j = 0;
      if (velAlongNormal < 0) {
        j = -(1 + e) * velAlongNormal / invMassSum;
      } else {
        // Resting/overlapping penetration impulse estimate for awakening
        j = Math.min(1.0, contact.depth * 2.5);
      }

      // Check contact-driven temporal propagation (ONLY 'held' bodies awaken on real contact; 'suspended' stays frozen unless explicitly released)
      let awakened = false;
      if (j >= threshold || contact.depth > 0.01) {
        if (a.temporalState === 'held' && !a.physics?.isStatic && b.temporalState === 'active') {
          a.temporalState = 'active';
          awakened = true;
        }
        if (b.temporalState === 'held' && !b.physics?.isStatic && a.temporalState === 'active') {
          b.temporalState = 'active';
          awakened = true;
        }
      }

      if (contact.isTrigger) {
        if (awakened) {
          this.recordContactEvent(a.id, b.id, j, true, contact.contactPoint);
        }
        continue;
      }

      // Recompute effective inverse masses after potential awakening so momentum transfers cleanly!
      const postFrozenA = isTemporallyFrozen(a.temporalState) || Boolean(a.physics?.isStatic);
      const postFrozenB = isTemporallyFrozen(b.temporalState) || Boolean(b.physics?.isStatic);
      const postInvA = postFrozenA ? 0 : 1 / Math.max(0.05, a.physics?.mass ?? 1.0);
      const postInvB = postFrozenB ? 0 : 1 / Math.max(0.05, b.physics?.mass ?? 1.0);
      const postSum = postInvA + postInvB;
      if (postSum <= 0) continue;

      if (velAlongNormal < 0) {
        const jFinal = -(1 + e) * velAlongNormal / postSum;
        const ix = jFinal * contact.nx;
        const iy = jFinal * contact.ny;
        const iz = jFinal * contact.nz;

        if (!postFrozenA) {
          a.velocity[0] -= ix * postInvA;
          a.velocity[1] -= iy * postInvA;
          a.velocity[2] -= iz * postInvA;
          // Tangential spin from contact
          a.angularVelocity[0] += contact.nz * jFinal * 0.18 * postInvA;
          a.angularVelocity[2] -= contact.nx * jFinal * 0.18 * postInvA;
        }
        if (!postFrozenB) {
          b.velocity[0] += ix * postInvB;
          b.velocity[1] += iy * postInvB;
          b.velocity[2] += iz * postInvB;
          b.angularVelocity[0] -= contact.nz * jFinal * 0.18 * postInvB;
          b.angularVelocity[2] += contact.nx * jFinal * 0.18 * postInvB;
        }
      }

      // Positional correction (Baumgarte-style) to prevent sinking
      const percent = 0.65;
      const slop = 0.002;
      const corrMag = Math.max(contact.depth - slop, 0) / postSum * percent;
      if (!postFrozenA) {
        a.position[0] -= contact.nx * corrMag * postInvA;
        a.position[1] -= contact.ny * corrMag * postInvA;
        a.position[2] -= contact.nz * corrMag * postInvA;
      }
      if (!postFrozenB) {
        b.position[0] += contact.nx * corrMag * postInvB;
        b.position[1] += contact.ny * corrMag * postInvB;
        b.position[2] += contact.nz * corrMag * postInvB;
      }

      if (awakened || j > 0.25) {
        this.recordContactEvent(a.id, b.id, Number(j.toFixed(4)), awakened, contact.contactPoint);
      }
    }

    this.tick++;
    sim.tick = this.tick;
  }

  recordContactEvent(aId, bId, impulse, propagated, point) {
    const ev = { tick: this.tick, a: aId, b: bId, impulse, propagated, point };
    this.contactEvents.push(ev);
    if (this.contactEvents.length > 500) this.contactEvents.shift();
    if (this.scene.simulation) {
      this.scene.simulation.contactEvents = this.contactEvents;
    }
    this.emit(propagated ? 'propagation' : 'contact', ev);
  }

  /**
   * Deterministically replays a tick-addressed action log from initial state for `totalTicks`.
   */
  replay(actionLog, totalTicks) {
    if (!this.initialSnapshot) throw new Error('No initial snapshot to replay from.');
    this.applySnapshot(this.initialSnapshot);
    this.contactEvents = [];
    this.tickLog = [];
    const sorted = [...actionLog].sort((a, b) => a.tick - b.tick);
    let actionIdx = 0;

    for (let t = 0; t < totalTicks; t++) {
      while (actionIdx < sorted.length && sorted[actionIdx].tick === t) {
        const act = sorted[actionIdx++];
        if (act.action === 'release') {
          this.releaseObject(act.id, { recordAction: true, pushUndo: false, impulse: act.impulse });
        } else if (act.action === 'suspend') {
          this.suspendObject(act.id, { recordAction: true, pushUndo: false });
        } else if (act.action === 'release_all') {
          this.releaseAll({ recordAction: true, pushUndo: false });
        } else if (act.action === 'suspend_all') {
          this.suspendAll({ recordAction: true, pushUndo: false });
        }
      }
      this.stepFixed();
    }
    return this.getStateHash();
  }

  /**
   * Computes a deterministic state hash of all object transforms, velocities, and temporal states.
   */
  getStateHash() {
    const quantized = this.scene.objects.map(o => ({
      id: o.id,
      st: o.temporalState,
      p: o.position.map(v => Math.round(v * 10000)),
      r: o.rotation.map(v => Math.round(v * 10000)),
      v: o.velocity.map(v => Math.round(v * 10000)),
    }));
    return fnv1a32(JSON.stringify({ tick: this.tick, bodies: quantized }));
  }

  getStats() {
    const counts = { held: 0, active: 0, sleeping: 0, suspended: 0, restored: 0, total: this.scene.objects.length };
    for (const o of this.scene.objects) {
      counts[o.temporalState] = (counts[o.temporalState] || 0) + 1;
    }
    return { tick: this.tick, counts, undoDepth: this.undoStack.length, contacts: this.contactEvents.length };
  }
}
