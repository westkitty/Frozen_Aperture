/**
 * Frozen Aperture — Silhouette IoU & Difference Heatmap Comparator (#4)
 * Compares a projected 3D mesh silhouette against a 2D source object mask/bbox,
 * reporting exact IoU %, precision, recall, and an RGBA visual difference overlay.
 */

/**
 * Pure binary mask IoU computation usable in both Browser and Node.js.
 * `maskA` and `maskB` are Uint8Array (0 or 1) of length width * height.
 */
export function computeMaskIoU(maskA, maskB, width, height) {
  if (maskA.length !== maskB.length) {
    throw new Error('Mask dimensions must match for Silhouette IoU comparison.');
  }
  let intersection = 0;
  let union = 0;
  let aCount = 0;
  let bCount = 0;
  const diffRgba = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < maskA.length; i++) {
    const a = maskA[i] > 0;
    const b = maskB[i] > 0;
    if (a) aCount++;
    if (b) bCount++;
    if (a && b) {
      intersection++;
      union++;
      // Green: matched overlap
      diffRgba[i * 4] = 16;
      diffRgba[i * 4 + 1] = 185;
      diffRgba[i * 4 + 2] = 129;
      diffRgba[i * 4 + 3] = 155;
    } else if (a) {
      union++;
      // Cyan: 3D rendered mesh outside source mask
      diffRgba[i * 4] = 56;
      diffRgba[i * 4 + 1] = 189;
      diffRgba[i * 4 + 2] = 248;
      diffRgba[i * 4 + 3] = 185;
    } else if (b) {
      union++;
      // Magenta: source mask missing in 3D render
      diffRgba[i * 4] = 244;
      diffRgba[i * 4 + 1] = 63;
      diffRgba[i * 4 + 2] = 94;
      diffRgba[i * 4 + 3] = 185;
    }
  }

  const iou = union > 0 ? intersection / union : 0;
  const precision = aCount > 0 ? intersection / aCount : 0;
  const recall = bCount > 0 ? intersection / bCount : 0;

  return {
    iou: Number(iou.toFixed(4)),
    iouPercent: Number((iou * 100).toFixed(2)),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    intersectionPixels: intersection,
    unionPixels: union,
    renderedPixels: aCount,
    sourcePixels: bCount,
    diffRgba,
  };
}

/**
 * Rasterizes a sourceObject's bbox or polygon mask into a binary Uint8Array(width * height).
 */
export function rasterizeSourceObjectMask(sourceObject, srcWidth, srcHeight, outWidth, outHeight) {
  const mask = new Uint8Array(outWidth * outHeight);
  if (!sourceObject?.bbox) return mask;
  const sx = outWidth / Math.max(1, srcWidth);
  const sy = outHeight / Math.max(1, srcHeight);

  const bx0 = Math.max(0, Math.floor(sourceObject.bbox.x * sx));
  const by0 = Math.max(0, Math.floor(sourceObject.bbox.y * sy));
  const bx1 = Math.min(outWidth - 1, Math.ceil((sourceObject.bbox.x + sourceObject.bbox.w) * sx));
  const by1 = Math.min(outHeight - 1, Math.ceil((sourceObject.bbox.y + sourceObject.bbox.h) * sy));

  const poly = sourceObject.mask?.type === 'polygon' && Array.isArray(sourceObject.mask.points) && sourceObject.mask.points.length >= 3
    ? sourceObject.mask.points.map(([x, y]) => [x * sx, y * sy])
    : null;

  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      if (!poly) {
        mask[y * outWidth + x] = 1;
      } else {
        // Ray-casting point-in-polygon
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i][0], yi = poly[i][1];
          const xj = poly[j][0], yj = poly[j][1];
          const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
          if (intersect) inside = !inside;
        }
        if (inside) mask[y * outWidth + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * Evaluates live Silhouette IoU from a WebGL canvas frame (isolated object rendered on dark void)
 * against a sourceObject mask, returning metrics + a PNG heatmap overlay Data URL.
 */
export function evaluateCanvasSilhouetteIoU(webglCanvas, sourceObject, srcWidth, srcHeight, sampleWidth = 240, sampleHeight = 150) {
  const tmp = document.createElement('canvas');
  tmp.width = sampleWidth;
  tmp.height = sampleHeight;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(webglCanvas, 0, 0, sampleWidth, sampleHeight);
  const pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;

  const renderedMask = new Uint8Array(sampleWidth * sampleHeight);
  for (let i = 0; i < renderedMask.length; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    // Void background is #05070c (5,7,12); anything noticeably brighter is rendered foreground
    if (r > 16 || g > 18 || b > 26) renderedMask[i] = 1;
  }

  const sourceMask = rasterizeSourceObjectMask(sourceObject, srcWidth, srcHeight, sampleWidth, sampleHeight);
  const result = computeMaskIoU(renderedMask, sourceMask, sampleWidth, sampleHeight);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = sampleWidth;
  outCanvas.height = sampleHeight;
  const outCtx = outCanvas.getContext('2d');
  const imgData = outCtx.createImageData(sampleWidth, sampleHeight);
  imgData.data.set(result.diffRgba);
  outCtx.putImageData(imgData, 0, 0);

  return {
    ...result,
    heatmapDataUrl: outCanvas.toDataURL('image/png'),
  };
}
