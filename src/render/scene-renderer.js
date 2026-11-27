/**
 * Frozen Aperture — Three.js WebGL 2 Scene Renderer
 * Upgraded with:
 * - #9 Multi-component asset slot rendering (body/weapon/clothing/effect)
 * - #16 Interactive 3D TransformControls gizmos (translate/rotate/scale + snap)
 * - #17 Custom Glossy Black-Liquid GLSL Shader on Central Aperture
 * - #18 Render-state interpolation + bounded ribbon motion trails
 * - #19 True on-demand idle rendering (idleFramesSkipped telemetry)
 * - #23 Visible 3D selection highlight ring for keyboard/pointer cycling
 * - #24 InstancedMesh batching for high-count procedural fragment pools (114+ bodies)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { isTemporallyFrozen } from '../simulation/temporal-engine.js';
import { createBlackLiquidVortexMaterial } from './vortex-shader.js';
import { buildInflatedMeshData } from './volumetric-inflator.js';

export class SceneRenderer {
  constructor(container, { assetManager, onSelectObject = null, onObjectTap = null, onTransformCommit = null, onContextLost = null } = {}) {
    this.container = container;
    this.assetManager = assetManager;
    this.onSelectObject = onSelectObject;
    this.onObjectTap = onObjectTap;
    this.onTransformCommit = onTransformCommit;
    this.onContextLost = onContextLost;

    this.sceneDoc = null;
    this.projectDoc = null;
    this.selectedObjectId = null;
    this.isolatedObjectId = null;
    this.inspectionMode = 'shaded';
    this.showCollisionProxies = false;
    this.qualityTier = 'high';
    this.reducedMotion = false;
    this.experienceMode = 'frozen_second';

    this.objectMeshes = new Map();
    this.collisionHelpers = new Map();
    this.loadedAssetCache = new Map();
    this.textureCache = new Map();
    this.ripplePool = [];

    // (#24) Instanced fragment batches
    this.instancedBatches = new Map();   // shapeKey -> { mesh: THREE.InstancedMesh, ids: string[] }
    this.instancedObjectMap = new Map(); // objectId -> { shapeKey, index, baseColor }
    this._dummy = new THREE.Object3D();

    // (#18) Bounded motion trails for active high-speed bodies
    this.trailMap = new Map(); // objectId -> { line: THREE.Line, positions: Float32Array, count: number }

    // (#17) Custom black-liquid vortex shader material
    this.vortexShaderMat = createBlackLiquidVortexMaterial();

    // (#19) On-demand idle rendering state
    this.dirty = true;
    this.cameraMoving = false;
    this.idleFramesSkipped = 0;
    this.framesRendered = 0;

    this.gltfLoader = new GLTFLoader();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.activePointers = new Set();
    this.pointerDownPos = null;
    this.pointerDownTime = 0;

    this.clayMaterial = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.78, metalness: 0.05 });
    this.wireframeMaterial = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true });
    this.collisionWireMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, wireframe: true, transparent: true, opacity: 0.65 });

    this.initRenderer();
    this.initScene();
    this.initGizmoAndSelection();
    this.initRipplePool();
    this.bindInput();
  }

  markDirty() {
    this.dirty = true;
  }

  initRenderer() {
    const w = Math.max(320, this.container.clientWidth || 1024);
    const h = Math.max(240, this.container.clientHeight || 640);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';

    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this.onContextLost) this.onContextLost(true);
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.markDirty();
      if (this.onContextLost) this.onContextLost(false);
    });

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200);
    this.camera.position.set(0, 1.8, 12.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxDistance = 42;
    this.controls.minDistance = 1.2;
    this.controls.target.set(0, 1.4, 0);
    this.controls.addEventListener('start', () => { this.cameraMoving = true; this.markDirty(); });
    this.controls.addEventListener('change', () => { this.markDirty(); });
    this.controls.addEventListener('end', () => { this.cameraMoving = false; this.markDirty(); });
    this.controls.update();
  }

  initScene() {
    this.threeScene = new THREE.Scene();
    this.threeScene.background = new THREE.Color(0x05070c);
    this.threeScene.fog = new THREE.FogExp2(0x05070c, 0.022);

    this.ambientLight = new THREE.HemisphereLight(0x8bb8e8, 0x0b1020, 0.65);
    this.threeScene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xe0f2fe, 2.1);
    this.keyLight.position.set(6, 12, 8);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 36;
    const d = 10;
    this.keyLight.shadow.camera.left = -d;
    this.keyLight.shadow.camera.right = d;
    this.keyLight.shadow.camera.top = d;
    this.keyLight.shadow.camera.bottom = -d;
    this.threeScene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0x38bdf8, 1.25);
    this.rimLight.position.set(-8, 6, -9);
    this.threeScene.add(this.rimLight);

    this.accentLight = new THREE.PointLight(0x6366f1, 1.8, 18);
    this.accentLight.position.set(0, 2.8, 0);
    this.threeScene.add(this.accentLight);

    const floorGeo = new THREE.CircleGeometry(28, 64);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x070b14, roughness: 0.22, metalness: 0.78 });
    this.floor = new THREE.Mesh(floorGeo, floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.threeScene.add(this.floor);

    this.gridHelper = new THREE.PolarGridHelper(12, 12, 6, 64, 0x1e293b, 0x0f172a);
    this.gridHelper.position.y = 0.005;
    this.threeScene.add(this.gridHelper);

    this.worldRoot = new THREE.Group();
    this.threeScene.add(this.worldRoot);

    this.trailRoot = new THREE.Group();
    this.threeScene.add(this.trailRoot);
  }

  /**
   * (#16) TransformControls gizmo + (#23) 3D selection highlight ring.
   */
  initGizmoAndSelection() {
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.enabled = false;
    const gizmoHelper = typeof this.gizmo.getHelper === 'function' ? this.gizmo.getHelper() : this.gizmo;
    if (gizmoHelper) {
      gizmoHelper.visible = false;
      this.threeScene.add(gizmoHelper);
    }
    this.gizmoHelper = gizmoHelper;
    this.gizmoSnap = false;

    this.gizmo.addEventListener('dragging-changed', (ev) => {
      this.controls.enabled = !ev.value;
      this.markDirty();
    });
    this.gizmo.addEventListener('objectChange', () => {
      this.markDirty();
      const target = this.gizmo.object;
      const objId = target?.userData?.sceneObjectId;
      if (!objId || !this.sceneDoc) return;
      const obj = this.sceneDoc.objects.find(o => o.id === objId);
      if (!obj) return;
      obj.position = [Number(target.position.x.toFixed(3)), Number(target.position.y.toFixed(3)), Number(target.position.z.toFixed(3))];
      obj.rotation = [Number(target.rotation.x.toFixed(3)), Number(target.rotation.y.toFixed(3)), Number(target.rotation.z.toFixed(3))];
      obj.scale = [Math.max(0.05, Number(target.scale.x.toFixed(3))), Math.max(0.05, Number(target.scale.y.toFixed(3))), Math.max(0.05, Number(target.scale.z.toFixed(3)))];
      if (this.onTransformCommit) this.onTransformCommit(obj);
    });

    // (#23) Visible 3D selection ring
    const ringGeo = new THREE.RingGeometry(0.58, 0.66, 36);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.visible = false;
    this.threeScene.add(this.selectionRing);
  }

  setGizmoEnabled(enabled, mode = 'translate', snap = this.gizmoSnap) {
    this.gizmo.enabled = Boolean(enabled);
    this.gizmoSnap = Boolean(snap);
    this.gizmo.setMode(mode);
    this.gizmo.setTranslationSnap(this.gizmoSnap ? 0.25 : null);
    this.gizmo.setRotationSnap(this.gizmoSnap ? THREE.MathUtils.degToRad(15) : null);
    this.gizmo.setScaleSnap(this.gizmoSnap ? 0.1 : null);
    if (this.gizmoHelper) this.gizmoHelper.visible = Boolean(enabled) && Boolean(this.gizmo.object);
    if (enabled && this.selectedObjectId) {
      this.attachGizmoToObject(this.selectedObjectId);
    } else if (!enabled) {
      this.gizmo.detach();
    }
    this.markDirty();
  }

  attachGizmoToObject(objectId) {
    let group = this.objectMeshes.get(objectId);
    if (!group && objectId && this.instancedObjectMap.has(objectId) && this.gizmo.enabled) {
      const obj = this.sceneDoc?.objects?.find(o => o.id === objectId);
      if (obj) {
        this.upsertObjectMesh(obj).then(() => {
          const promoted = this.objectMeshes.get(objectId);
          if (promoted && this.gizmo.enabled && this.selectedObjectId === objectId) {
            this.gizmo.attach(promoted);
            if (this.gizmoHelper) this.gizmoHelper.visible = true;
            this.markDirty();
          }
        });
        return;
      }
    }
    if (group && this.gizmo.enabled) {
      this.gizmo.attach(group);
      if (this.gizmoHelper) this.gizmoHelper.visible = true;
    } else {
      this.gizmo.detach();
      if (this.gizmoHelper) this.gizmoHelper.visible = false;
    }
    this.markDirty();
  }

  setSelectedObject(objectId) {
    this.selectedObjectId = objectId || null;
    if (this.gizmo.enabled) this.attachGizmoToObject(this.selectedObjectId);
    this.updateSelectionRing();
    this.markDirty();
  }

  updateSelectionRing() {
    if (!this.selectedObjectId || !this.sceneDoc) {
      this.selectionRing.visible = false;
      return;
    }
    const obj = this.sceneDoc.objects.find(o => o.id === this.selectedObjectId);
    if (!obj || obj.visible === false) {
      this.selectionRing.visible = false;
      return;
    }
    const r = (obj.collision?.radius ?? 0.45) * Math.max(obj.scale?.[0] ?? 1, obj.scale?.[2] ?? 1);
    this.selectionRing.position.set(obj.position[0], Math.max(0.03, obj.position[1] - r), obj.position[2]);
    this.selectionRing.scale.setScalar(Math.max(0.7, r * 1.4));
    this.selectionRing.visible = true;
  }

  initRipplePool() {
    const geo = new THREE.RingGeometry(0.18, 0.26, 28);
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.threeScene.add(mesh);
      this.ripplePool.push({ mesh, age: 0, maxAge: 0.55, active: false });
    }
  }

  spawnRipple(position, color = 0x38bdf8) {
    if (this.qualityTier === 'economy' || this.reducedMotion) return;
    const slot = this.ripplePool.find(r => !r.active) || this.ripplePool[0];
    slot.active = true;
    slot.age = 0;
    slot.mesh.visible = true;
    slot.mesh.position.set(position[0], position[1], position[2]);
    slot.mesh.lookAt(this.camera.position);
    slot.mesh.scale.setScalar(1);
    slot.mesh.material.color.setHex(color);
    slot.mesh.material.opacity = 0.85;
    this.markDirty();
  }

  bindInput() {
    const dom = this.renderer.domElement;

    dom.addEventListener('pointerdown', (e) => {
      this.activePointers.add(e.pointerId);
      if (this.activePointers.size === 1 && e.button === 0 && !this.gizmo.dragging) {
        this.pointerDownPos = { x: e.clientX, y: e.clientY };
        this.pointerDownTime = performance.now();
      } else {
        this.pointerDownPos = null;
      }
    });

    dom.addEventListener('pointercancel', (e) => {
      this.activePointers.delete(e.pointerId);
      this.pointerDownPos = null;
    });

    dom.addEventListener('pointerup', (e) => {
      const wasSinglePointer = this.activePointers.size === 1;
      this.activePointers.delete(e.pointerId);
      if (!wasSinglePointer || !this.pointerDownPos || this.gizmo.dragging) return;

      const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
      const elapsed = performance.now() - this.pointerDownTime;
      this.pointerDownPos = null;

      if (dist > 6 || elapsed > 450) return;

      const hitId = this.pickObjectAt(e.clientX, e.clientY);
      if (hitId) {
        this.setSelectedObject(hitId);
        if (this.onSelectObject) this.onSelectObject(hitId);
        if (this.onObjectTap) this.onObjectTap(hitId);
      }
    });
  }

  pickObjectAt(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const targets = [];
    for (const group of this.objectMeshes.values()) {
      if (group.visible) targets.push(group);
    }
    for (const batch of this.instancedBatches.values()) {
      if (batch.mesh.visible) targets.push(batch.mesh);
    }

    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      if (hit.object.isInstancedMesh && hit.instanceId !== undefined) {
        const shapeKey = hit.object.userData.instancedShapeKey;
        const batch = this.instancedBatches.get(shapeKey);
        const objId = batch?.ids?.[hit.instanceId];
        if (objId) return objId;
      }
      let cur = hit.object;
      while (cur) {
        if (cur.userData && cur.userData.sceneObjectId) return cur.userData.sceneObjectId;
        cur = cur.parent;
      }
    }
    return null;
  }

  setQualityTier(tier) {
    this.qualityTier = tier;
    if (tier === 'high') {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.keyLight.castShadow = true;
    } else if (tier === 'balanced') {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.shadowMap.enabled = true;
      this.keyLight.castShadow = false;
    } else {
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = false;
      this.keyLight.castShadow = false;
      this.clearTrails();
    }
    this.markDirty();
  }

  setReducedMotion(flag) {
    this.reducedMotion = Boolean(flag);
    this.controls.enableDamping = !this.reducedMotion;
    if (this.reducedMotion) this.clearTrails();
    this.markDirty();
  }

  setInspectionMode(mode) {
    this.inspectionMode = mode;
    for (const group of this.objectMeshes.values()) {
      this.applyInspectionMaterial(group);
    }
    for (const batch of this.instancedBatches.values()) {
      if (!batch.mesh.userData.originalMaterial) batch.mesh.userData.originalMaterial = batch.mesh.material;
      if (mode === 'clay') batch.mesh.material = this.clayMaterial;
      else if (mode === 'wireframe') batch.mesh.material = this.wireframeMaterial;
      else batch.mesh.material = batch.mesh.userData.originalMaterial;
    }
    this.markDirty();
  }

  setShowCollisionProxies(show) {
    this.showCollisionProxies = Boolean(show);
    for (const helper of this.collisionHelpers.values()) helper.visible = this.showCollisionProxies;
    this.markDirty();
  }

  setIsolatedObject(objectId) {
    this.isolatedObjectId = objectId || null;
    this.syncVisibility();
    this.markDirty();
  }

  syncVisibility() {
    if (!this.sceneDoc) return;
    for (const obj of this.sceneDoc.objects) {
      const group = this.objectMeshes.get(obj.id);
      if (group) {
        const baseVis = obj.visible !== false;
        group.visible = this.isolatedObjectId ? (obj.id === this.isolatedObjectId) : baseVis;
      }
    }
    for (const batch of this.instancedBatches.values()) {
      batch.mesh.visible = !this.isolatedObjectId || batch.ids.includes(this.isolatedObjectId);
    }
  }

  applyInspectionMaterial(group) {
    group.traverse((child) => {
      if (!child.isMesh || child.userData.isCollisionHelper) return;
      if (!child.userData.originalMaterial) child.userData.originalMaterial = child.material;
      if (this.inspectionMode === 'clay') child.material = this.clayMaterial;
      else if (this.inspectionMode === 'wireframe') child.material = this.wireframeMaterial;
      else child.material = child.userData.originalMaterial;
    });
  }

  isInstancingEligible(obj) {
    return (
      !obj.isVortex &&
      obj.category === 'fragment' &&
      obj.representationType === 'procedural_geometry' &&
      !obj.assetId &&
      (!obj.components || Object.keys(obj.components).length === 0)
    );
  }

  async loadScene(projectDoc, sceneDoc) {
    this.projectDoc = projectDoc;
    this.sceneDoc = sceneDoc;
    this.clearWorld();

    const floorY = sceneDoc.simulation?.floorY ?? 0;
    if (this.floor) this.floor.position.y = floorY;
    if (this.gridHelper) this.gridHelper.position.y = floorY + 0.005;

    if (sceneDoc.cameras?.sourceCamera) {
      this.applyCameraPose(sceneDoc.cameras.sourceCamera);
    }

    const bgRep = sceneDoc.environment?.backgroundRepresentation;
    if (bgRep?.dataUrl) {
      this.setBackgroundPlate(bgRep.dataUrl, {
        width: bgRep.worldWidth,
        height: bgRep.worldHeight,
        position: bgRep.worldPosition,
      });
    } else {
      this.setBackgroundPlate(null);
    }

    // (#24) Partition fragments eligible for InstancedMesh batching vs unique objects
    const instancedBuckets = { sphere: [], box: [] };
    for (const obj of sceneDoc.objects) {
      if (this.isInstancingEligible(obj)) {
        const key = obj.collision?.shape === 'box' ? 'box' : 'sphere';
        instancedBuckets[key].push(obj);
      } else {
        await this.upsertObjectMesh(obj);
      }
    }

    this.buildInstancedBuckets(instancedBuckets);
    this.syncFromSimulation(0, null);
    this.markDirty();
  }

  demoteFromInstanced(objectId) {
    const ref = this.instancedObjectMap.get(objectId);
    if (!ref) return false;
    const batch = this.instancedBatches.get(ref.shapeKey);
    if (batch) {
      this._dummy.position.set(0, -9999, 0);
      this._dummy.scale.set(0, 0, 0);
      this._dummy.updateMatrix();
      batch.mesh.setMatrixAt(ref.index, this._dummy.matrix);
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.ids[ref.index] = null;
    }
    this.instancedObjectMap.delete(objectId);
    return true;
  }

  disposeGroupResources(group) {
    if (!group) return;
    const sharedMats = new Set([this.clayMaterial, this.wireframeMaterial, this.collisionWireMat, this.vortexShaderMat]);
    group.traverse((child) => {
      if (!child.isMesh) return;
      if (child.geometry) child.geometry.dispose();
      const orig = child.userData?.originalMaterial;
      if (orig && !sharedMats.has(orig) && typeof orig.dispose === 'function') orig.dispose();
      if (child.material && child.material !== orig && !sharedMats.has(child.material) && typeof child.material.dispose === 'function') {
        child.material.dispose();
      }
    });
  }

  resetVisualEffects() {
    this.clearTrails();
    for (const slot of this.ripplePool) {
      slot.active = false;
      slot.age = 0;
      slot.mesh.visible = false;
    }
    this.vortexShaderMat.uniforms.uTime.value = 0;
    this.vortexShaderMat.uniforms.uActive.value = 0;
    this.markDirty();
  }

  buildInstancedBuckets(buckets) {
    for (const [shapeKey, list] of Object.entries(buckets)) {
      if (list.length === 0) continue;
      const geo = shapeKey === 'box' ? new THREE.BoxGeometry(2, 2, 2) : new THREE.IcosahedronGeometry(1, 1);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.72 });
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.userData.instancedShapeKey = shapeKey;
      inst.userData.originalMaterial = mat;
      if (this.inspectionMode === 'clay') inst.material = this.clayMaterial;
      else if (this.inspectionMode === 'wireframe') inst.material = this.wireframeMaterial;

      const color = new THREE.Color();
      const ids = [];

      for (let i = 0; i < list.length; i++) {
        const obj = list[i];
        ids.push(obj.id);
        color.set(obj.material?.color || '#38bdf8');
        inst.setColorAt(i, color);
        this.instancedObjectMap.set(obj.id, { shapeKey, index: i, baseColor: obj.material?.color || '#38bdf8' });
      }
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      this.worldRoot.add(inst);
      this.instancedBatches.set(shapeKey, { mesh: inst, ids });
    }
  }

  clearTrails() {
    for (const t of this.trailMap.values()) {
      this.trailRoot.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
    }
    this.trailMap.clear();
  }

  clearWorld() {
    this.gizmo.detach();
    for (const group of this.objectMeshes.values()) {
      this.worldRoot.remove(group);
      this.disposeGroupResources(group);
    }
    this.objectMeshes.clear();
    this.collisionHelpers.clear();
    for (const batch of this.instancedBatches.values()) {
      this.worldRoot.remove(batch.mesh);
      batch.mesh.geometry.dispose();
      if (batch.mesh.userData?.originalMaterial) batch.mesh.userData.originalMaterial.dispose();
    }
    this.instancedBatches.clear();
    this.instancedObjectMap.clear();
    this.clearTrails();
    this.markDirty();
  }

  async upsertObjectMesh(obj) {
    // (#1) Prevent double-rendering if promoting an instanced fragment to a unique mesh/GLB
    this.demoteFromInstanced(obj.id);

    const existing = this.objectMeshes.get(obj.id);
    if (existing) {
      if (this.gizmo.object === existing) this.gizmo.detach();
      this.worldRoot.remove(existing);
      this.disposeGroupResources(existing);
      this.objectMeshes.delete(obj.id);
      this.collisionHelpers.delete(obj.id);
    }

    const group = new THREE.Group();
    group.userData.sceneObjectId = obj.id;

    if (obj.isVortex) {
      this.buildVortexVisual(group, obj);
    } else if (obj.components && Object.keys(obj.components).length > 0 && this.assetManager) {
      // (#9) Render multi-component asset slots independently
      let loadedAny = false;
      for (const [slotName, comp] of Object.entries(obj.components)) {
        if (!comp?.assetId) continue;
        const slotGroup = await this.loadGlbGroup(comp.assetId);
        if (slotGroup) {
          slotGroup.name = `component_${slotName}`;
          if (comp.position) slotGroup.position.set(...comp.position);
          if (comp.rotation) slotGroup.rotation.set(...comp.rotation);
          if (comp.scale) slotGroup.scale.set(...comp.scale);
          group.add(slotGroup);
          loadedAny = true;
        }
      }
      if (!loadedAny) this.buildProceduralVisual(group, obj);
    } else if (obj.representationType === 'source_image_layer' && obj.layerDataUrl) {
      this.buildSourceLayerVisual(group, obj);
    } else if (obj.assetId && this.assetManager) {
      const loaded = await this.loadGlbGroup(obj.assetId);
      if (loaded) group.add(loaded);
      else this.buildProceduralVisual(group, obj);
    } else {
      this.buildProceduralVisual(group, obj);
    }

    const colHelper = this.buildCollisionHelper(obj);
    colHelper.visible = this.showCollisionProxies;
    group.add(colHelper);
    this.collisionHelpers.set(obj.id, colHelper);

    this.applyInspectionMaterial(group);
    this.worldRoot.add(group);
    this.objectMeshes.set(obj.id, group);
    this.syncObjectTransform(obj, group, obj.position, obj.rotation);
    this.markDirty();
  }

  buildVortexVisual(group, obj) {
    // (#17) Custom Glossy Black-Liquid GLSL Shader Core
    const coreGeo = new THREE.SphereGeometry(0.72, 40, 40);
    const core = new THREE.Mesh(coreGeo, this.vortexShaderMat);
    core.castShadow = true;
    group.add(core);

    const ringGroup = new THREE.Group();
    ringGroup.name = 'vortex_rings';
    const ringRadii = [0.98, 1.28, 1.62];
    const ringColors = [0x38bdf8, 0x6366f1, 0x0ea5e9];
    for (let i = 0; i < ringRadii.length; i++) {
      const torusGeo = new THREE.TorusGeometry(ringRadii[i], 0.025 + (2 - i) * 0.008, 12, 64);
      const torusMat = new THREE.MeshStandardMaterial({
        color: 0x0b1220,
        emissive: ringColors[i],
        emissiveIntensity: 0.85,
        roughness: 0.15,
        metalness: 0.9,
      });
      const ring = new THREE.Mesh(torusGeo, torusMat);
      ring.rotation.x = Math.PI * 0.35 + i * 0.42;
      ring.rotation.y = i * 0.55;
      ringGroup.add(ring);
    }

    const dropGeo = new THREE.SphereGeometry(0.055, 12, 12);
    const dropMat = new THREE.MeshStandardMaterial({ color: 0x050914, emissive: 0x38bdf8, emissiveIntensity: 0.4, roughness: 0.1, metalness: 0.95 });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const r = 1.15 + (i % 3) * 0.28;
      const drop = new THREE.Mesh(dropGeo, dropMat);
      drop.position.set(Math.cos(a) * r, Math.sin(a * 2) * 0.32, Math.sin(a) * r);
      ringGroup.add(drop);
    }

    group.add(ringGroup);
    void obj;
  }

  buildSourceLayerVisual(group, obj) {
    const aspect = obj.layerAspect || 0.7;
    const h = obj.layerWorldHeight || 1.8;
    const w = obj.layerWorldWidth || (h * aspect);

    let tex = this.textureCache.get(obj.layerDataUrl);
    if (!tex) {
      tex = new THREE.TextureLoader().load(obj.layerDataUrl, () => this.markDirty());
      tex.colorSpace = THREE.SRGBColorSpace;
      this.textureCache.set(obj.layerDataUrl, tex);
    }

    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: 0xffffff,
      emissiveIntensity: 0.72,
      transparent: true,
      alphaTest: 0.08,
      side: THREE.DoubleSide,
      roughness: 0.55,
      metalness: 0.05,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.isSourceLayer = true;
    mesh.castShadow = true;
    group.add(mesh);

    // Optional opt-in 3D relief inflation only if explicitly requested
    if (obj.volumetricInflated && tex.image && tex.image.complete && tex.image.naturalWidth > 0) {
      const maxGrid = 44;
      const scale = Math.min(1, maxGrid / Math.max(tex.image.naturalWidth, tex.image.naturalHeight));
      const gw = Math.max(12, Math.round(tex.image.naturalWidth * scale));
      const gh = Math.max(12, Math.round(tex.image.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = gw; c.height = gh;
      const ctx = c.getContext('2d');
      ctx.drawImage(tex.image, 0, 0, gw, gh);
      const data = buildInflatedMeshData(ctx.getImageData(0, 0, gw, gh).data, gw, gh, w, h);
      if (data.triangleCount >= 4) {
        const volGeo = new THREE.BufferGeometry();
        volGeo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        volGeo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
        volGeo.setIndex(new THREE.BufferAttribute(data.indices, 1));
        volGeo.computeVertexNormals();
        mesh.geometry.dispose();
        mesh.geometry = volGeo;
      }
    }
  }

  async loadGlbGroup(assetId) {
    if (this.loadedAssetCache.has(assetId)) return this.loadedAssetCache.get(assetId).clone(true);
    const bytes = this.assetManager.getBytes(this.projectDoc, assetId);
    if (!bytes) return null;
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try {
      const gltf = await new Promise((resolve, reject) => this.gltfLoader.parse(ab, '', resolve, reject));
      const root = gltf.scene || new THREE.Group();
      root.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.geometry?.attributes?.color && child.material) child.material.vertexColors = true;
        }
      });
      this.loadedAssetCache.set(assetId, root);
      return root.clone(true);
    } catch (_) {
      return null;
    }
  }

  buildProceduralVisual(group, obj) {
    const col = obj.collision || { shape: 'sphere', radius: 0.4 };
    let geo;
    if (col.shape === 'capsule') geo = new THREE.CapsuleGeometry(col.radius || 0.4, (col.halfHeight || 0.5) * 2, 8, 16);
    else if (col.shape === 'box') {
      const [hx, hy, hz] = col.halfExtents || [0.35, 0.35, 0.35];
      geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    } else geo = new THREE.IcosahedronGeometry(col.radius || 0.32, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(obj.material?.color || '#38bdf8'),
      emissive: new THREE.Color(obj.material?.emissive || '#000000'),
      emissiveIntensity: 0.25,
      roughness: obj.material?.roughness ?? 0.35,
      metalness: obj.material?.metalness ?? 0.5,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  buildCollisionHelper(obj) {
    const col = obj.collision || { shape: 'sphere', radius: 0.4 };
    let geo;
    if (col.shape === 'box') {
      const [hx, hy, hz] = col.halfExtents || [0.35, 0.35, 0.35];
      geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    } else if (col.shape === 'capsule') geo = new THREE.CapsuleGeometry(col.radius || 0.4, (col.halfHeight || 0.5) * 2, 4, 8);
    else geo = new THREE.SphereGeometry(col.radius || 0.4, 12, 8);
    const mesh = new THREE.Mesh(geo, this.collisionWireMat);
    mesh.userData.isCollisionHelper = true;
    return mesh;
  }

  syncObjectTransform(obj, group, pos, rot) {
    group.position.set(pos[0], pos[1], pos[2]);
    group.rotation.set(rot[0], rot[1], rot[2]);
    group.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
  }

  updateTrail(obj, pos) {
    if (this.qualityTier === 'economy' || this.reducedMotion || isTemporallyFrozen(obj.temporalState)) return;
    const speed = Math.hypot(obj.velocity[0], obj.velocity[1], obj.velocity[2]);
    if (speed < 1.2) return;

    const MAX_PTS = 14;
    let t = this.trailMap.get(obj.id);
    if (!t) {
      if (this.trailMap.size >= 24) return; // Bounded trail pool
      const positions = new Float32Array(MAX_PTS * 3);
      for (let i = 0; i < MAX_PTS; i++) {
        positions[i * 3] = pos[0];
        positions[i * 3 + 1] = pos[1];
        positions[i * 3 + 2] = pos[2];
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({ color: obj.material?.color || 0x38bdf8, transparent: true, opacity: 0.55 });
      const line = new THREE.Line(geo, mat);
      this.trailRoot.add(line);
      t = { line, positions };
      this.trailMap.set(obj.id, t);
    }
    // Shift ring buffer
    for (let i = MAX_PTS - 1; i > 0; i--) {
      t.positions[i * 3] = t.positions[(i - 1) * 3];
      t.positions[i * 3 + 1] = t.positions[(i - 1) * 3 + 1];
      t.positions[i * 3 + 2] = t.positions[(i - 1) * 3 + 2];
    }
    t.positions[0] = pos[0];
    t.positions[1] = pos[1];
    t.positions[2] = pos[2];
    t.line.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * Syncs renderer from canonical scene state with (#18) render-state interpolation,
   * (#17) temporal-gated vortex shader time, (#24) instanced batch updates, and (#19) dirty detection.
   */
  syncFromSimulation(dt = 0, simEngine = null) {
    if (!this.sceneDoc) return false;
    let anyActive = false;

    for (const obj of this.sceneDoc.objects) {
      const isActive = obj.temporalState === 'active';
      if (isActive) anyActive = true;

      const xform = simEngine ? simEngine.getInterpolatedTransform(obj) : { position: obj.position, rotation: obj.rotation };

      // (#24) Instanced fragment update with per-instance active/frozen/selected brightness encoding
      const instRef = this.instancedObjectMap.get(obj.id);
      if (instRef) {
        const batch = this.instancedBatches.get(instRef.shapeKey);
        if (batch) {
          const vis = obj.visible !== false && (!this.isolatedObjectId || this.isolatedObjectId === obj.id);
          const r = obj.collision?.shape === 'box'
            ? (obj.collision.halfExtents?.[0] ?? 0.2)
            : (obj.collision?.radius ?? 0.2);
          this._dummy.position.set(xform.position[0], xform.position[1], xform.position[2]);
          this._dummy.rotation.set(xform.rotation[0], xform.rotation[1], xform.rotation[2]);
          this._dummy.scale.set(
            vis ? r * (obj.scale?.[0] ?? 1) : 0,
            vis ? r * (obj.scale?.[1] ?? 1) : 0,
            vis ? r * (obj.scale?.[2] ?? 1) : 0
          );
          this._dummy.updateMatrix();
          batch.mesh.setMatrixAt(instRef.index, this._dummy.matrix);
          batch.mesh.instanceMatrix.needsUpdate = true;

          // Only update GPU instanceColor buffer when temporal/selection state actually changes
          const visualKey = `${isActive ? 'a' : 'f'}:${this.selectedObjectId === obj.id ? 's' : 'n'}`;
          if (instRef.lastVisualKey !== visualKey) {
            instRef.lastVisualKey = visualKey;
            if (!this._tmpColor) this._tmpColor = new THREE.Color();
            if (!this._highlightColor) this._highlightColor = new THREE.Color(0x7dd3fc);
            this._tmpColor.set(instRef.baseColor);
            if (this.selectedObjectId === obj.id) {
              this._tmpColor.lerp(this._highlightColor, 0.45);
            } else if (isActive) {
              this._tmpColor.multiplyScalar(1.32);
            } else {
              this._tmpColor.multiplyScalar(0.82);
            }
            batch.mesh.setColorAt(instRef.index, this._tmpColor);
            if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
          }
        }
        if (isActive) this.updateTrail(obj, xform.position);
        continue;
      }

      const group = this.objectMeshes.get(obj.id);
      if (!group) continue;
      if (!this.gizmo.dragging || this.gizmo.object !== group) {
        this.syncObjectTransform(obj, group, xform.position, xform.rotation);
      }

      if (obj.isVortex) {
        const activeNow = !isTemporallyFrozen(obj.temporalState);
        this.vortexShaderMat.uniforms.uActive.value = activeNow ? 1.0 : 0.0;
        if (activeNow && !this.reducedMotion) {
          this.vortexShaderMat.uniforms.uTime.value += dt;
          const rings = group.getObjectByName('vortex_rings');
          if (rings) {
            rings.rotation.z += dt * 1.1;
            rings.rotation.y += dt * 0.65;
          }
        }
      } else if (isActive) {
        this.updateTrail(obj, xform.position);
      }

      if (this.inspectionMode === 'shaded' && !obj.isVortex) {
        const isFrozen = isTemporallyFrozen(obj.temporalState);
        group.traverse((child) => {
          if (child.isMesh && !child.userData.isCollisionHelper && child.material?.emissiveIntensity !== undefined) {
            if (child.userData.isSourceLayer) {
              child.material.emissiveIntensity = isFrozen ? 0.45 : 0.72;
            } else {
              child.material.emissiveIntensity = isFrozen ? 0.16 : 0.42;
            }
          }
        });
      }
    }

    let anyRipples = false;
    for (const slot of this.ripplePool) {
      if (!slot.active) continue;
      anyRipples = true;
      slot.age += dt;
      if (slot.age >= slot.maxAge) {
        slot.active = false;
        slot.mesh.visible = false;
      } else {
        const t = slot.age / slot.maxAge;
        slot.mesh.scale.setScalar(1 + t * 5.2);
        slot.mesh.material.opacity = (1 - t) * 0.75;
        slot.mesh.lookAt(this.camera.position);
      }
    }

    if (anyActive || anyRipples) this.markDirty();
    this.updateSelectionRing();
    return anyActive || anyRipples;
  }

  applyCameraPose(pose) {
    if (!pose) return;
    if (pose.fovDeg) {
      this.camera.fov = pose.fovDeg;
      this.camera.updateProjectionMatrix();
    }
    if (pose.position) this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    if (pose.target) this.controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
    this.controls.update();
    this.markDirty();
  }

  focusObject(objectId) {
    const obj = this.sceneDoc?.objects.find(o => o.id === objectId);
    if (!obj) return;
    this.controls.target.set(obj.position[0], obj.position[1], obj.position[2]);
    this.camera.position.set(obj.position[0] + 2.4, obj.position[1] + 1.2, obj.position[2] + 3.2);
    this.controls.update();
    this.markDirty();
  }

  getCameraPose() {
    return {
      position: [Number(this.camera.position.x.toFixed(3)), Number(this.camera.position.y.toFixed(3)), Number(this.camera.position.z.toFixed(3))],
      target: [Number(this.controls.target.x.toFixed(3)), Number(this.controls.target.y.toFixed(3)), Number(this.controls.target.z.toFixed(3))],
      fovDeg: this.camera.fov,
    };
  }

  resize() {
    const w = Math.max(320, this.container.clientWidth || 1024);
    const h = Math.max(240, this.container.clientHeight || 640);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.markDirty();
  }

  /**
   * (#19) On-demand idle rendering: skips WebGL draw pass when completely static.
   */
  renderFrame(force = false) {
    const controlsMoved = this.controls.update();
    if (!force && !this.dirty && !this.cameraMoving && !controlsMoved) {
      this.idleFramesSkipped++;
      return false;
    }
    this.renderer.render(this.threeScene, this.camera);
    this.framesRendered++;
    this.dirty = false;
    return true;
  }

  getTelemetry() {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      qualityTier: this.qualityTier,
      inspectionMode: this.inspectionMode,
      objectCount: this.sceneDoc?.objects?.length || 0,
      instancedCount: this.instancedObjectMap.size,
      idleFramesSkipped: this.idleFramesSkipped,
      framesRendered: this.framesRendered,
    };
  }

  setBackgroundPlate(dataUrl, options = {}) {
    if (this.bgBackdropMesh) {
      this.threeScene.remove(this.bgBackdropMesh);
      this.bgBackdropMesh.geometry.dispose();
      if (this.bgBackdropMesh.material.map) this.bgBackdropMesh.material.map.dispose();
      this.bgBackdropMesh.material.dispose();
      this.bgBackdropMesh = null;
    }
    if (!dataUrl) {
      this.markDirty();
      return;
    }
    const width = options.width || 22;
    const height = options.height || 13.75;
    const pos = Array.isArray(options.position) && options.position.length === 3 ? options.position : [0, 4.2, -9.5];
    const tex = new THREE.TextureLoader().load(dataUrl, () => this.markDirty());
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(width, height);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, depthWrite: false, fog: false });
    this.bgBackdropMesh = new THREE.Mesh(geo, mat);
    this.bgBackdropMesh.position.set(pos[0], pos[1], pos[2]);
    this.threeScene.add(this.bgBackdropMesh);
    this.markDirty();
  }

  dispose() {
    this.gizmo.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    for (const tex of this.textureCache.values()) tex.dispose();
    this.textureCache.clear();
    this.loadedAssetCache.clear();
  }
}
