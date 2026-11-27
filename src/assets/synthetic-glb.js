/**
 * Frozen Aperture — Deterministic Synthetic Binary glTF 2.0 (GLB) Builder
 * Produces genuine, structurally valid, watertight GLB buffers for public calibration
 * solids and automated test fixtures without external binary dependencies.
 */

function pad4(len) {
  return (4 - (len % 4)) % 4;
}

function buildGlbFromGeometry({ name = 'SyntheticSolid', positions, normals, colors, indices, baseColorFactor = [0.22, 0.58, 0.92, 1.0], metallic = 0.25, roughness = 0.45 }) {
  const posArr = new Float32Array(positions);
  const normArr = new Float32Array(normals);
  const colArr = colors ? new Float32Array(colors) : null;
  const idxArr = new Uint16Array(indices);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < posArr.length; i += 3) {
    if (posArr[i] < minX) minX = posArr[i];
    if (posArr[i + 1] < minY) minY = posArr[i + 1];
    if (posArr[i + 2] < minZ) minZ = posArr[i + 2];
    if (posArr[i] > maxX) maxX = posArr[i];
    if (posArr[i + 1] > maxY) maxY = posArr[i + 1];
    if (posArr[i + 2] > maxZ) maxZ = posArr[i + 2];
  }

  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;

  function appendBuffer(typedArray, target) {
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const pad = pad4(bytes.byteLength);
    const viewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    chunks.push(bytes);
    if (pad > 0) chunks.push(new Uint8Array(pad));
    byteOffset += bytes.byteLength + pad;
    return viewIndex;
  }

  const posView = appendBuffer(posArr, 34962);
  const normView = appendBuffer(normArr, 34962);
  const colView = colArr ? appendBuffer(colArr, 34962) : null;
  const idxView = appendBuffer(idxArr, 34963);

  accessors.push({
    bufferView: posView,
    componentType: 5126,
    count: posArr.length / 3,
    type: 'VEC3',
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  });
  accessors.push({
    bufferView: normView,
    componentType: 5126,
    count: normArr.length / 3,
    type: 'VEC3',
  });
  const attributes = { POSITION: 0, NORMAL: 1 };
  if (colView !== null) {
    attributes.COLOR_0 = accessors.length;
    accessors.push({
      bufferView: colView,
      componentType: 5126,
      count: colArr.length / 3,
      type: 'VEC3',
    });
  }
  const idxAcc = accessors.length;
  accessors.push({
    bufferView: idxView,
    componentType: 5123,
    count: idxArr.length,
    type: 'SCALAR',
  });

  const gltf = {
    asset: { version: '2.0', generator: 'FrozenAperture-SyntheticGLB' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    materials: [
      {
        name: `${name}_Material`,
        pbrMetallicRoughness: {
          baseColorFactor,
          metallicFactor: metallic,
          roughnessFactor: roughness,
        },
      },
    ],
    meshes: [
      {
        name,
        primitives: [
          {
            attributes,
            indices: idxAcc,
            material: 0,
            mode: 4,
          },
        ],
      },
    ],
    buffers: [{ byteLength: byteOffset }],
    bufferViews,
    accessors,
  };

  const jsonBytesRaw = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = pad4(jsonBytesRaw.byteLength);
  const jsonChunkLen = jsonBytesRaw.byteLength + jsonPad;
  const binChunkLen = byteOffset;
  const totalLen = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);

  let ptr = 12;
  dv.setUint32(ptr, jsonChunkLen, true);
  dv.setUint32(ptr + 4, 0x4e4f534a, true); // JSON
  ptr += 8;
  out.set(jsonBytesRaw, ptr);
  for (let i = 0; i < jsonPad; i++) out[ptr + jsonBytesRaw.byteLength + i] = 0x20;
  ptr += jsonChunkLen;

  dv.setUint32(ptr, binChunkLen, true);
  dv.setUint32(ptr + 4, 0x004e4942, true); // BIN\0
  ptr += 8;
  for (const c of chunks) {
    out.set(c, ptr);
    ptr += c.byteLength;
  }

  return out;
}

