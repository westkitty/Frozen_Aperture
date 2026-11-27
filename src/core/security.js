/**
 * Frozen Aperture — Security, Privacy & Resource Budget Guards
 * Treats all imported files, project bundles, and provider outputs as untrusted input.
 */

export const RESOURCE_LIMITS = Object.freeze({
  MAX_IMAGE_BYTES: 32 * 1024 * 1024,         // 32 MB
  MAX_IMAGE_DIMENSION: 8192,                 // 8192 px per axis
  MAX_IMAGE_PIXELS: 33_554_432,              // 32 MP
  MAX_GLB_BYTES: 128 * 1024 * 1024,          // 128 MB
  MAX_GLB_VERTICES: 1_500_000,               // 1.5M vertices
  MAX_GLB_TRIANGLES: 2_000_000,              // 2.0M triangles
  MAX_GLB_TEXTURES: 32,
  MAX_PROJECT_JSON_BYTES: 64 * 1024 * 1024,  // 64 MB
  MAX_SCENE_OBJECTS: 512,
  MAX_SOURCE_OBJECTS: 256,
  MAX_MASK_POINTS: 4096,
  MAX_SNAPSHOT_HISTORY: 100,
  MAX_PROVIDER_CONCURRENCY: 1,
});

export const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

export function sanitizeId(raw, fallback = 'item') {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);
  return cleaned || fallback;
}

export function sanitizeLabel(raw, fallback = 'Untitled') {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 128);
  return cleaned || fallback;
}

export function sanitizeFilename(raw, fallback = 'export.json') {
  if (typeof raw !== 'string') return fallback;
  const base = raw.split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || fallback;
}

export function isUnsafePath(p) {
  if (typeof p !== 'string' || !p.trim()) return true;
  if (p.includes('\0')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\')) return true;
  const parts = p.split(/[\\/]+/);
  return parts.some(seg => seg === '..');
}

export function isExternalUri(uri) {
  if (typeof uri !== 'string') return false;
  const trimmed = uri.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:')) return false;
  if (/^(https?|ftp|file|ws|wss):\/\//i.test(trimmed)) return true;
  return true; // Any non-data URI in a standalone GLB is external
}

export function isFiniteVec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

export function isFiniteVec4(v) {
  return Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

export function clampFinite(n, min, max, fallback = 0) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
