/**
 * Frozen Aperture — Disocclusion & Background Plate Inpainting Generator (#5)
 * Produces a clean background plate by iteratively diffusing border pixels into
 * foreground-object mask regions, plus a per-pixel coverage & confidence map
 * so moving foreground objects do not leave ghosted silhouettes.
 */

import { rasterizeSourceObjectMask } from '../render/silhouette-iou.js';

/**
 * Pure RGBA buffer disocclusion inpainting usable in both Browser and Node.js.
 * Returns { rgba, confidenceMask, inpaintedPixels, coverageRatio, meanConfidence }.
 */
export function inpaintBackgroundBuffer(rgba, width, height, holeMask, { iterations = 18 } = {}) {
  const out = new Uint8ClampedArray(rgba);
  const known = new Uint8Array(width * height);
  const confidence = new Float32Array(width * height);
  let holeCount = 0;

  for (let i = 0; i < known.length; i++) {
    if (holeMask[i] > 0) {
      known[i] = 0;
      confidence[i] = 0;
      holeCount++;
    } else {
      known[i] = 1;
      confidence[i] = 1.0;
    }
  }

  // Iterative onion-peel border diffusion from known background pixels inward
  for (let iter = 0; iter < iterations; iter++) {
    const nextKnown = new Uint8Array(known);
    let filledThisPass = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (known[idx]) continue;

        let rSum = 0, gSum = 0, bSum = 0, cSum = 0, count = 0;
        const neighbors = [
          [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
          [x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (!known[nIdx]) continue;
          rSum += out[nIdx * 4];
          gSum += out[nIdx * 4 + 1];
          bSum += out[nIdx * 4 + 2];
          cSum += confidence[nIdx];
          count++;
        }
        if (count > 0) {
          out[idx * 4] = Math.round(rSum / count);
          out[idx * 4 + 1] = Math.round(gSum / count);
          out[idx * 4 + 2] = Math.round(bSum / count);
          out[idx * 4 + 3] = 255;
          nextKnown[idx] = 1;
          confidence[idx] = Math.max(0.15, (cSum / count) * 0.92);
          filledThisPass++;
        }
      }
    }
    known.set(nextKnown);
    if (filledThisPass === 0) break;
  }

  let confSum = 0;
  for (let i = 0; i < confidence.length; i++) confSum += confidence[i];
  const total = width * height;

  return {
    rgba: out,
    confidenceMask: confidence,
    inpaintedPixels: holeCount,
    coverageRatio: Number((1 - holeCount / Math.max(1, total)).toFixed(4)),
    meanConfidence: Number((confSum / Math.max(1, total)).toFixed(4)),
  };
}

/**
 * Offloads disocclusion inpainting to an inline offline Blob Web Worker with zero-copy
 * ArrayBuffer transfer, falling back cleanly to main-thread execution if Worker is unavailable.
 */
