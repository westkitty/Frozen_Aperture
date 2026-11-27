/**
 * Frozen Aperture — Source-Derived Vertex Color Projection Baker (#10)
 * Projects mesh vertices through the calibrated sourceCamera onto the original
 * source illustration, sampling observed RGB for camera-facing vertices and
 * tagging occluded/rear vertices as 'inferred' with a neutral fallback tint.
 */

import * as THREE from 'three';

/**
 * Bakes source-derived vertex colors onto all meshes inside `rootGroup`.
 * Returns { observedVertices, inferredVertices, totalVertices, observedRatio }.
 */
export function bakeSourceVertexColors(rootGroup, sourceImageData, sourceCameraSpec) {
  if (!rootGroup || !sourceImageData || !sourceCameraSpec) {
    throw new Error('bakeSourceVertexColors requires rootGroup, sourceImageData, and sourceCameraSpec.');
  }

  const { width, height, data } = sourceImageData;
  const cam = new THREE.PerspectiveCamera(
    sourceCameraSpec.fovDeg || 42,
    width / Math.max(1, height),
    sourceCameraSpec.near || 0.1,
    sourceCameraSpec.far || 200
  );
  cam.position.set(...(sourceCameraSpec.position || [0, 1.8, 12.5]));
  cam.lookAt(...(sourceCameraSpec.target || [0, 1.4, 0]));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const camDir = new THREE.Vector3();
  const worldPos = new THREE.Vector3();
  const worldNorm = new THREE.Vector3();
  const normalMat = new THREE.Matrix3();
  const projected = new THREE.Vector3();

  let observedVertices = 0;
  let inferredVertices = 0;

  rootGroup.updateMatrixWorld(true);
  rootGroup.traverse((child) => {
    if (!child.isMesh || child.userData.isCollisionHelper || !child.geometry) return;
    const geom = child.geometry;
    const posAttr = geom.attributes.position;
    if (!posAttr) return;
    if (!geom.attributes.normal) geom.computeVertexNormals();
    const normAttr = geom.attributes.normal;

    const count = posAttr.count;
    const colors = new Float32Array(count * 3);
    const surfaceClass = new Uint8Array(count); // 1 = observed, 0 = inferred
    normalMat.getNormalMatrix(child.matrixWorld);

    for (let i = 0; i < count; i++) {
      worldPos.fromBufferAttribute(posAttr, i).applyMatrix4(child.matrixWorld);
      worldNorm.fromBufferAttribute(normAttr, i).applyMatrix3(normalMat).normalize();

      // Vector from vertex toward camera
      camDir.subVectors(cam.position, worldPos).normalize();
      const facingCamera = worldNorm.dot(camDir) > 0.05;

      projected.copy(worldPos).project(cam);
      const u = (projected.x + 1) * 0.5;
      const v = (1 - projected.y) * 0.5;
      const inFrame = facingCamera && u >= 0 && u <= 1 && v >= 0 && v <= 1 && projected.z >= -1 && projected.z <= 1;

      if (inFrame) {
        const px = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
        const py = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
        const idx = (py * width + px) * 4;
        colors[i * 3] = data[idx] / 255;
        colors[i * 3 + 1] = data[idx + 1] / 255;
        colors[i * 3 + 2] = data[idx + 2] / 255;
        surfaceClass[i] = 1;
        observedVertices++;
      } else {
        // Honest neutral inferred shade for unseen rear/occluded vertices
        colors[i * 3] = 0.22;
        colors[i * 3 + 1] = 0.27;
        colors[i * 3 + 2] = 0.36;
        surfaceClass[i] = 0;
        inferredVertices++;
      }
    }

    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.userData.surfaceClassification = surfaceClass;
    if (child.material) {
      child.material.vertexColors = true;
      child.material.needsUpdate = true;
    }
  });

  const totalVertices = observedVertices + inferredVertices;
  return {
    observedVertices,
    inferredVertices,
    totalVertices,
    observedRatio: totalVertices > 0 ? Number((observedVertices / totalVertices).toFixed(4)) : 0,
  };
}
