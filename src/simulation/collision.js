/**
 * Frozen Aperture — Broadphase, Narrowphase (OBB SAT, Compound, Capsule, Sphere)
 * and Swept Continuous Collision Detection (CCD) Engine (#11, #12).
 */

function eulerToAxes(rot = [0, 0, 0]) {
  const cx = Math.cos(rot[0] || 0), sx = Math.sin(rot[0] || 0);
  const cy = Math.cos(rot[1] || 0), sy = Math.sin(rot[1] || 0);
  const cz = Math.cos(rot[2] || 0), sz = Math.sin(rot[2] || 0);
  // XYZ rotation matrix columns as unit local axes
  return [
    [cy * cz, cx * sz + sx * sy * cz, sx * sz - cx * sy * cz],
    [-cy * sz, cx * cz - sx * sy * sz, sx * cz + cx * sy * sz],
    [sy, -sx * cy, cx * cy],
  ];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function getBodyAabb(body) {
  const [x, y, z] = body.position;
  const col = body.collision || { shape: 'sphere', radius: 0.45 };
  const sx = Math.abs(body.scale?.[0] ?? 1);
  const sy = Math.abs(body.scale?.[1] ?? 1);
  const sz = Math.abs(body.scale?.[2] ?? 1);

  if (col.shape === 'compound_convex' && Array.isArray(col.primitives) && col.primitives.length > 0) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of col.primitives) {
      const off = p.offset || [0, 0, 0];
      const sub = getBodyAabb({
        position: [x + off[0] * sx, y + off[1] * sy, z + off[2] * sz],
        rotation: body.rotation,
        scale: body.scale,
        collision: p,
      });
      if (sub.minX < minX) minX = sub.minX;
      if (sub.minY < minY) minY = sub.minY;
      if (sub.minZ < minZ) minZ = sub.minZ;
      if (sub.maxX > maxX) maxX = sub.maxX;
      if (sub.maxY > maxY) maxY = sub.maxY;
      if (sub.maxZ > maxZ) maxZ = sub.maxZ;
    }
    const hx = (maxX - minX) * 0.5;
    const hy = (maxY - minY) * 0.5;
    const hz = (maxZ - minZ) * 0.5;
    return { minX, maxX, minY, maxY, minZ, maxZ, hx, hy, hz, boundingRadius: Math.max(hx, hy, hz) };
  }

  let hx = (col.radius || 0.45) * sx;
  let hy = (col.radius || 0.45) * sy;
  let hz = (col.radius || 0.45) * sz;

  if (col.shape === 'box' && Array.isArray(col.halfExtents)) {
    const ex = col.halfExtents[0] * sx;
    const ey = col.halfExtents[1] * sy;
    const ez = col.halfExtents[2] * sz;
    const axes = eulerToAxes(body.rotation);
    // Conservative world AABB enclosing rotated OBB
    hx = Math.abs(axes[0][0]) * ex + Math.abs(axes[1][0]) * ey + Math.abs(axes[2][0]) * ez;
    hy = Math.abs(axes[0][1]) * ex + Math.abs(axes[1][1]) * ey + Math.abs(axes[2][1]) * ez;
    hz = Math.abs(axes[0][2]) * ex + Math.abs(axes[1][2]) * ey + Math.abs(axes[2][2]) * ez;
  } else if (col.shape === 'capsule') {
    const r = (col.radius || 0.35) * Math.max(sx, sz);
    const hh = ((col.halfHeight || 0.5) * sy) + r;
    hx = r;
    hy = hh;
    hz = r;
  }

  return {
    minX: x - hx, maxX: x + hx,
    minY: y - hy, maxY: y + hy,
    minZ: z - hz, maxZ: z + hz,
    hx, hy, hz,
    boundingRadius: Math.max(hx, hy, hz),
  };
}

/**
 * Spatial hash broadphase returning deterministically sorted candidate pairs [a, b, aabbA, aabbB].
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

  return Array.from(pairMap.entries())
    .sort((e1, e2) => (e1[0] < e2[0] ? -1 : e1[0] > e2[0] ? 1 : 0))
    .map(e => e[1]);
}

/**
 * (#11) Swept Continuous Collision Detection (CCD) for two moving bounding spheres.
 * Returns time-of-impact toi in [0, 1] or null if no swept impact occurs during dt.
 */
