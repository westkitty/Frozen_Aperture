/**
 * Frozen Aperture — Broadphase & Narrowphase Collision Engine
 * Supports sphere, box, capsule, and trigger collision representations with
 * deterministic pair ordering and frozen-body effective-velocity isolation.
 */

export function getBodyAabb(body) {
  const [x, y, z] = body.position;
  const col = body.collision || { shape: 'sphere', radius: 0.45 };
  let hx = col.radius || 0.45;
  let hy = col.radius || 0.45;
  let hz = col.radius || 0.45;

  if (col.shape === 'box' && Array.isArray(col.halfExtents)) {
    [hx, hy, hz] = col.halfExtents;
  } else if (col.shape === 'capsule') {
    const r = col.radius || 0.35;
    const hh = (col.halfHeight || 0.5) + r;
    hx = r;
    hy = hh;
    hz = r;
  }

  // Apply object scale conservatively
  const sx = Math.abs(body.scale?.[0] ?? 1);
  const sy = Math.abs(body.scale?.[1] ?? 1);
  const sz = Math.abs(body.scale?.[2] ?? 1);
  hx *= sx;
  hy *= sy;
  hz *= sz;

  return {
    minX: x - hx, maxX: x + hx,
    minY: y - hy, maxY: y + hy,
    minZ: z - hz, maxZ: z + hz,
    hx, hy, hz,
    boundingRadius: Math.max(hx, hy, hz),
  };
}

/**
 * Spatial hash broadphase returning deterministically sorted candidate pairs [bodyA, bodyB].
 * Eliminates O(N^2) all-pairs checks and eliminates pair-order dependence.
 */
export function broadphasePairs(bodies, cellSize = 2.0) {
  const grid = new Map();
  const aabbs = new Map();

  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.visible === false || b.collision?.enabled === false) continue;
    const aabb = getBodyAabb(b);
    aabbs.set(b.id, aabb);

    const x0 = Math.floor(aabb.minX / cellSize);
    const x1 = Math.floor(aabb.maxX / cellSize);
    const y0 = Math.floor(aabb.minY / cellSize);
    const y1 = Math.floor(aabb.maxY / cellSize);
    const z0 = Math.floor(aabb.minZ / cellSize);
    const z1 = Math.floor(aabb.maxZ / cellSize);

    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = `${cx},${cy},${cz}`;
          let cell = grid.get(key);
          if (!cell) {
            cell = [];
            grid.set(key, cell);
          }
          cell.push(b);
        }
      }
    }
  }

  const pairMap = new Map();
  for (const cell of grid.values()) {
    if (cell.length < 2) continue;
    for (let i = 0; i < cell.length; i++) {
      for (let j = i + 1; j < cell.length; j++) {
        const b1 = cell[i];
        const b2 = cell[j];
        // Deterministic ordering by stable ID
        const [a, b] = b1.id < b2.id ? [b1, b2] : [b2, b1];
        const pairKey = `${a.id}|${b.id}`;
        if (pairMap.has(pairKey)) continue;

        const aa = aabbs.get(a.id);
        const ab = aabbs.get(b.id);
        if (
          aa.maxX >= ab.minX && aa.minX <= ab.maxX &&
          aa.maxY >= ab.minY && aa.minY <= ab.maxY &&
          aa.maxZ >= ab.minZ && aa.minZ <= ab.maxZ
        ) {
          pairMap.set(pairKey, [a, b, aa, ab]);
        }
      }
    }
  }

  // Sort pair keys lexicographically for strict cross-run determinism
  return Array.from(pairMap.entries())
    .sort((e1, e2) => (e1[0] < e2[0] ? -1 : e1[0] > e2[0] ? 1 : 0))
    .map(e => e[1]);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Narrowphase contact test between two bodies (sphere, box, capsule, trigger).
 * Returns null or { nx, ny, nz, depth, contactPoint: [x,y,z], isTrigger }.
 */