export async function inpaintBackgroundBufferAsync(rgba, width, height, holeMask, { iterations = 18 } = {}) {
  const canUseWorker = typeof globalThis.Worker === 'function' && typeof globalThis.Blob === 'function' && typeof globalThis.URL?.createObjectURL === 'function';
  if (!canUseWorker) {
    return inpaintBackgroundBuffer(rgba, width, height, holeMask, { iterations });
  }

  const workerSrc = `
    self.onmessage = function(ev) {
      const { rgbaBuf, holeBuf, width, height, iterations } = ev.data;
      const out = new Uint8ClampedArray(rgbaBuf);
      const holeMask = new Uint8Array(holeBuf);
      const known = new Uint8Array(width * height);
      const confidence = new Float32Array(width * height);
      let holeCount = 0;
      for (let i = 0; i < known.length; i++) {
        if (holeMask[i] > 0) { known[i] = 0; confidence[i] = 0; holeCount++; }
        else { known[i] = 1; confidence[i] = 1.0; }
      }
      for (let iter = 0; iter < iterations; iter++) {
        const nextKnown = new Uint8Array(known);
        let filled = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (known[idx]) continue;
            let rSum = 0, gSum = 0, bSum = 0, cSum = 0, cnt = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= height) continue;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                const nIdx = ny * width + nx;
                if (!known[nIdx]) continue;
                rSum += out[nIdx * 4]; gSum += out[nIdx * 4 + 1]; bSum += out[nIdx * 4 + 2]; cSum += confidence[nIdx]; cnt++;
              }
            }
            if (cnt > 0) {
              out[idx * 4] = Math.round(rSum / cnt);
              out[idx * 4 + 1] = Math.round(gSum / cnt);
              out[idx * 4 + 2] = Math.round(bSum / cnt);
              out[idx * 4 + 3] = 255;
              nextKnown[idx] = 1;
              confidence[idx] = Math.max(0.15, (cSum / cnt) * 0.92);
              filled++;
            }
          }
        }
        known.set(nextKnown);
        if (filled === 0) break;
      }
      let confSum = 0;
      for (let i = 0; i < confidence.length; i++) confSum += confidence[i];
      const total = width * height;
      self.postMessage({
        rgbaBuf: out.buffer,
        confBuf: confidence.buffer,
        inpaintedPixels: holeCount,
        coverageRatio: Number((1 - holeCount / Math.max(1, total)).toFixed(4)),
        meanConfidence: Number((confSum / Math.max(1, total)).toFixed(4)),
      }, [out.buffer, confidence.buffer]);
    };
  `;

  const blobUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }));
  const worker = new Worker(blobUrl);
  try {
    const rgbaCopy = new Uint8ClampedArray(rgba);
    const holeCopy = new Uint8Array(holeMask);
    return await new Promise((resolve, reject) => {
      worker.onmessage = (ev) => {
        const d = ev.data;
        resolve({
          rgba: new Uint8ClampedArray(d.rgbaBuf),
          confidenceMask: new Float32Array(d.confBuf),
          inpaintedPixels: d.inpaintedPixels,
          coverageRatio: d.coverageRatio,
          meanConfidence: d.meanConfidence,
          offloadedToWorker: true,
        });
      };
      worker.onerror = (err) => reject(new Error(err.message || 'Background inpaint worker failed'));
      worker.postMessage(
        { rgbaBuf: rgbaCopy.buffer, holeBuf: holeCopy.buffer, width, height, iterations },
        [rgbaCopy.buffer, holeCopy.buffer]
      );
    });
  } catch (_) {
    return inpaintBackgroundBuffer(rgba, width, height, holeMask, { iterations });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Browser helper: generates a clean disoccluded background plate Data URL from a source illustration
 * and all extracted sourceObjects using off-thread Web Worker inpainting.
 */
export async function generateBackgroundPlateFromSource(sourceMeta, sourceObjects, maxDim = 480) {
  if (!sourceMeta?.dataUrl) throw new Error('No source illustration loaded.');
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Failed to decode source image for background plate.'));
    im.src = sourceMeta.dataUrl;
  });

  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(16, Math.round(img.naturalWidth * scale));
  const h = Math.max(16, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);

  const combinedMask = new Uint8Array(w * h);
  for (const so of sourceObjects || []) {
    const m = rasterizeSourceObjectMask(so, img.naturalWidth, img.naturalHeight, w, h);
    for (let i = 0; i < m.length; i++) {
      if (m[i]) combinedMask[i] = 1;
    }
  }

  const res = await inpaintBackgroundBufferAsync(imgData.data, w, h, combinedMask, { iterations: 24 });
  const outImg = ctx.createImageData(w, h);
  outImg.data.set(res.rgba);
  ctx.putImageData(outImg, 0, 0);

  return {
    type: 'background_representation',
    mode: 'disoccluded_inpainted_plate',
    collisionReady: false,
    width: w,
    height: h,
    dataUrl: canvas.toDataURL('image/png'),
    inpaintedPixels: res.inpaintedPixels,
    coverage: res.coverageRatio,
    confidence: res.meanConfidence,
    offloadedToWorker: Boolean(res.offloadedToWorker),
    generatedAt: new Date().toISOString(),
  };
}
