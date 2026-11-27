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

import { broadphasePairs, narrowphaseContact, computeSweptSphereTOI, getBodyAabb } from './collision.js';
import { fnv1a32 } from '../core/hash.js';
import { RESOURCE_LIMITS } from '../core/security.js';

function cloneVec3(v) {
  return [Number(v?.[0] || 0), Number(v?.[1] || 0), Number(v?.[2] || 0)];
}

export function isTemporallyFrozen(state) {
  return state === 'held' || state === 'suspended' || state === 'restored';
}

function estimateInertia(obj) {
  const m = Math.max(0.05, obj.physics?.mass ?? 1.0);
  const r = obj.collision?.radius ?? obj.collision?.halfExtents?.[0] ?? 0.45;
  return Math.max(0.02, 0.4 * m * r * r);
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
    /** (#18) Previous fixed-tick transforms for smooth render interpolation */
    this.prevTransforms = new Map();
    /** (#14) Per-body low-velocity sleep counters */
    this.sleepCounters = new Map();
    this.captureInitialState();
  }

  getInterpolationAlpha() {
    const dt = this.scene?.simulation?.fixedDt || 1 / 60;
    return Math.max(0, Math.min(1, this.accumulator / dt));
  }

  getInterpolatedTransform(obj) {
    const prev = this.prevTransforms.get(obj.id);
    if (!prev || isTemporallyFrozen(obj.temporalState) || obj.temporalState === 'sleeping') {
      return { position: obj.position, rotation: obj.rotation };
    }
    const a = this.getInterpolationAlpha();
    return {
      position: [
        prev.position[0] + (obj.position[0] - prev.position[0]) * a,
        prev.position[1] + (obj.position[1] - prev.position[1]) * a,
        prev.position[2] + (obj.position[2] - prev.position[2]) * a,
      ],
      rotation: [
        prev.rotation[0] + (obj.rotation[0] - prev.rotation[0]) * a,
        prev.rotation[1] + (obj.rotation[1] - prev.rotation[1]) * a,
        prev.rotation[2] + (obj.rotation[2] - prev.rotation[2]) * a,
      ],
    };
  }

  recordPrevTransforms() {
    for (const obj of this.scene.objects) {
      this.prevTransforms.set(obj.id, {
        position: cloneVec3(obj.position),
        rotation: cloneVec3(obj.rotation),
      });
    }
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
      this.sleepCounters.set(obj.id, 0);
    }
    this.tick = snap.tick;
    if (typeof snap.tickLogLength === 'number') {
      this.tickLog = this.tickLog.slice(0, snap.tickLogLength);
    }
    this.scene.simulation.tick = this.tick;
    this.recordPrevTransforms();
  }

  captureInitialState() {
    this.tick = 0;
    this.accumulator = 0;
    this.undoStack = [];
    this.tickLog = [];
    this.contactEvents = [];
    this.sleepCounters.clear();
    this.initialSnapshot = this.createSnapshot('initial');
    this.recordPrevTransforms();
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

  releaseObject(id, { recordAction = true, pushUndo = true, impulse = null } = {}) {
    const obj = this.getObject(id);
    if (!obj || obj.physics?.isStatic) return false;
    if (obj.temporalState === 'active') return false;

    if (pushUndo) this.pushUndo(`release:${id}`);
    obj.temporalState = 'active';
    this.sleepCounters.set(id, 0);
    if (impulse) {
      obj.velocity[0] += impulse[0];
      obj.velocity[1] += impulse[1];
      obj.velocity[2] += impulse[2];
    }
    if (recordAction) {
      this.tickLog.push({ tick: this.tick, action: 'release', id, impulse: impulse ? cloneVec3(impulse) : null });
      if (this.scene.simulation) this.scene.simulation.tickLog = [...this.tickLog];
    }
    this.emit(obj.isVortex ? 'vortex_activated' : 'release', { id, tick: this.tick, position: cloneVec3(obj.position), mass: obj.physics?.mass ?? 1 });
    return true;
  }

  suspendObject(id, { recordAction = true, pushUndo = true } = {}) {
    const obj = this.getObject(id);
    if (!obj || obj.physics?.isStatic) return false;
    if (isTemporallyFrozen(obj.temporalState)) return false;

    if (pushUndo) this.pushUndo(`suspend:${id}`);
    obj.temporalState = 'suspended';
    this.sleepCounters.set(id, 0);
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
    if (isTemporallyFrozen(obj.temporalState) || obj.temporalState === 'sleeping') {
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
      if (isTemporallyFrozen(obj.temporalState) || obj.temporalState === 'sleeping') {
        obj.temporalState = 'active';
        this.sleepCounters.set(obj.id, 0);
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
        this.sleepCounters.set(obj.id, 0);
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

  stepFixed(dt = this.scene.simulation.fixedDt || 1 / 60) {
    this.recordPrevTransforms();
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

    // (#11) Detect if any active body is fast enough to require swept CCD substepping
    let substeps = 1;
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      if (obj.physics?.isStatic || obj.temporalState !== 'active' || obj.isVortex) continue;
      const speed = Math.hypot(obj.velocity[0], obj.velocity[1], obj.velocity[2]);
      const r = getBodyAabb(obj).boundingRadius;
      if (speed * dt > r * 0.65) {
        // Check swept TOI against all other bodies
        for (let j = 0; j < objects.length; j++) {
          if (i === j) continue;
          const other = objects[j];
          if (other.visible === false || other.collision?.enabled === false) continue;
          const otherFrozen = isTemporallyFrozen(other.temporalState) || other.temporalState === 'sleeping';
          const toi = computeSweptSphereTOI(
            obj.position, obj.velocity, r,
            other.position, otherFrozen ? [0, 0, 0] : other.velocity, getBodyAabb(other).boundingRadius,
            dt
          );
          if (toi !== null) {
            substeps = Math.max(substeps, Math.min(8, Math.ceil((speed * dt) / Math.max(0.05, r * 0.5))));
            break;
          }
        }
      }
    }

    const subDt = dt / substeps;
    for (let s = 0; s < substeps; s++) {
      this.stepSubtick(subDt, sim, objects, vortex, gx, gy, gz, linDamp, angDamp, floorY);
    }

    // (#14) Velocity-based sleeping for settled active bodies (never sleeps vortex or bodies in mid-air)
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      if (obj.temporalState !== 'active' || obj.isVortex || obj.physics?.isStatic || vortex) continue;
      const r = (obj.collision?.radius ?? 0.45) * Math.abs(obj.scale?.[1] ?? 1);
      const nearFloor = obj.position[1] <= floorY + r + 0.03;
      const linSpeed = Math.hypot(obj.velocity[0], obj.velocity[1], obj.velocity[2]);
      const angSpeed = Math.hypot(obj.angularVelocity[0], obj.angularVelocity[1], obj.angularVelocity[2]);
      if (nearFloor && linSpeed < 0.05 && angSpeed < 0.08) {
        const cnt = (this.sleepCounters.get(obj.id) || 0) + 1;
        this.sleepCounters.set(obj.id, cnt);
        if (cnt >= 45) {
          obj.temporalState = 'sleeping';
          obj.velocity = [0, 0, 0];
          obj.angularVelocity = [0, 0, 0];
        }
      } else {
        this.sleepCounters.set(obj.id, 0);
      }
    }

    this.tick++;
    sim.tick = this.tick;
  }

  stepSubtick(dt, sim, objects, vortex, gx, gy, gz, linDamp, angDamp, floorY) {
    // 2. Integrate active bodies ONLY (held/suspended/restored/sleeping bodies remain stationary)
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      if (obj.physics?.isStatic || obj.temporalState !== 'active') continue;

      const gravScale = obj.physics?.gravityScale ?? 1.0;
      const mass = Math.max(0.05, obj.physics?.mass ?? 1.0);

      if (!obj.isVortex) {
        obj.velocity[0] += gx * gravScale * dt;
        obj.velocity[1] += gy * gravScale * dt;
        obj.velocity[2] += gz * gravScale * dt;
      } else {
        obj.angularVelocity[2] = obj.angularVelocity[2] || 1.4;
      }

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
          obj.velocity[0] += (dx * invD * pull - dz * invD * pull * 0.45) * dt;
          obj.velocity[1] += (dy * invD * pull) * dt;
          obj.velocity[2] += (dz * invD * pull + dx * invD * pull * 0.45) * dt;
        }
      }

      obj.velocity[0] *= linDamp;
      obj.velocity[1] *= linDamp;
      obj.velocity[2] *= linDamp;
      obj.angularVelocity[0] *= angDamp;
      obj.angularVelocity[1] *= angDamp;
      obj.angularVelocity[2] *= angDamp;

      obj.position[0] += obj.velocity[0] * dt;
      obj.position[1] += obj.velocity[1] * dt;
      obj.position[2] += obj.velocity[2] * dt;

      obj.rotation[0] += obj.angularVelocity[0] * dt;
      obj.rotation[1] += obj.angularVelocity[1] * dt;
      obj.rotation[2] += obj.angularVelocity[2] * dt;

      // Floor plane contact with Coulomb friction (#14)
      const radius = (obj.collision?.radius ?? 0.45) * Math.abs(obj.scale?.[1] ?? 1);
      const minY = floorY + radius;
      if (obj.position[1] < minY && !obj.isVortex) {
        obj.position[1] = minY;
        if (obj.velocity[1] < 0) {
          const restitution = obj.physics?.restitution ?? sim.restitution ?? 0.42;
          const friction = obj.physics?.friction ?? 0.35;
          const impactSpeed = Math.abs(obj.velocity[1]);
          obj.velocity[1] = -obj.velocity[1] * restitution;
          obj.velocity[0] *= Math.max(0, 1 - friction * 0.35);
          obj.velocity[2] *= Math.max(0, 1 - friction * 0.35);
          if (impactSpeed > 0.6) {
            this.emit('contact', { a: obj.id, b: 'floor', impulse: impactSpeed * mass, mass, position: cloneVec3(obj.position) });
          }
          if (Math.abs(obj.velocity[1]) < 0.08) obj.velocity[1] = 0;
        }
      }
    }

    // 3. Vortex proximity activation ONLY when vortex is active
    if (vortex) {
      const triggerR = vortex.collision?.radius ? vortex.collision.radius * 2.2 : 1.8;
      for (const obj of objects) {
        if (obj.id === vortex.id || obj.physics?.isStatic) continue;
        if (obj.temporalState !== 'held' && obj.temporalState !== 'sleeping') continue;
        const d = Math.hypot(obj.position[0] - vortex.position[0], obj.position[1] - vortex.position[1], obj.position[2] - vortex.position[2]);
        if (d <= triggerR) {
          obj.temporalState = 'active';
          this.sleepCounters.set(obj.id, 0);
          this.recordContactEvent(vortex.id, obj.id, 1.2, true, cloneVec3(obj.position));
        }
      }
    }

    // 4. Broadphase + Narrowphase collision detection & impulse/torque/friction resolution (#14)
    const pairs = broadphasePairs(objects);
    const threshold = sim.contactActivationImpulseThreshold ?? 0.15;

    for (let i = 0; i < pairs.length; i++) {
      const [a, b, aabbA, aabbB] = pairs[i];
      const aFrozen = isTemporallyFrozen(a.temporalState) || Boolean(a.physics?.isStatic);
      const bFrozen = isTemporallyFrozen(b.temporalState) || Boolean(b.physics?.isStatic);
      if (aFrozen && bFrozen) continue;

      const contact = narrowphaseContact(a, b, aabbA, aabbB);
      if (!contact) continue;

      const vAx = (aFrozen || a.temporalState === 'sleeping') ? 0 : a.velocity[0];
      const vAy = (aFrozen || a.temporalState === 'sleeping') ? 0 : a.velocity[1];
      const vAz = (aFrozen || a.temporalState === 'sleeping') ? 0 : a.velocity[2];
      const vBx = (bFrozen || b.temporalState === 'sleeping') ? 0 : b.velocity[0];
      const vBy = (bFrozen || b.temporalState === 'sleeping') ? 0 : b.velocity[1];
      const vBz = (bFrozen || b.temporalState === 'sleeping') ? 0 : b.velocity[2];

      const rvx = vBx - vAx;
      const rvy = vBy - vAy;
      const rvz = vBz - vAz;
      const velAlongNormal = rvx * contact.nx + rvy * contact.ny + rvz * contact.nz;

      const invMassA = aFrozen ? 0 : 1 / Math.max(0.05, a.physics?.mass ?? 1.0);
      const invMassB = bFrozen ? 0 : 1 / Math.max(0.05, b.physics?.mass ?? 1.0);
      const invMassSum = invMassA + invMassB;
      if (invMassSum <= 0) continue;

      const e = Math.min(a.physics?.restitution ?? sim.restitution ?? 0.42, b.physics?.restitution ?? sim.restitution ?? 0.42);
      const j = velAlongNormal < 0 ? -(1 + e) * velAlongNormal / invMassSum : Math.min(1.0, contact.depth * 2.5);

      // Contact-driven temporal propagation & sleeping wake
      let awakened = false;
      if (j >= threshold || contact.depth > 0.01) {
        if ((a.temporalState === 'held' || a.temporalState === 'sleeping') && !a.physics?.isStatic && b.temporalState === 'active') {
          a.temporalState = 'active';
          this.sleepCounters.set(a.id, 0);
          awakened = true;
        }
        if ((b.temporalState === 'held' || b.temporalState === 'sleeping') && !b.physics?.isStatic && a.temporalState === 'active') {
          b.temporalState = 'active';
          this.sleepCounters.set(b.id, 0);
          awakened = true;
        }
      }

      if (contact.isTrigger) {
        if (awakened) this.recordContactEvent(a.id, b.id, j, true, contact.contactPoint);
        continue;
      }

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

        // (#14) Tangential Coulomb friction impulse
        const tx = rvx - velAlongNormal * contact.nx;
        const ty = rvy - velAlongNormal * contact.ny;
        const tz = rvz - velAlongNormal * contact.nz;
        const tLen = Math.hypot(tx, ty, tz);
        let fx = 0, fy = 0, fz = 0;
        if (tLen > 1e-5) {
          const mu = Math.sqrt((a.physics?.friction ?? 0.3) * (b.physics?.friction ?? 0.3));
          const jt = Math.min(mu * jFinal, tLen / postSum);
          fx = -(tx / tLen) * jt;
          fy = -(ty / tLen) * jt;
          fz = -(tz / tLen) * jt;
        }

        const totalIx = ix + fx;
        const totalIy = iy + fy;
        const totalIz = iz + fz;

        // (#14) Contact-point lever-arm torque (tau = r x J / I)
        const invIA = postFrozenA ? 0 : 1 / estimateInertia(a);
        const invIB = postFrozenB ? 0 : 1 / estimateInertia(b);

        if (!postFrozenA) {
          a.velocity[0] -= totalIx * postInvA;
          a.velocity[1] -= totalIy * postInvA;
          a.velocity[2] -= totalIz * postInvA;
          const rAx = contact.contactPoint[0] - a.position[0];
          const rAy = contact.contactPoint[1] - a.position[1];
          const rAz = contact.contactPoint[2] - a.position[2];
          a.angularVelocity[0] -= (rAy * totalIz - rAz * totalIy) * invIA;
          a.angularVelocity[1] -= (rAz * totalIx - rAx * totalIz) * invIA;
          a.angularVelocity[2] -= (rAx * totalIy - rAy * totalIx) * invIA;
        }
        if (!postFrozenB) {
          b.velocity[0] += totalIx * postInvB;
          b.velocity[1] += totalIy * postInvB;
          b.velocity[2] += totalIz * postInvB;
          const rBx = contact.contactPoint[0] - b.position[0];
          const rBy = contact.contactPoint[1] - b.position[1];
          const rBz = contact.contactPoint[2] - b.position[2];
          b.angularVelocity[0] += (rBy * totalIz - rBz * totalIy) * invIB;
          b.angularVelocity[1] += (rBz * totalIx - rBx * totalIz) * invIB;
          b.angularVelocity[2] += (rBx * totalIy - rBy * totalIx) * invIB;
        }
      }

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
