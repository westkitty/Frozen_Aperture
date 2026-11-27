/**
 * Frozen Aperture — Binary glTF 2.0 (GLB) Structural & Geometry Validator
 * Validates untrusted GLB buffers before allowing them into scene/asset registries.
 */

import { RESOURCE_LIMITS, isExternalUri } from '../core/security.js';

const GLB_MAGIC = 0x46546c67;      // 'glTF'
const CHUNK_JSON = 0x4e4f534a;     // 'JSON'
const CHUNK_BIN = 0x004e4942;      // 'BIN\0'

const COMPONENT_SIZES = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COUNTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function readAccessorSlice(json, binBytes, accessorIndex) {
  const acc = json.accessors?.[accessorIndex];
  if (!acc) return { error: `Missing accessor ${accessorIndex}` };
  const compSize = COMPONENT_SIZES[acc.componentType];
  const numComps = TYPE_COUNTS[acc.type];
  if (!compSize || !numComps) {
    return { error: `Unsupported accessor ${accessorIndex} type/componentType` };
  }
  if (!Number.isInteger(acc.count) || acc.count < 0) {
    return { error: `Invalid accessor ${accessorIndex} count` };
  }
  if (acc.bufferView === undefined) {
    return { acc, values: null }; // Sparse or zero-initialized
  }
  const bv = json.bufferViews?.[acc.bufferView];
  if (!bv) return { error: `Accessor ${accessorIndex} references missing bufferView ${acc.bufferView}` };
  const bvOffset = bv.byteOffset || 0;
  const accOffset = acc.byteOffset || 0;
  const elemSize = compSize * numComps;
  const stride = bv.byteStride || elemSize;
  const start = bvOffset + accOffset;
  const end = acc.count === 0 ? start : start + (acc.count - 1) * stride + elemSize;
  if (!binBytes || start < 0 || end > binBytes.byteLength || end > bvOffset + bv.byteLength) {
    return { error: `Accessor ${accessorIndex} exceeds bufferView/BIN bounds (${end} > ${binBytes ? binBytes.byteLength : 0})` };
  }
  return { acc, bv, start, stride, compSize, numComps };
}

function readScalarIndex(view, byteOffset, componentType) {
  switch (componentType) {
    case 5121: return view.getUint8(byteOffset);
    case 5123: return view.getUint16(byteOffset, true);
    case 5125: return view.getUint32(byteOffset, true);
    default: return -1;
  }
}

