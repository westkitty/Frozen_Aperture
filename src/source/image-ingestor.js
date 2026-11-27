/**
 * Frozen Aperture — Source Illustration Ingestion & Validation
 * Validates MIME type, decoded dimensions, pixel budgets, and computes SHA-256 identity
 * while preserving original source bytes separately from edited derivatives.
 */

import { sha256Hex, bytesToBase64 } from '../core/hash.js';
import { ALLOWED_IMAGE_MIMES, RESOURCE_LIMITS, sanitizeLabel } from '../core/security.js';

export function validateImageMetadata({ mimeType, byteLength, width, height }) {
  const errors = [];
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    errors.push(`Unsupported image MIME type: ${mimeType}`);
  }
  if (typeof byteLength !== 'number' || byteLength <= 0 || byteLength > RESOURCE_LIMITS.MAX_IMAGE_BYTES) {
    errors.push(`Image byte size out of bounds (${byteLength} bytes, max ${RESOURCE_LIMITS.MAX_IMAGE_BYTES}).`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    errors.push(`Invalid decoded image dimensions: ${width}x${height}.`);
  } else {
    if (width > RESOURCE_LIMITS.MAX_IMAGE_DIMENSION || height > RESOURCE_LIMITS.MAX_IMAGE_DIMENSION) {
      errors.push(`Image dimensions ${width}x${height} exceed max ${RESOURCE_LIMITS.MAX_IMAGE_DIMENSION}px.`);
    }
    if (width * height > RESOURCE_LIMITS.MAX_IMAGE_PIXELS) {
      errors.push(`Image pixel count (${width * height}) exceeds budget (${RESOURCE_LIMITS.MAX_IMAGE_PIXELS}).`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function ingestImageFile(file) {
  if (!file) throw new Error('No image file provided.');
  const mimeType = file.type || 'image/png';
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  if (bytes.byteLength > RESOURCE_LIMITS.MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${RESOURCE_LIMITS.MAX_IMAGE_BYTES / (1024 * 1024)} MB limit.`);
  }
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    throw new Error(`Unsupported image format: ${mimeType}`);
  }

  const sha256 = await sha256Hex(bytes);
  const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`;

  const dims = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, image: img });
    img.onerror = () => reject(new Error('Failed to decode image pixels.'));
    img.src = dataUrl;
  });

  const check = validateImageMetadata({
    mimeType,
    byteLength: bytes.byteLength,
    width: dims.width,
    height: dims.height,
  });
  if (!check.valid) {
    throw new Error(check.errors.join(' '));
  }

  return {
    name: sanitizeLabel(file.name, 'source-illustration.png'),
    mimeType,
    byteLength: bytes.byteLength,
    width: dims.width,
    height: dims.height,
    sha256,
    dataUrl,
    ingestedAt: new Date().toISOString(),
  };
}

/**
 * Generates a clean, stylized synthetic calibration illustration on an HTMLCanvasElement
 * so operators can test the full SOURCE -> OBJECTS -> ASSEMBLY workflow even without
 * uploading a private illustration.
 */
export async function createSyntheticTestIllustration(width = 1200, height = 750) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Dark speculative architectural void backdrop
  const bg = ctx.createRadialGradient(width * 0.5, height * 0.44, 30, width * 0.5, height * 0.5, width * 0.65);
  bg.addColorStop(0, '#0d1b2a');
  bg.addColorStop(0.45, '#070b14');
  bg.addColorStop(1, '#03050a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Reflective floor plane horizon
  const floor = ctx.createLinearGradient(0, height * 0.68, 0, height);
  floor.addColorStop(0, 'rgba(30, 58, 95, 0.25)');
  floor.addColorStop(1, 'rgba(5, 8, 16, 0.95)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, height * 0.68, width, height * 0.32);

  // Central black aperture vortex rings
  ctx.save();
  ctx.translate(width * 0.5, height * 0.42);
  for (let r = 135; r > 18; r -= 14) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(56, 189, 248, ${0.06 + (135 - r) / 500})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 54, 0, Math.PI * 2);
  ctx.fillStyle = '#020408';
  ctx.fill();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Synthetic silhouette monoliths for segmentation testing
  const figures = [
    { x: 240, y: 310, w: 110, h: 280, color: '#38bdf8', label: 'CAL-01' },
    { x: 430, y: 340, w: 95, h: 240, color: '#10b981', label: 'CAL-02' },
    { x: 690, y: 335, w: 100, h: 245, color: '#f43f5e', label: 'CAL-03' },
    { x: 870, y: 305, w: 115, h: 285, color: '#a855f7', label: 'CAL-04' },
  ];

  for (const f of figures) {
    ctx.save();
    ctx.fillStyle = f.color + '33';
    ctx.strokeStyle = f.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(f.x, f.y, f.w, f.h, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 13px monospace';
    ctx.fillText(f.label, f.x + 16, f.y + 28);
    ctx.restore();
  }

  ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
  ctx.font = '500 13px monospace';
  ctx.fillText('PUBLIC SYNTHETIC CALIBRATION PLATE (NOT PRIVATE APERTURE ARTWORK)', 24, height - 22);

  const dataUrl = canvas.toDataURL('image/png');
  const b64 = dataUrl.split(',')[1];
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const sha256 = await sha256Hex(bytes);

  return {
    name: 'synthetic-calibration-plate.png',
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    width,
    height,
    sha256,
    dataUrl,
    ingestedAt: new Date().toISOString(),
  };
}
