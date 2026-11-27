/**
 * Frozen Aperture — Portable .fap.zip Project Bundle Exporter & Importer (#22)
 * Zero-dependency pure-JS ZIP (store method, CRC-32 verified) packaging:
 *   - project.json (stripped of redundant inline base64 blobs)
 *   - assets/<sha256>.glb (deduplicated binary GLBs)
 *   - source/<filename> (original source illustration bytes)
 * Enforces strict path-traversal rejection on import.
 */

import { isUnsafePath, sanitizeFilename } from '../core/security.js';
import { validateProject, migrateProject } from '../core/schema.js';
import { base64ToBytes, bytesToBase64 } from '../core/hash.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Creates a standard ZIP archive (method 0 / STORE) from [{ name, data: Uint8Array }].
 */
export function buildZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const entry of entries) {
    if (isUnsafePath(entry.name)) {
      throw new Error(`Unsafe ZIP entry path rejected: ${entry.name}`);
    }
    const nameBytes = enc.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);

    // Local file header (30 bytes + name)
    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0, true);  // flags
    ldv.setUint16(8, 0, true);  // method = STORE
    ldv.setUint16(10, 0, true); // mod time
    ldv.setUint16(12, 0, true); // mod date
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.length, true);
    ldv.setUint32(22, data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    localParts.push(lh, data);

    // Central directory header (46 bytes + name)
    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralParts.push(ch);

    offset += lh.length + data.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  const totalLen = offset + centralSize + 22;
  const out = new Uint8Array(totalLen);
  let ptr = 0;
  for (const p of localParts) { out.set(p, ptr); ptr += p.length; }
  for (const p of centralParts) { out.set(p, ptr); ptr += p.length; }
  out.set(eocd, ptr);
  return out;
}

/**
 * Parses a STORE-method ZIP archive, verifying magic, path safety, and CRC-32 checksums.
 */
