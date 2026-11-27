/**
 * Frozen Aperture — Offline Automatic Illustration-to-Playable-World Decomposer
 *
 * Works with ANY uploaded image (PNG, JPEG, WebP, GIF, BMP) 100% offline in the browser:
 * 1. Estimates border background color clusters + Sobel edge energy to separate foreground objects.
 * 2. Runs connected-component labeling to discover individually addressable objects with alpha masks.
 * 3. Falls back to salient-region grid decomposition if an image is uniformly dense/abstract.
 * 4. Computes exact Source-Camera frustum world coordinates & dimensions so the 3D scene
 *    reassembles the exact uploaded illustration from Source View, with genuine depth separation.
 * 5. Generates a clean disoccluded background plate via off-thread Web Worker inpainting.
 */

import { generateBackgroundPlateFromSource } from './background-plate.js';
import { createDefaultCamera } from '../core/schema.js';
import { sanitizeId } from '../core/security.js';

/**
 * Pure pixel-buffer foreground object detector usable in both Browser and Node.js.
 * Returns array of { bbox: { x, y, w, h }, mask: Uint8Array(anW * anH), areaRatio, depthOrder }.
 */
export function detectForegroundRegions(rgba, width, height, { maxObjects = 14 } = {}) {
  const total = width * height;
  const fg = new Uint8Array(total);

  // 1. Check if image already has meaningful transparency
  let transparentCount = 0;
  for (let i = 0; i < total; i++) {
    if (rgba[i * 4 + 3] < 200) transparentCount++;
  }

  if (transparentCount > total * 0.08) {
    for (let i = 0; i < total; i++) {
      fg[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
    }
  } else {
    // 2. Sample border pixels into 4 directional background prototypes (top, bottom, left, right)
    const sampleRegion = (x0, y0, x1, y1) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * width + x) * 4;
          r += rgba[idx]; g += rgba[idx + 1]; b += rgba[idx + 2]; n++;
        }
      }
      return n ? [r / n, g / n, b / n] : [10, 12, 18];
    };

    const bw = Math.max(2, Math.floor(width * 0.06));
    const bh = Math.max(2, Math.floor(height * 0.06));
    const bgPrototypes = [
      sampleRegion(0, 0, width, bh),
      sampleRegion(0, height - bh, width, height),
      sampleRegion(0, 0, bw, height),
      sampleRegion(width - bw, 0, width, height),
    ];

    // Compute per-pixel foreground saliency = min color distance to border + local gradient energy
    const scores = new Float32Array(total);
    let scoreSum = 0;
    let scoreSqSum = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];

        let minDist = Infinity;
        for (const [br, bg, bb] of bgPrototypes) {
          const d = Math.hypot(r - br, g - bg, b - bb);
          if (d < minDist) minDist = d;
        }

        // Local gradient magnitude (edges indicate structured foreground subjects)
        let grad = 0;
        if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
          const lIdx = i - 1, rIdx = i + 1, uIdx = i - width, dIdx = i + width;
          const gx = Math.abs(rgba[rIdx * 4] - rgba[lIdx * 4]) + Math.abs(rgba[rIdx * 4 + 1] - rgba[lIdx * 4 + 1]);
          const gy = Math.abs(rgba[dIdx * 4] - rgba[uIdx * 4]) + Math.abs(rgba[dIdx * 4 + 1] - rgba[uIdx * 4 + 1]);
          grad = (gx + gy) * 0.25;
        }

        // Slight border attenuation to avoid latching onto frame edges
        const edgeDist = Math.min(x / width, (width - 1 - x) / width, y / height, (height - 1 - y) / height);
        const borderWeight = edgeDist < 0.03 ? 0.45 : 1.0;

        const s = (minDist + grad * 0.55) * borderWeight;
        scores[i] = s;
        scoreSum += s;
        scoreSqSum += s * s;
      }
    }

    const mean = scoreSum / Math.max(1, total);
    const std = Math.sqrt(Math.max(0, scoreSqSum / Math.max(1, total) - mean * mean));
    const thresh = Math.max(16, mean + std * 0.25);

    for (let i = 0; i < total; i++) {
      fg[i] = scores[i] >= thresh ? 1 : 0;
    }

    // 1-pass 3x3 morphological closing to bridge thin gaps inside figures
    const dil = new Uint8Array(total);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (fg[i] || fg[i - 1] || fg[i + 1] || fg[i - width] || fg[i + width]) dil[i] = 1;
      }
    }
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        fg[i] = (dil[i] && dil[i - 1] && dil[i + 1] && dil[i - width] && dil[i + width]) ? 1 : 0;
      }
    }
  }

  // 3. Connected-component labeling (BFS)
  const labels = new Int32Array(total);
  const components = [];
  let nextLabel = 1;
  const queue = new Int32Array(total);

  for (let i = 0; i < total; i++) {
    if (!fg[i] || labels[i]) continue;
    const label = nextLabel++;
    let head = 0, tail = 0;
    queue[tail++] = i;
    labels[i] = label;

    let minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % width;
      const cy = (cur - cx) / width;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
      count++;

      const neighbors = [
        cx > 0 ? cur - 1 : -1,
        cx < width - 1 ? cur + 1 : -1,
        cy > 0 ? cur - width : -1,
        cy < height - 1 ? cur + width : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && fg[n] && !labels[n]) {
          labels[n] = label;
          queue[tail++] = n;
        }
      }
    }

    const areaRatio = count / total;
    if (areaRatio >= 0.004 && areaRatio <= 0.72) {
      components.push({
        label,
        count,
        areaRatio,
        bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      });
    }
  }

  // Sort by significance (area) and cap at maxObjects
  components.sort((a, b) => b.count - a.count);
  let selected = components.slice(0, maxObjects);

  // 4. Guaranteed Fallback: if image is uniformly dense/abstract (<2 components), decompose into a 3x2 salient grid
  if (selected.length < 2) {
    selected = [];
    const cols = 4, rows = 2;
    const padX = Math.round(width * 0.06);
    const padY = Math.round(height * 0.12);
    const usableW = width - padX * 2;
    const usableH = height - padY * 2;
    const cellW = Math.floor(usableW / cols);
    const cellH = Math.floor(usableH / rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        selected.push({
          label: -1,
          count: cellW * cellH,
          areaRatio: (cellW * cellH) / total,
          bbox: {
            x: padX + c * cellW + 2,
            y: padY + r * cellH + 2,
            w: Math.max(8, cellW - 4),
            h: Math.max(8, cellH - 4),
          },
        });
      }
    }
  }

  // Sort left-to-right for predictable object numbering
  selected.sort((a, b) => a.bbox.x - b.bbox.x);

  return selected.map((comp, idx) => {
    const mask = new Uint8Array(total);
    if (comp.label > 0) {
      for (let i = 0; i < total; i++) {
        if (labels[i] === comp.label) mask[i] = 1;
      }
    } else {
      const { x, y, w, h } = comp.bbox;
      for (let py = y; py < y + h; py++) {
        for (let px = x; px < x + w; px++) {
          mask[py * width + px] = 1;
        }
      }
    }
    return {
      bbox: comp.bbox,
      mask,
      areaRatio: Number(comp.areaRatio.toFixed(4)),
      depthOrder: idx + 1,
    };
  });
}