export function validateGlbBuffer(arrayBuffer, options = {}) {
  const maxBytes = options.maxBytes ?? RESOURCE_LIMITS.MAX_GLB_BYTES;
  const errors = [];
  const warnings = [];
  const stats = {
    byteLength: 0,
    version: null,
    meshCount: 0,
    primitiveCount: 0,
    vertexCount: 0,
    triangleCount: 0,
    degenerateTriangles: 0,
    materialCount: 0,
    textureCount: 0,
    hasUVs: false,
    hasNormals: false,
    hasVertexColors: false,
    bounds: null,
    topology: {
      analyzed: false,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      watertight: false,
    },
    extensionsUsed: [],
    extensionsRequired: [],
  };

  const bytes = arrayBuffer instanceof Uint8Array
    ? arrayBuffer
    : new Uint8Array(arrayBuffer);

  stats.byteLength = bytes.byteLength;

  if (bytes.byteLength < 12) {
    errors.push(`File too small for GLB header (${bytes.byteLength} bytes).`);
    return { valid: false, errors, warnings, stats };
  }

  if (bytes.byteLength > maxBytes) {
    errors.push(`GLB exceeds maximum byte budget (${bytes.byteLength} > ${maxBytes}).`);
    return { valid: false, errors, warnings, stats };
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const declaredLength = dv.getUint32(8, true);
  stats.version = version;

  if (magic !== GLB_MAGIC) {
    errors.push(`Invalid GLB magic: 0x${magic.toString(16)} (expected 0x46546c67).`);
    return { valid: false, errors, warnings, stats };
  }
  if (version !== 2) {
    errors.push(`Unsupported glTF version: ${version} (expected 2).`);
    return { valid: false, errors, warnings, stats };
  }
  if (declaredLength !== bytes.byteLength) {
    errors.push(`Declared GLB length (${declaredLength}) does not match actual size (${bytes.byteLength}).`);
    return { valid: false, errors, warnings, stats };
  }

  // Parse chunks
  let offset = 12;
  let jsonChunk = null;
  let binChunk = null;

  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) {
      errors.push(`Truncated chunk header at byte offset ${offset}.`);
      return { valid: false, errors, warnings, stats };
    }
    const chunkLen = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    offset += 8;
    if (offset + chunkLen > bytes.byteLength) {
      errors.push(`Chunk at offset ${offset - 8} exceeds file length.`);
      return { valid: false, errors, warnings, stats };
    }
    const slice = bytes.subarray(offset, offset + chunkLen);
    if (chunkType === CHUNK_JSON && !jsonChunk) {
      jsonChunk = slice;
    } else if (chunkType === CHUNK_BIN && !binChunk) {
      binChunk = slice;
    }
    offset += chunkLen;
  }

  if (!jsonChunk) {
    errors.push('Missing required JSON chunk.');
    return { valid: false, errors, warnings, stats };
  }

  let json;
  try {
    const text = new TextDecoder('utf-8').decode(jsonChunk).replace(/\0+$/, '');
    json = JSON.parse(text);
  } catch (err) {
    errors.push(`Invalid JSON chunk: ${err.message}`);
    return { valid: false, errors, warnings, stats };
  }

  if (!json.asset || !String(json.asset.version || '').startsWith('2.')) {
    errors.push('glTF asset.version must be 2.x.');
  }

  stats.extensionsUsed = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
  stats.extensionsRequired = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  stats.materialCount = Array.isArray(json.materials) ? json.materials.length : 0;
  stats.textureCount = Array.isArray(json.textures) ? json.textures.length : 0;

  if (stats.textureCount > RESOURCE_LIMITS.MAX_GLB_TEXTURES) {
    errors.push(`Texture count (${stats.textureCount}) exceeds budget (${RESOURCE_LIMITS.MAX_GLB_TEXTURES}).`);
  }

  // External URI policy (offline self-contained security)
  for (const buf of json.buffers || []) {
    if (buf.uri && isExternalUri(buf.uri)) {
      errors.push(`External buffer URI disallowed in self-contained GLB: ${buf.uri}`);
    }
  }
  for (const img of json.images || []) {
    if (img.uri && isExternalUri(img.uri)) {
      errors.push(`External image URI disallowed in self-contained GLB: ${img.uri}`);
    }
  }

  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  stats.meshCount = meshes.length;
  if (meshes.length === 0) {
    errors.push('GLB contains no meshes.');
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const binDv = binChunk ? new DataView(binChunk.buffer, binChunk.byteOffset, binChunk.byteLength) : null;
  const edgeCounts = new Map();
  let canAnalyzeTopology = true;

  for (let m = 0; m < meshes.length; m++) {
    const mesh = meshes[m];
    const prims = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    if (prims.length === 0) {
      warnings.push(`Mesh ${m} has no primitives.`);
      continue;
    }

    for (let p = 0; p < prims.length; p++) {
      const prim = prims[p];
      stats.primitiveCount++;
      const mode = prim.mode === undefined ? 4 : prim.mode;
      if (mode !== 4) {
        warnings.push(`Mesh ${m} primitive ${p} uses non-TRIANGLES mode (${mode}).`);
      }
      if (prim.material !== undefined && (!json.materials || !json.materials[prim.material])) {
        errors.push(`Mesh ${m} primitive ${p} references invalid material index ${prim.material}.`);
      }

      const posIdx = prim.attributes?.POSITION;
      if (posIdx === undefined) {
        errors.push(`Mesh ${m} primitive ${p} is missing POSITION attribute.`);
        continue;
      }
      if (prim.attributes.TEXCOORD_0 !== undefined) stats.hasUVs = true;
      if (prim.attributes.NORMAL !== undefined) stats.hasNormals = true;
      if (prim.attributes.COLOR_0 !== undefined) stats.hasVertexColors = true;

      const posInfo = readAccessorSlice(json, binChunk, posIdx);
      if (posInfo.error) {
        errors.push(posInfo.error);
        continue;
      }
      if (posInfo.acc.type !== 'VEC3' || posInfo.acc.componentType !== 5126) {
        errors.push(`POSITION accessor ${posIdx} must be VEC3 FLOAT.`);
        continue;
      }

      const vCount = posInfo.acc.count;
      stats.vertexCount += vCount;
      if (stats.vertexCount > RESOURCE_LIMITS.MAX_GLB_VERTICES) {
        errors.push(`Vertex count exceeds budget (${RESOURCE_LIMITS.MAX_GLB_VERTICES}).`);
        return { valid: false, errors, warnings, stats };
      }

      // Check finite coordinates & compute bounds
      const positions = new Float32Array(vCount * 3);
      for (let i = 0; i < vCount; i++) {
        const base = posInfo.start + i * posInfo.stride;
        const x = binDv.getFloat32(base, true);
        const y = binDv.getFloat32(base + 4, true);
        const z = binDv.getFloat32(base + 8, true);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          errors.push(`Non-finite vertex coordinate in mesh ${m} primitive ${p} at vertex ${i}.`);
          return { valid: false, errors, warnings, stats };
        }
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }

      if (mode === 4) {
        let triCount = 0;
        const getIdx = [];
        if (prim.indices !== undefined) {
          const idxInfo = readAccessorSlice(json, binChunk, prim.indices);
          if (idxInfo.error) {
            errors.push(idxInfo.error);
            continue;
          }
          if (idxInfo.acc.type !== 'SCALAR') {
            errors.push(`Indices accessor ${prim.indices} must be SCALAR.`);
            continue;
          }
          triCount = Math.floor(idxInfo.acc.count / 3);
          stats.triangleCount += triCount;
          if (stats.triangleCount > RESOURCE_LIMITS.MAX_GLB_TRIANGLES) {
            errors.push(`Triangle count exceeds budget (${RESOURCE_LIMITS.MAX_GLB_TRIANGLES}).`);
            return { valid: false, errors, warnings, stats };
          }
          for (let i = 0; i < idxInfo.acc.count; i++) {
            const idxVal = readScalarIndex(binDv, idxInfo.start + i * idxInfo.stride, idxInfo.acc.componentType);
            if (idxVal < 0 || idxVal >= vCount) {
              errors.push(`Index out of bounds in mesh ${m} primitive ${p}: ${idxVal} >= ${vCount}`);
              return { valid: false, errors, warnings, stats };
            }
            if (triCount <= 100000) getIdx.push(idxVal);
          }
        } else {
          triCount = Math.floor(vCount / 3);
          stats.triangleCount += triCount;
          if (triCount <= 100000) {
            for (let i = 0; i < triCount * 3; i++) getIdx.push(i);
          }
        }

        if (triCount > 100000) {
          canAnalyzeTopology = false;
        } else if (getIdx.length >= 3) {
          for (let t = 0; t < triCount; t++) {
            const a = getIdx[t * 3];
            const b = getIdx[t * 3 + 1];
            const c = getIdx[t * 3 + 2];
            if (a === b || b === c || c === a) {
              stats.degenerateTriangles++;
              continue;
            }
            const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
            const bx = positions[b * 3] - ax, by = positions[b * 3 + 1] - ay, bz = positions[b * 3 + 2] - az;
            const cx = positions[c * 3] - ax, cy = positions[c * 3 + 1] - ay, cz = positions[c * 3 + 2] - az;
            const crossX = by * cz - bz * cy;
            const crossY = bz * cx - bx * cz;
            const crossZ = bx * cy - by * cx;
            if (crossX * crossX + crossY * crossY + crossZ * crossZ < 1e-16) {
              stats.degenerateTriangles++;
            }
            const edges = [[a, b], [b, c], [c, a]];
            for (const [u, v] of edges) {
              const key = u < v ? `${m}:${p}:${u}:${v}` : `${m}:${p}:${v}:${u}`;
              edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
            }
          }
        }
      }
    }
  }

  if (stats.vertexCount === 0) {
    errors.push('GLB contains zero vertices.');
  }

  if (Number.isFinite(minX) && Number.isFinite(maxX)) {
    const size = [maxX - minX, maxY - minY, maxZ - minZ];
    stats.bounds = {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size,
      center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    };
    if (size[0] === 0 && size[1] === 0 && size[2] === 0) {
      errors.push('GLB bounding volume is collapsed to a single point.');
    }
  } else {
    errors.push('Unable to compute valid bounding volume.');
  }

  if (canAnalyzeTopology && edgeCounts.size > 0) {
    stats.topology.analyzed = true;
    for (const count of edgeCounts.values()) {
      if (count === 1) stats.topology.boundaryEdges++;
      else if (count > 2) stats.topology.nonManifoldEdges++;
    }
    stats.topology.watertight = stats.topology.boundaryEdges === 0 && stats.topology.nonManifoldEdges === 0;
  }

  if (stats.degenerateTriangles > 0) {
    warnings.push(`Detected ${stats.degenerateTriangles} degenerate triangles.`);
  }
  if (stats.topology.nonManifoldEdges > 0) {
    warnings.push(`Detected ${stats.topology.nonManifoldEdges} non-manifold edges.`);
  }

  return { valid: errors.length === 0, errors, warnings, stats };
}