export function narrowphaseContact(a, b, aabbA, aabbB) {
  const shapeA = a.collision?.shape || 'sphere';
  const shapeB = b.collision?.shape || 'sphere';
  const isTrigger = shapeA === 'trigger' || shapeB === 'trigger';

  // Box-Box AABB narrowphase
  if (shapeA === 'box' && shapeB === 'box') {
    const ox = Math.min(aabbA.maxX, aabbB.maxX) - Math.max(aabbA.minX, aabbB.minX);
    const oy = Math.min(aabbA.maxY, aabbB.maxY) - Math.max(aabbA.minY, aabbB.minY);
    const oz = Math.min(aabbA.maxZ, aabbB.maxZ) - Math.max(aabbA.minZ, aabbB.minZ);
    if (ox <= 0 || oy <= 0 || oz <= 0) return null;
    let nx = 0, ny = 0, nz = 0, depth = ox;
    if (ox <= oy && ox <= oz) {
      nx = b.position[0] >= a.position[0] ? 1 : -1;
      depth = ox;
    } else if (oy <= ox && oy <= oz) {
      ny = b.position[1] >= a.position[1] ? 1 : -1;
      depth = oy;
    } else {
      nz = b.position[2] >= a.position[2] ? 1 : -1;
      depth = oz;
    }
    return {
      nx, ny, nz, depth, isTrigger,
      contactPoint: [
        (a.position[0] + b.position[0]) * 0.5,
        (a.position[1] + b.position[1]) * 0.5,
        (a.position[2] + b.position[2]) * 0.5,
      ],
    };
  }

  // Sphere-Box narrowphase
  if ((shapeA === 'sphere' && shapeB === 'box') || (shapeA === 'box' && shapeB === 'sphere')) {
    const sph = shapeA === 'sphere' ? a : b;
    const box = shapeA === 'box' ? a : b;
    const sphAabb = shapeA === 'sphere' ? aabbA : aabbB;
    const boxAabb = shapeA === 'box' ? aabbA : aabbB;
    const r = sphAabb.boundingRadius;

    const cx = clamp(sph.position[0], boxAabb.minX, boxAabb.maxX);
    const cy = clamp(sph.position[1], boxAabb.minY, boxAabb.maxY);
    const cz = clamp(sph.position[2], boxAabb.minZ, boxAabb.maxZ);

    let dx = sph.position[0] - cx;
    let dy = sph.position[1] - cy;
    let dz = sph.position[2] - cz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= r * r) return null;

    const dist = Math.sqrt(distSq);
    let nx = dist > 1e-6 ? dx / dist : 0;
    let ny = dist > 1e-6 ? dy / dist : 1;
    let nz = dist > 1e-6 ? dz / dist : 0;
    // Normal points from A to B
    if (shapeA === 'sphere') {
      nx = -nx; ny = -ny; nz = -nz;
    }
    return {
      nx, ny, nz,
      depth: Math.max(0.0001, r - dist),
      isTrigger,
      contactPoint: [cx, cy, cz],
    };
  }

  // Capsule-Sphere / Capsule-Capsule (vertical segment closest point)
  if (shapeA === 'capsule' || shapeB === 'capsule') {
    const halfH = (body) => {
      if (body.collision?.shape !== 'capsule') return 0;
      return (body.collision.halfHeight || 0.5) * Math.abs(body.scale?.[1] ?? 1);
    };
    const rad = (body, aabb) => {
      if (body.collision?.shape === 'capsule') {
        return (body.collision.radius || 0.35) * Math.max(Math.abs(body.scale?.[0] ?? 1), Math.abs(body.scale?.[2] ?? 1));
      }
      return aabb.boundingRadius;
    };

    const hA = halfH(a);
    const hB = halfH(b);
    const yA = clamp(b.position[1], a.position[1] - hA, a.position[1] + hA);
    const yB = clamp(a.position[1], b.position[1] - hB, b.position[1] + hB);

    const dx = b.position[0] - a.position[0];
    const dy = yB - yA;
    const dz = b.position[2] - a.position[2];
    const rSum = rad(a, aabbA) + rad(b, aabbB);
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= rSum * rSum) return null;

    const dist = Math.sqrt(distSq);
    const nx = dist > 1e-6 ? dx / dist : 0;
    const ny = dist > 1e-6 ? dy / dist : 1;
    const nz = dist > 1e-6 ? dz / dist : 0;
    return {
      nx, ny, nz,
      depth: Math.max(0.0001, rSum - dist),
      isTrigger,
      contactPoint: [
        a.position[0] + nx * rad(a, aabbA),
        (yA + yB) * 0.5,
        a.position[2] + nz * rad(a, aabbA),
      ],
    };
  }

  // Default: Sphere-Sphere narrowphase
  const dx = b.position[0] - a.position[0];
  const dy = b.position[1] - a.position[1];
  const dz = b.position[2] - a.position[2];
  const rSum = aabbA.boundingRadius + aabbB.boundingRadius;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= rSum * rSum) return null;

  const dist = Math.sqrt(distSq);
  const nx = dist > 1e-6 ? dx / dist : 0;
  const ny = dist > 1e-6 ? dy / dist : 1;
  const nz = dist > 1e-6 ? dz / dist : 0;
  return {
    nx, ny, nz,
    depth: Math.max(0.0001, rSum - dist),
    isTrigger,
    contactPoint: [
      a.position[0] + nx * aabbA.boundingRadius,
      a.position[1] + ny * aabbA.boundingRadius,
      a.position[2] + nz * aabbA.boundingRadius,
    ],
  };
}