export function computeSweptSphereTOI(posA, velA, rA, posB, velB, rB, dt) {
  const rx = posB[0] - posA[0];
  const ry = posB[1] - posA[1];
  const rz = posB[2] - posA[2];
  const rSum = rA + rB;
  const c = rx * rx + ry * ry + rz * rz - rSum * rSum;
  if (c <= 0) return 0; // Already overlapping

  const vx = (velB[0] - velA[0]) * dt;
  const vy = (velB[1] - velA[1]) * dt;
  const vz = (velB[2] - velA[2]) * dt;
  const a = vx * vx + vy * vy + vz * vz;
  if (a < 1e-10) return null;

  const b = rx * vx + ry * vy + rz * vz;
  if (b >= 0) return null; // Moving apart

  const disc = b * b - a * c;
  if (disc < 0) return null;

  const t = (-b - Math.sqrt(disc)) / a;
  return (t >= 0 && t <= 1) ? t : null;
}

/**
 * (#12) Rotation-aware Oriented Bounding Box (OBB) vs OBB Separating Axis Theorem (SAT).
 */
function obbVsObb(a, b, isTrigger) {
  const axesA = eulerToAxes(a.rotation);
  const axesB = eulerToAxes(b.rotation);
  const extA = [
    (a.collision.halfExtents?.[0] ?? 0.4) * Math.abs(a.scale?.[0] ?? 1),
    (a.collision.halfExtents?.[1] ?? 0.4) * Math.abs(a.scale?.[1] ?? 1),
    (a.collision.halfExtents?.[2] ?? 0.4) * Math.abs(a.scale?.[2] ?? 1),
  ];
  const extB = [
    (b.collision.halfExtents?.[0] ?? 0.4) * Math.abs(b.scale?.[0] ?? 1),
    (b.collision.halfExtents?.[1] ?? 0.4) * Math.abs(b.scale?.[1] ?? 1),
    (b.collision.halfExtents?.[2] ?? 0.4) * Math.abs(b.scale?.[2] ?? 1),
  ];

  const tVec = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
  const candidates = [...axesA, ...axesB];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const c = cross3(axesA[i], axesB[j]);
      const len = Math.hypot(c[0], c[1], c[2]);
      if (len > 1e-5) candidates.push([c[0] / len, c[1] / len, c[2] / len]);
    }
  }

  let minOverlap = Infinity;
  let bestAxis = [0, 1, 0];

  for (const axis of candidates) {
    const rA = Math.abs(dot3(axis, axesA[0])) * extA[0] + Math.abs(dot3(axis, axesA[1])) * extA[1] + Math.abs(dot3(axis, axesA[2])) * extA[2];
    const rB = Math.abs(dot3(axis, axesB[0])) * extB[0] + Math.abs(dot3(axis, axesB[1])) * extB[1] + Math.abs(dot3(axis, axesB[2])) * extB[2];
    const dist = Math.abs(dot3(tVec, axis));
    const overlap = rA + rB - dist;
    if (overlap <= 0) return null; // Separating axis found!
    if (overlap < minOverlap) {
      minOverlap = overlap;
      bestAxis = dot3(tVec, axis) >= 0 ? axis : [-axis[0], -axis[1], -axis[2]];
    }
  }

  return {
    nx: bestAxis[0],
    ny: bestAxis[1],
    nz: bestAxis[2],
    depth: Math.max(0.0001, minOverlap),
    isTrigger,
    contactPoint: [
      (a.position[0] + b.position[0]) * 0.5,
      (a.position[1] + b.position[1]) * 0.5,
      (a.position[2] + b.position[2]) * 0.5,
    ],
  };
}

/**
 * (#12) Rotation-aware OBB vs Sphere narrowphase.
 */
function obbVsSphere(obb, sph, sphRadius, obbIsA, isTrigger) {
  const axes = eulerToAxes(obb.rotation);
  const ext = [
    (obb.collision.halfExtents?.[0] ?? 0.4) * Math.abs(obb.scale?.[0] ?? 1),
    (obb.collision.halfExtents?.[1] ?? 0.4) * Math.abs(obb.scale?.[1] ?? 1),
    (obb.collision.halfExtents?.[2] ?? 0.4) * Math.abs(obb.scale?.[2] ?? 1),
  ];

  const d = [sph.position[0] - obb.position[0], sph.position[1] - obb.position[1], sph.position[2] - obb.position[2]];
  const closest = [...obb.position];
  for (let i = 0; i < 3; i++) {
    const dist = clamp(dot3(d, axes[i]), -ext[i], ext[i]);
    closest[0] += axes[i][0] * dist;
    closest[1] += axes[i][1] * dist;
    closest[2] += axes[i][2] * dist;
  }

  const dx = sph.position[0] - closest[0];
  const dy = sph.position[1] - closest[1];
  const dz = sph.position[2] - closest[2];
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= sphRadius * sphRadius) return null;

  const dist = Math.sqrt(distSq);
  let nx = dist > 1e-6 ? dx / dist : 0;
  let ny = dist > 1e-6 ? dy / dist : 1;
  let nz = dist > 1e-6 ? dz / dist : 0;
  // Normal points from A to B
  if (!obbIsA) {
    nx = -nx; ny = -ny; nz = -nz;
  }

  return {
    nx, ny, nz,
    depth: Math.max(0.0001, sphRadius - dist),
    isTrigger,
    contactPoint: closest,
  };
}