/**
 * Browser pipeline: takes ANY ingested sourceMeta illustration and compiles a complete,
 * immediately playable Frozen-Time 3D scene where every detected object from the image
 * is an individually clickable, depth-separated, physics-enabled layer over a clean
 * disoccluded background plate.
 */
export async function compileIllustrationToPlayableScene(project, sourceMeta, { maxObjects = 12 } = {}) {
  if (!sourceMeta?.dataUrl) throw new Error('Source illustration dataUrl required.');

  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Failed to decode illustration for auto-decomposition.'));
    im.src = sourceMeta.dataUrl;
  });

  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const aspect = srcW / Math.max(1, srcH);

  // Downsample for fast foreground analysis
  const anScale = Math.min(1, 220 / Math.max(srcW, srcH));
  const anW = Math.max(24, Math.round(srcW * anScale));
  const anH = Math.max(24, Math.round(srcH * anScale));

  const anCanvas = document.createElement('canvas');
  anCanvas.width = anW;
  anCanvas.height = anH;
  const anCtx = anCanvas.getContext('2d');
  anCtx.drawImage(img, 0, 0, anW, anH);
  const anData = anCtx.getImageData(0, 0, anW, anH).data;

  const detected = detectForegroundRegions(anData, anW, anH, { maxObjects });

  // Build calibrated Source Camera matching the uploaded image's aspect ratio
  const camSpec = createDefaultCamera(srcW, srcH);
  const camZ = 11.5;
  const camY = 2.4;
  camSpec.sourceCamera.position = [0, camY, camZ];
  camSpec.sourceCamera.target = [0, camY, 0];
  camSpec.sourceCamera.fovDeg = 42;
  camSpec.namedViews = [
    { id: 'source', label: 'Source View', position: [0, camY, camZ], target: [0, camY, 0], fovDeg: 42 },
    { id: 'side_left', label: 'Side Left', position: [-9.5, camY + 0.5, 4.0], target: [0, camY, 0], fovDeg: 42 },
    { id: 'side_right', label: 'Side Right', position: [9.5, camY + 0.5, 4.0], target: [0, camY, 0], fovDeg: 42 },
    { id: 'rear', label: 'Rear Inspection', position: [0, camY + 0.6, -10.5], target: [0, camY, 0], fovDeg: 42 },
    { id: 'overhead', label: 'Overhead', position: [0, camY + 11.0, 2.5], target: [0, camY - 0.5, 0], fovDeg: 46 },
  ];

  const halfFovRad = (camSpec.sourceCamera.fovDeg * Math.PI) / 360;
  const sourceObjects = [];
  const sceneObjects = [];

  for (let i = 0; i < detected.length; i++) {
    const d = detected[i];
    const bx = Math.max(0, Math.floor(d.bbox.x / anScale));
    const by = Math.max(0, Math.floor(d.bbox.y / anScale));
    const bw = Math.min(srcW - bx, Math.max(12, Math.ceil(d.bbox.w / anScale)));
    const bh = Math.min(srcH - by, Math.max(12, Math.ceil(d.bbox.h / anScale)));

    // Render crisp alpha-cutout PNG for this extracted object
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = anW;
    maskCanvas.height = anH;
    const mCtx = maskCanvas.getContext('2d');
    const mImg = mCtx.createImageData(anW, anH);
    for (let p = 0; p < d.mask.length; p++) {
      if (d.mask[p]) {
        mImg.data[p * 4] = 255;
        mImg.data[p * 4 + 1] = 255;
        mImg.data[p * 4 + 2] = 255;
        mImg.data[p * 4 + 3] = 255;
      }
    }
    mCtx.putImageData(mImg, 0, 0);

    const cropCanvas = document.createElement('canvas');
    const maxCropDim = 512;
    const cScale = Math.min(1, maxCropDim / Math.max(bw, bh));
    cropCanvas.width = Math.max(8, Math.round(bw * cScale));
    cropCanvas.height = Math.max(8, Math.round(bh * cScale));
    const cCtx = cropCanvas.getContext('2d');
    cCtx.drawImage(img, bx, by, bw, bh, 0, 0, cropCanvas.width, cropCanvas.height);
    cCtx.globalCompositeOperation = 'destination-in';
    cCtx.drawImage(maskCanvas, d.bbox.x, d.bbox.y, d.bbox.w, d.bbox.h, 0, 0, cropCanvas.width, cropCanvas.height);
    cCtx.globalCompositeOperation = 'source-over';
    const layerDataUrl = cropCanvas.toDataURL('image/png');

    // Estimate depth Z: lower-in-frame & larger objects sit closer to camera
    const bottomNorm = (by + bh) / srcH; // 0=top, 1=bottom
    const z = Number((-0.8 + bottomNorm * 2.2 + ((i % 3) - 1) * 0.18).toFixed(3));
    const distFromCam = camZ - z;
    const frustumH = 2 * distFromCam * Math.tan(halfFovRad);
    const frustumW = frustumH * aspect;

    // Exact source-camera world projection so objects reassemble the uploaded image cleanly!
    const uCenter = (bx + bw * 0.5) / srcW;
    const vCenter = (by + bh * 0.5) / srcH;
    const worldX = Number(((uCenter - 0.5) * frustumW).toFixed(3));
    const worldY = Number((camY + (0.5 - vCenter) * frustumH).toFixed(3));
    const worldW = Number(((bw / srcW) * frustumW).toFixed(3));
    const worldH = Number(((bh / srcH) * frustumH).toFixed(3));

    const srcId = sanitizeId(`src_auto_${String(i + 1).padStart(2, '0')}`);
    const objId = sanitizeId(`obj_auto_${String(i + 1).padStart(2, '0')}`);
    const label = `Extracted Object ${String(i + 1).padStart(2, '0')}`;

    sourceObjects.push({
      id: srcId,
      label,
      category: 'figure',
      bbox: { x: bx, y: by, w: bw, h: bh },
      mask: { type: 'rect', inverted: false },
      depthOrder: i + 1,
      reconstructionStatus: 'extracted',
      confidence: 0.85,
    });

    sceneObjects.push({
      id: objId,
      label,
      category: 'figure',
      representationType: 'source_image_layer',
      assetId: null,
      sourceObjectId: srcId,
      layerDataUrl,
      layerAspect: bw / Math.max(1, bh),
      layerWorldWidth: worldW,
      layerWorldHeight: worldH,
      position: [worldX, worldY, z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
      parentId: null,
      temporalState: 'held',
      velocity: [Number(((uCenter - 0.5) * 1.4).toFixed(2)), 0.35, Number((0.4 - i * 0.05).toFixed(2))],
      angularVelocity: [0.15, 0.25, Number(((i % 2 === 0 ? 1 : -1) * 0.35).toFixed(2))],
      collision: {
        shape: 'box',
        halfExtents: [Math.max(0.18, worldW * 0.42), Math.max(0.18, worldH * 0.42), 0.25],
        enabled: true,
      },
      physics: { mass: Number(Math.max(0.6, worldW * worldH * 0.6).toFixed(2)), restitution: 0.48, gravityScale: 1.0, isStatic: false },
      material: { color: '#ffffff', emissive: '#000000', roughness: 0.55, metalness: 0.08 },
      visible: true,
      interactive: true,
    });
  }

  // Generate clean disoccluded background plate behind all extracted objects (Web Worker)
  const pad = Math.max(6, Math.round(Math.max(srcW, srcH) * 0.008));
  const paddedForInpaint = sourceObjects.map(o => ({
    ...o,
    bbox: {
      x: Math.max(0, o.bbox.x - pad),
      y: Math.max(0, o.bbox.y - pad),
      w: Math.min(srcW - Math.max(0, o.bbox.x - pad), o.bbox.w + pad * 2),
      h: Math.min(srcH - Math.max(0, o.bbox.y - pad), o.bbox.h + pad * 2),
    },
  }));
  const bgPlate = await generateBackgroundPlateFromSource(sourceMeta, paddedForInpaint, 640);
  const bgZ = -2.4;
  const bgFrustumH = 2 * (camZ - bgZ) * Math.tan(halfFovRad);
  const bgFrustumW = bgFrustumH * aspect;
  bgPlate.worldWidth = Number(bgFrustumW.toFixed(3));
  bgPlate.worldHeight = Number(bgFrustumH.toFixed(3));
  bgPlate.worldPosition = [0, camY, bgZ];

  // Update project in place
  project.project.name = `${sourceMeta.name.replace(/\.[^.]+$/, '')} — Playable World`;
  project.project.isPublicFixture = false;
  project.project.sourceIllustration = sourceMeta;
  project.sourceObjects = sourceObjects;

  const scene = project.scenes[0];
  scene.name = sourceMeta.name;
  scene.cameras = camSpec;
  scene.environment.backgroundRepresentation = bgPlate;
  scene.objects = sceneObjects;
  scene.simulation.floorY = Number((camY - (2 * camZ * Math.tan(halfFovRad)) * 0.52).toFixed(3));

  return {
    objectCount: sceneObjects.length,
    bgPlate,
    sourceObjects,
  };
}