/**
 * Generates a watertight synthetic faceted volumetric figure / calibration solid GLB.
 * Clearly labeled as a synthetic calibration solid (never claimed to be private artwork).
 */
export function createCalibrationSolidGlb({
  name = 'SyntheticCalibrationSolid',
  radius = 0.55,
  height = 1.65,
  radialSegments = 14,
  heightSegments = 10,
  baseColor = [0.24, 0.62, 0.95, 1.0],
} = {}) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  // Lathe-style organic monolithic silhouette (closed top & bottom poles for watertightness)
  const rings = [];
  for (let y = 0; y <= heightSegments; y++) {
    const t = y / heightSegments;
    const py = (t - 0.5) * height;
    // Tapered sculptural profile
    let r = radius * Math.sin(t * Math.PI);
    if (t > 0.15 && t < 0.85) {
      r *= 0.85 + 0.25 * Math.sin(t * Math.PI * 3.0);
    }
    rings.push({ py, r: Math.max(0.0001, r), t });
  }

  // Bottom pole
  positions.push(0, -height * 0.5, 0);
  normals.push(0, -1, 0);
  colors.push(baseColor[0] * 0.5, baseColor[1] * 0.6, baseColor[2] * 0.8);

  // Intermediate rings
  for (let y = 1; y < heightSegments; y++) {
    const { py, r, t } = rings[y];
    for (let s = 0; s < radialSegments; s++) {
      const a = (s / radialSegments) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      positions.push(nx * r, py, nz * r);
      normals.push(nx, 0.15 * (t - 0.5), nz);
      const shade = 0.65 + 0.35 * t;
      colors.push(
        Math.min(1, baseColor[0] * shade),
        Math.min(1, baseColor[1] * shade),
        Math.min(1, baseColor[2] * shade)
      );
    }
  }

  // Top pole
  const topPoleIndex = 1 + (heightSegments - 1) * radialSegments;
  positions.push(0, height * 0.5, 0);
  normals.push(0, 1, 0);
  colors.push(Math.min(1, baseColor[0] * 1.1), Math.min(1, baseColor[1] * 1.1), Math.min(1, baseColor[2] * 1.1));

  // Bottom cap
  for (let s = 0; s < radialSegments; s++) {
    const next = (s + 1) % radialSegments;
    indices.push(0, 1 + next, 1 + s);
  }

  // Side quads
  for (let y = 0; y < heightSegments - 2; y++) {
    const rowA = 1 + y * radialSegments;
    const rowB = 1 + (y + 1) * radialSegments;
    for (let s = 0; s < radialSegments; s++) {
      const next = (s + 1) % radialSegments;
      indices.push(rowA + s, rowA + next, rowB + next);
      indices.push(rowA + s, rowB + next, rowB + s);
    }
  }

  // Top cap
  const lastRow = 1 + (heightSegments - 2) * radialSegments;
  for (let s = 0; s < radialSegments; s++) {
    const next = (s + 1) % radialSegments;
    indices.push(lastRow + s, lastRow + next, topPoleIndex);
  }

  // Normalize normals
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }

  return buildGlbFromGeometry({
    name,
    positions,
    normals,
    colors,
    indices,
    baseColorFactor: baseColor,
  });
}

export function createOctahedronGlb({ name = 'SyntheticCrystal', radius = 0.5, baseColor = [0.85, 0.32, 0.45, 1.0] } = {}) {
  const positions = [
    0, radius, 0,
    radius, 0, 0,
    0, 0, radius,
    -radius, 0, 0,
    0, 0, -radius,
    0, -radius, 0,
  ];
  const normals = [
    0, 1, 0,
    1, 0, 0,
    0, 0, 1,
    -1, 0, 0,
    0, 0, -1,
    0, -1, 0,
  ];
  const indices = [
    0, 2, 1,
    0, 3, 2,
    0, 4, 3,
    0, 1, 4,
    5, 1, 2,
    5, 2, 3,
    5, 3, 4,
    5, 4, 1,
  ];
  return buildGlbFromGeometry({ name, positions, normals, indices, baseColorFactor: baseColor });
}