export function parseZipArchive(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder('utf-8');
  const files = new Map();

  let offset = 0;
  while (offset + 30 <= bytes.byteLength) {
    const sig = dv.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Reached central directory
    const method = dv.getUint16(offset + 8, true);
    const expectedCrc = dv.getUint32(offset + 14, true);
    const compSize = dv.getUint32(offset + 18, true);
    const nameLen = dv.getUint16(offset + 26, true);
    const extraLen = dv.getUint16(offset + 28, true);

    if (method !== 0) {
      throw new Error(`Unsupported ZIP compression method ${method} (expected STORE=0).`);
    }
    const nameStart = offset + 30;
    const name = dec.decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (isUnsafePath(name)) {
      throw new Error(`Path traversal rejected in ZIP entry: ${name}`);
    }
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > bytes.byteLength) {
      throw new Error(`Truncated ZIP entry: ${name}`);
    }
    const data = bytes.slice(dataStart, dataStart + compSize);
    const actualCrc = crc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC-32 mismatch for ZIP entry: ${name}`);
    }
    files.set(name, data);
    offset = dataStart + compSize;
  }
  return files;
}

/**
 * Exports a Frozen Aperture project + deduplicated binary GLBs & source image as a .fap.zip Uint8Array.
 */
export function exportProjectZipBundle(project, assetManager) {
  const check = validateProject(project);
  if (!check.valid) throw new Error(`Cannot bundle invalid project: ${check.errors.join('; ')}`);

  const docClone = JSON.parse(JSON.stringify(project));
  const entries = [];
  const addedSha = new Set();

  // Deduplicate binary GLBs by SHA-256
  for (const asset of docClone.assets || []) {
    const bytes = assetManager?.getBytes(project, asset.id);
    if (bytes && asset.sha256) {
      const relPath = `assets/${asset.sha256}.glb`;
      asset.bundlePath = relPath;
      asset.embeddedBase64 = null; // Avoid base64 inflation inside ZIP!
      if (!addedSha.has(asset.sha256)) {
        addedSha.add(asset.sha256);
        entries.push({ name: relPath, data: bytes });
      }
    }
  }

  // Extract source illustration binary if present
  const src = docClone.project?.sourceIllustration;
  if (src) {
    delete src.originalBytes;
    if (src.dataUrl && src.dataUrl.includes(',')) {
      const safeName = sanitizeFilename(src.name || 'source.png', 'source.png');
      const relPath = `source/${safeName}`;
      const b64 = src.dataUrl.split(',')[1];
      entries.push({ name: relPath, data: base64ToBytes(b64) });
      src.bundlePath = relPath;
      src.dataUrl = null;
    }
  }

  entries.unshift({
    name: 'project.json',
    data: new TextEncoder().encode(JSON.stringify(docClone, null, 2)),
  });

  return buildZipArchive(entries);
}

/**
 * Imports a .fap.zip bundle, validating paths, CRC-32, schema, and restoring binary assets into AssetManager.
 */
export function importProjectZipBundle(zipBuffer, assetManager) {
  const files = parseZipArchive(zipBuffer);
  const projBytes = files.get('project.json');
  if (!projBytes) throw new Error('Invalid .fap.zip bundle: missing project.json.');

  const raw = JSON.parse(new TextDecoder('utf-8').decode(projBytes));
  const project = migrateProject(raw);
  const check = validateProject(project);
  if (!check.valid) throw new Error(`Invalid bundled project: ${check.errors.join('; ')}`);

  // Restore deduplicated GLB binaries
  for (const asset of project.assets || []) {
    if (asset.bundlePath && files.has(asset.bundlePath)) {
      const bytes = files.get(asset.bundlePath);
      if (assetManager) {
        assetManager.binaryStore.set(asset.id, bytes);
      }
      if (bytes.byteLength <= 4 * 1024 * 1024) {
        asset.embeddedBase64 = bytesToBase64(bytes);
      }
    }
  }

  // Restore source illustration dataUrl
  const src = project.project?.sourceIllustration;
  if (src && src.bundlePath && files.has(src.bundlePath)) {
    const bytes = files.get(src.bundlePath);
    const mime = src.mimeType || 'image/png';
    src.dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
  }

  return { project, warnings: check.warnings, entryCount: files.size };
}

async function streamTransform(bytes, StreamCtor, format) {
  const cs = new StreamCtor(format);
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Builds a standard ZIP archive using native CompressionStream('deflate-raw') (method 8)
 * when beneficial, automatically keeping STORE (method 0) for incompressible entries (e.g. PNG).
 */
export async function buildZipArchiveAsync(entries) {
  const canDeflate = typeof globalThis.CompressionStream === 'function';
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const entry of entries) {
    if (isUnsafePath(entry.name)) {
      throw new Error(`Unsafe ZIP entry path rejected: ${entry.name}`);
    }
    const nameBytes = enc.encode(entry.name);
    const raw = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(raw);

    let method = 0;
    let payload = raw;
    if (canDeflate && raw.byteLength >= 128 && !/\.(png|jpg|jpeg|webp|gif)$/i.test(entry.name)) {
      try {
        const deflated = await streamTransform(raw, globalThis.CompressionStream, 'deflate-raw');
        if (deflated.byteLength < raw.byteLength) {
          method = 8;
          payload = deflated;
        }
      } catch (_) {
        method = 0;
        payload = raw;
      }
    }

    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0, true);
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, payload.length, true);
    ldv.setUint32(22, raw.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    localParts.push(lh, payload);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, payload.length, true);
    cdv.setUint32(24, raw.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralParts.push(ch);

    offset += lh.length + payload.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let ptr = 0;
  for (const p of localParts) { out.set(p, ptr); ptr += p.length; }
  for (const p of centralParts) { out.set(p, ptr); ptr += p.length; }
  out.set(eocd, ptr);
  return out;
}

/**
 * Parses both STORE (method 0) and DEFLATE (method 8) ZIP archives with CRC-32 & path-traversal checks.
 */
export async function parseZipArchiveAsync(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder('utf-8');
  const files = new Map();

  let offset = 0;
  while (offset + 30 <= bytes.byteLength) {
    const sig = dv.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    const method = dv.getUint16(offset + 8, true);
    const expectedCrc = dv.getUint32(offset + 14, true);
    const compSize = dv.getUint32(offset + 18, true);
    const nameLen = dv.getUint16(offset + 26, true);
    const extraLen = dv.getUint16(offset + 28, true);

    const nameStart = offset + 30;
    const name = dec.decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (isUnsafePath(name)) throw new Error(`Path traversal rejected in ZIP entry: ${name}`);
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > bytes.byteLength) throw new Error(`Truncated ZIP entry: ${name}`);

    const rawSlice = bytes.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = rawSlice;
    } else if (method === 8) {
      if (typeof globalThis.DecompressionStream !== 'function') {
        throw new Error('DecompressionStream unavailable to inflate DEFLATE ZIP entry.');
      }
      data = await streamTransform(rawSlice, globalThis.DecompressionStream, 'deflate-raw');
    } else {
      throw new Error(`Unsupported ZIP compression method ${method}.`);
    }

    if (crc32(data) !== expectedCrc) {
      throw new Error(`CRC-32 mismatch for ZIP entry: ${name}`);
    }
    files.set(name, data);
    offset = dataStart + compSize;
  }
  return files;
}

export async function exportProjectZipBundleCompressed(project, assetManager) {
  const check = validateProject(project);
  if (!check.valid) throw new Error(`Cannot bundle invalid project: ${check.errors.join('; ')}`);

  const docClone = JSON.parse(JSON.stringify(project));
  const entries = [];
  const addedSha = new Set();

  for (const asset of docClone.assets || []) {
    const bytes = assetManager?.getBytes(project, asset.id);
    if (bytes && asset.sha256) {
      const relPath = `assets/${asset.sha256}.glb`;
      asset.bundlePath = relPath;
      asset.embeddedBase64 = null;
      if (!addedSha.has(asset.sha256)) {
        addedSha.add(asset.sha256);
        entries.push({ name: relPath, data: bytes });
      }
    }
  }

  const src = docClone.project?.sourceIllustration;
  if (src) {
    delete src.originalBytes;
    if (src.dataUrl && src.dataUrl.includes(',')) {
      const safeName = sanitizeFilename(src.name || 'source.png', 'source.png');
      const relPath = `source/${safeName}`;
      entries.push({ name: relPath, data: base64ToBytes(src.dataUrl.split(',')[1]) });
      src.bundlePath = relPath;
      src.dataUrl = null;
    }
  }

  entries.unshift({
    name: 'project.json',
    data: new TextEncoder().encode(JSON.stringify(docClone, null, 2)),
  });

  return buildZipArchiveAsync(entries);
}

export async function importProjectZipBundleAsync(zipBuffer, assetManager) {
  const files = await parseZipArchiveAsync(zipBuffer);
  const projBytes = files.get('project.json');
  if (!projBytes) throw new Error('Invalid .fap.zip bundle: missing project.json.');

  const raw = JSON.parse(new TextDecoder('utf-8').decode(projBytes));
  const project = migrateProject(raw);
  const check = validateProject(project);
  if (!check.valid) throw new Error(`Invalid bundled project: ${check.errors.join('; ')}`);

  for (const asset of project.assets || []) {
    if (asset.bundlePath && files.has(asset.bundlePath)) {
      const bytes = files.get(asset.bundlePath);
      if (assetManager) assetManager.binaryStore.set(asset.id, bytes);
      if (bytes.byteLength <= 4 * 1024 * 1024) asset.embeddedBase64 = bytesToBase64(bytes);
    }
  }

  const src = project.project?.sourceIllustration;
  if (src && src.bundlePath && files.has(src.bundlePath)) {
    const bytes = files.get(src.bundlePath);
    src.dataUrl = `data:${src.mimeType || 'image/png'};base64,${bytesToBase64(bytes)}`;
  }

  return { project, warnings: check.warnings, entryCount: files.size };
}
