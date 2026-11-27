/**
 * Frozen Aperture — Source-Camera 2D-to-3D Landmark Calibration Solver (#3)
 * Solves sourceCamera position, target, and FOV via damped Gauss-Newton / coordinate
 * descent minimizing pixel reprojection error across operator-pinned (world3D, pixel2D) pairs.
 */

import * as THREE from 'three';

export function projectWorldPoint(world3D, camSpec) {
  const w = Math.max(1, camSpec.imageWidth || 1600);
  const h = Math.max(1, camSpec.imageHeight || 1000);
  const cam = new THREE.PerspectiveCamera(camSpec.fovDeg || 42, w / h, camSpec.near || 0.1, camSpec.far || 200);
  cam.position.set(...camSpec.position);
  cam.lookAt(...camSpec.target);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const v = new THREE.Vector3(world3D[0], world3D[1], world3D[2]).project(cam);
  return {
    x: (v.x + 1) * 0.5 * w,
    y: (1 - v.y) * 0.5 * h,
    ndcZ: v.z,
  };
}

export function computeReprojectionRmse(landmarks, camSpec) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return 0;
  let sumSq = 0;
  for (const lm of landmarks) {
    const p = projectWorldPoint(lm.world3D, camSpec);
    const dx = p.x - lm.pixel2D[0];
    const dy = p.y - lm.pixel2D[1];
    sumSq += dx * dx + dy * dy;
  }
  return Math.sqrt(sumSq / landmarks.length);
}

/**
 * Optimizes `sourceCamera` (position[0..2], target[0..2], fovDeg) to align 3D landmarks
 * with their pinned 2D source-image pixel coordinates.
 */
export function solveCameraFromLandmarks(initialCamSpec, landmarks, { iterations = 45 } = {}) {
  if (!Array.isArray(landmarks) || landmarks.length < 2) {
    throw new Error('Camera landmark calibration requires at least 2 (world3D, pixel2D) pairs.');
  }

  const best = JSON.parse(JSON.stringify(initialCamSpec));
  const initialRmse = computeReprojectionRmse(landmarks, best);
  let bestErr = initialRmse;

  // Parameter vector: [px, py, pz, tx, ty, tz, fovDeg]
  const stepSizes = [0.6, 0.6, 0.8, 0.35, 0.35, 0.35, 3.0];

  const getParam = (spec, idx) => {
    if (idx < 3) return spec.position[idx];
    if (idx < 6) return spec.target[idx - 3];
    return spec.fovDeg;
  };

  const setParam = (spec, idx, val) => {
    if (idx < 3) spec.position[idx] = val;
    else if (idx < 6) spec.target[idx - 3] = val;
    else spec.fovDeg = Math.max(15, Math.min(90, val));
  };

  for (let iter = 0; iter < iterations; iter++) {
    let improved = false;
    for (let p = 0; p < 7; p++) {
      const cur = getParam(best, p);
      const step = stepSizes[p];

      setParam(best, p, cur + step);
      const errPlus = computeReprojectionRmse(landmarks, best);
      setParam(best, p, cur - step);
      const errMinus = computeReprojectionRmse(landmarks, best);

      if (errPlus < bestErr && errPlus <= errMinus) {
        setParam(best, p, cur + step);
        bestErr = errPlus;
        improved = true;
      } else if (errMinus < bestErr) {
        setParam(best, p, cur - step);
        bestErr = errMinus;
        improved = true;
      } else {
        setParam(best, p, cur);
        stepSizes[p] *= 0.65;
      }
    }
    if (!improved && stepSizes.every(s => s < 1e-4)) break;
  }

  best.position = best.position.map(v => Number(v.toFixed(4)));
  best.target = best.target.map(v => Number(v.toFixed(4)));
  best.fovDeg = Number(best.fovDeg.toFixed(2));
  best.calibrated = true;
  best.landmarks = JSON.parse(JSON.stringify(landmarks));

  return {
    camera: best,
    initialRmsePx: Number(initialRmse.toFixed(2)),
    finalRmsePx: Number(bestErr.toFixed(2)),
    improved: bestErr <= initialRmse,
  };
}