/**
 * Narrowphase contact test between two bodies supporting compound_convex, rotated OBB, capsule, sphere, and trigger.
 */
export function narrowphaseContact(a, b, aabbA, aabbB) {
  const shapeA = a.collision?.shape || 'sphere';
  const shapeB = b.collision?.shape || 'sphere';
  const isTrigger = shapeA === 'trigger' || shapeB === 'trigger';

  // (#12) Compound multi-primitive proxy recursion
  if (shapeA === 'compound_convex' && Array.isArray(a.collision?.primitives)) {
    let deepest = null;
    const axes = eulerToAxes(a.rotation);
    for (const prim of a.collision.primitives) {
      const off = prim.offset || [0, 0, 0];
      const worldOff = [
        axes[0][0] * off[0] + axes[1][0] * off[1] + axes[2][0] * off[2],
        axes[0][1] * off[0] + axes[1][1] * off[1] + axes[2][1] * off[2],
        axes[0][2] * off[0] + axes[1][2] * off[1] + axes[2][2] * off[2],
      ];
      const subBody = {
        ...a,
        position: [a.position[0] + worldOff[0], a.position[1] + worldOff[1], a.position[2] + worldOff[2]],
        collision: prim,
      };
      const c = narrowphaseContact(subBody, b, getBodyAabb(subBody), aabbB);
      if (c && (!deepest || c.depth > deepest.depth)) deepest = c;
    }
    return deepest;
  }

  if (shapeB === 'compound_convex' && Array.isArray(b.collision?.primitives)) {
    let deepest = null;
    const axes = eulerToAxes(b.rotation);
    for (const prim of b.collision.primitives) {
      const off = prim.offset || [0, 0, 0];
      const worldOff = [
        axes[0][0] * off[0] + axes[1][0] * off[1] + axes[2][0] * off[2],
        axes[0][1] * off[0] + axes[1][1] * off[1] + axes[2][1] * off[2],
        axes[0][2] * off[0] + axes[1][2] * off[1] + axes[2][2] * off[2],
      ];
      const subBody = {
        ...b,
        position: [b.position[0] + worldOff[0], b.position[1] + worldOff[1], b.position[2] + worldOff[2]],
        collision: prim,
      };
      const c = narrowphaseContact(a, subBody, aabbA, getBodyAabb(subBody));
      if (c && (!deepest || c.depth > deepest.depth)) deepest = c;
    }
    return deepest;
  }

  // (#12) Rotation-aware OBB vs OBB
  if (shapeA === 'box' && shapeB === 'box') {
    return obbVsObb(a, b, isTrigger);
  }

  // (#12) Rotation-aware OBB vs Sphere
  if (shapeA === 'box' && shapeB === 'sphere') {
    return obbVsSphere(a, b, aabbB.boundingRadius, true, isTrigger);
  }
  if (shapeA === 'sphere' && shapeB === 'box') {
    return obbVsSphere(b, a, aabbA.boundingRadius, false, isTrigger);
  }

  // Capsule-Sphere / Capsule-Capsule
  if (shapeA === 'capsule' || shapeB === 'capsule') {
    const halfH = (body) => body.collision?.shape === 'capsule' ? (body.collision.halfHeight || 0.5) * Math.abs(body.scale?.[1] ?? 1) : 0;
    const rad = (body, aabb) => body.collision?.shape === 'capsule'
      ? (body.collision.radius || 0.35) * Math.max(Math.abs(body.scale?.[0] ?? 1), Math.abs(body.scale?.[2] ?? 1))
      : aabb.boundingRadius;

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

  // Default: Sphere-Sphere
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
