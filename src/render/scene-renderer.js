/**
 * Frozen Aperture — Three.js WebGL 2 Scene Renderer
 * Consumes canonical scene state without owning simulation state.
 * Features:
 * - Genuine offline GLB parsing (GLTFLoader.parse from validated bytes)
 * - Glossy black-liquid Central Aperture vortex that strictly obeys temporalState
 * - Shaded, Clay, Wireframe, and Collision Proxy inspection modes
 * - Source-camera calibration, named views, isolate/focus, reference overlay
 * - Tap-vs-drag/pinch gesture disambiguation
 * - Bounded VFX ripple pool, DPR capping, quality tiers (high/balanced/economy), reduced-motion
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { isTemporallyFrozen } from '../simulation/temporal-engine.js';

export class SceneRenderer {
  constructor(container, { assetManager, onSelectObject = null, onObjectTap = null, onContextLost = null } = {}) {
    this.container = container;
    this.assetManager = assetManager;
    this.onSelectObject = onSelectObject;
    this.onObjectTap = onObjectTap;
    this.onContextLost = onContextLost;

    this.sceneDoc = null;
    this.projectDoc = null;
    this.selectedObjectId = null;
    this.isolatedObjectId = null;
    this.inspectionMode = 'shaded'; // shaded | clay | wireframe
    this.showCollisionProxies = false;
    this.qualityTier = 'high'; // high | balanced | economy
    this.reducedMotion = false;
    this.experienceMode = 'frozen_second';

    this.objectMeshes = new Map();       // objectId -> THREE.Group
    this.collisionHelpers = new Map();   // objectId -> THREE.Mesh
    this.loadedAssetCache = new Map();   // assetId -> THREE.Group template
    this.textureCache = new Map();       // dataUrl -> THREE.Texture
    this.ripplePool = [];

    this.gltfLoader = new GLTFLoader();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.activePointers = new Set();
    this.pointerDownPos = null;
    this.pointerDownTime = 0;

    // Shared materials (reused across objects to minimize GPU allocations)
    this.clayMaterial = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.78,
      metalness: 0.05,
    });
    this.wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
    });
    this.collisionWireMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      wireframe: true,
      transparent: true,
      opacity: 0.65,
    });

    this.initRenderer();
    this.initScene();
    this.initRipplePool();
    this.bindInput();
  }

  initRenderer() {
    const w = Math.max(320, this.container.clientWidth || 1024);
    const h = Math.max(240, this.container.clientHeight || 640);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // Enables reliable screenshot QA capture
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
    this.controls.update();
  }

  initScene() {
    this.threeScene = new THREE.Scene();
    this.threeScene.background = new THREE.Color(0x05070c);
    this.threeScene.fog = new THREE.FogExp2(0x05070c, 0.022);

    // Speculative dark architectural lighting rig
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

    // Reflective dark obsidian architectural floor
    const floorGeo = new THREE.CircleGeometry(28, 64);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x070b14,
      roughness: 0.22,
      metalness: 0.78,
    });
    this.floor = new THREE.Mesh(floorGeo, floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.threeScene.add(this.floor);

    // Subtle spatial calibration grid ring on the floor
    this.gridHelper = new THREE.PolarGridHelper(12, 12, 6, 64, 0x1e293b, 0x0f172a);
    this.gridHelper.position.y = 0.005;
    this.threeScene.add(this.gridHelper);

    this.worldRoot = new THREE.Group();
    this.threeScene.add(this.worldRoot);
  }

  initRipplePool() {
    const geo = new THREE.RingGeometry(0.18, 0.26, 28);
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
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
  }

  bindInput() {
    const dom = this.renderer.domElement;

    dom.addEventListener('pointerdown', (e) => {
      this.activePointers.add(e.pointerId);
      if (this.activePointers.size === 1 && e.button === 0) {
        this.pointerDownPos = { x: e.clientX, y: e.clientY };
        this.pointerDownTime = performance.now();
      } else {
        // Multi-touch pinch/pan: cancel tap detection
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
      if (!wasSinglePointer || !this.pointerDownPos) return;

      const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
      const elapsed = performance.now() - this.pointerDownTime;
      this.pointerDownPos = null;

      // Strict tap-vs-drag threshold: camera drags NEVER accidentally trigger object release
      if (dist > 6 || elapsed > 450) return;

      const hitId = this.pickObjectAt(e.clientX, e.clientY);
      if (hitId) {
        this.selectedObjectId = hitId;
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
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      let cur = hit.object;
      while (cur) {
        if (cur.userData && cur.userData.sceneObjectId) {
          return cur.userData.sceneObjectId;
        }
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
      // economy
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = false;
      this.keyLight.castShadow = false;
    }
  }

  setReducedMotion(flag) {
    this.reducedMotion = Boolean(flag);
    this.controls.enableDamping = !this.reducedMotion;
  }

  setInspectionMode(mode) {
    this.inspectionMode = mode;
    for (const group of this.objectMeshes.values()) {
      this.applyInspectionMaterial(group);
    }
  }

  setShowCollisionProxies(show) {
    this.showCollisionProxies = Boolean(show);
    for (const helper of this.collisionHelpers.values()) {
      helper.visible = this.showCollisionProxies;
    }
  }

  setIsolatedObject(objectId) {
    this.isolatedObjectId = objectId || null;
    this.syncVisibility();
  }

  syncVisibility() {
    if (!this.sceneDoc) return;
    for (const obj of this.sceneDoc.objects) {
      const group = this.objectMeshes.get(obj.id);
      if (!group) continue;
      const baseVis = obj.visible !== false;
      group.visible = this.isolatedObjectId ? (obj.id === this.isolatedObjectId) : baseVis;
    }
  }

  applyInspectionMaterial(group) {
    group.traverse((child) => {
      if (!child.isMesh || child.userData.isCollisionHelper) return;
      if (!child.userData.originalMaterial) {
        child.userData.originalMaterial = child.material;
      }
      if (this.inspectionMode === 'clay') {
        child.material = this.clayMaterial;
      } else if (this.inspectionMode === 'wireframe') {
        child.material = this.wireframeMaterial;
      } else {
        child.material = child.userData.originalMaterial;
      }
    });
  }

  async loadScene(projectDoc, sceneDoc) {
    this.projectDoc = projectDoc;
    this.sceneDoc = sceneDoc;
    this.clearWorld();

    if (sceneDoc.cameras?.sourceCamera) {
      this.applyCameraPose(sceneDoc.cameras.sourceCamera);
    }

    for (const obj of sceneDoc.objects) {
      await this.upsertObjectMesh(obj);
    }
    this.syncFromSimulation();
  }

  clearWorld() {
    for (const group of this.objectMeshes.values()) {
      this.worldRoot.remove(group);
    }
    this.objectMeshes.clear();
    this.collisionHelpers.clear();
  }

  async upsertObjectMesh(obj) {
    const existing = this.objectMeshes.get(obj.id);
    if (existing) {
      this.worldRoot.remove(existing);
      this.objectMeshes.delete(obj.id);
      this.collisionHelpers.delete(obj.id);
    }

    const group = new THREE.Group();
    group.userData.sceneObjectId = obj.id;

    if (obj.isVortex) {
      this.buildVortexVisual(group, obj);
    } else if (obj.representationType === 'source_image_layer' && obj.layerDataUrl) {
      this.buildSourceLayerVisual(group, obj);
    } else if (obj.assetId && this.assetManager) {
      const loaded = await this.loadGlbGroup(obj.assetId);
      if (loaded) {
        group.add(loaded);
      } else {
        this.buildProceduralVisual(group, obj);
      }
    } else {
      this.buildProceduralVisual(group, obj);
    }

    // Build collision proxy helper
    const colHelper = this.buildCollisionHelper(obj);
    colHelper.visible = this.showCollisionProxies;
    group.add(colHelper);
    this.collisionHelpers.set(obj.id, colHelper);

    this.applyInspectionMaterial(group);
    this.worldRoot.add(group);
    this.objectMeshes.set(obj.id, group);
    this.syncObjectTransform(obj, group);
  }

  buildVortexVisual(group, obj) {
    // Glossy black-liquid obsidian core
    const coreGeo = new THREE.SphereGeometry(0.72, 36, 36);
    const coreMat = new THREE.MeshPhysicalMaterial({
      color: 0x03050a,
      roughness: 0.06,
      metalness: 0.94,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      emissive: 0x0c2442,
      emissiveIntensity: 0.55,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.castShadow = true;
    group.add(core);

    // Layered curved tendril rings (strictly animated ONLY when obj.temporalState === 'active')
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

    // Suspended black-liquid droplets around the aperture
    const dropGeo = new THREE.SphereGeometry(0.055, 12, 12);
    const dropMat = new THREE.MeshStandardMaterial({
      color: 0x050914,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.4,
      roughness: 0.1,
      metalness: 0.95,
    });
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
    let tex = this.textureCache.get(obj.layerDataUrl);
    if (!tex) {
      tex = new THREE.TextureLoader().load(obj.layerDataUrl);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.textureCache.set(obj.layerDataUrl, tex);
    }
    const aspect = obj.layerAspect || 0.7;
    const h = 1.8;
    const w = h * aspect;
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.05,
      side: THREE.DoubleSide,
      roughness: 0.65,
      metalness: 0.08,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    group.add(mesh);
  }

  async loadGlbGroup(assetId) {
    if (this.loadedAssetCache.has(assetId)) {
      return this.loadedAssetCache.get(assetId).clone(true);
    }
    const bytes = this.assetManager.getBytes(this.projectDoc, assetId);
    if (!bytes) return null;

    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try {
      const gltf = await new Promise((resolve, reject) => {
        this.gltfLoader.parse(ab, '', resolve, reject);
      });
      const root = gltf.scene || new THREE.Group();
      root.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.geometry?.attributes?.color && child.material) {
            child.material.vertexColors = true;
          }
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
    if (col.shape === 'capsule') {
      geo = new THREE.CapsuleGeometry(col.radius || 0.4, (col.halfHeight || 0.5) * 2, 8, 16);
    } else if (col.shape === 'box') {
      const [hx, hy, hz] = col.halfExtents || [0.35, 0.35, 0.35];
      geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    } else {
      geo = new THREE.IcosahedronGeometry(col.radius || 0.32, 1);
    }
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
    } else if (col.shape === 'capsule') {
      geo = new THREE.CapsuleGeometry(col.radius || 0.4, (col.halfHeight || 0.5) * 2, 4, 8);
    } else {
      geo = new THREE.SphereGeometry(col.radius || 0.4, 12, 8);
    }
    const mesh = new THREE.Mesh(geo, this.collisionWireMat);
    mesh.userData.isCollisionHelper = true;
    return mesh;
  }

  syncObjectTransform(obj, group) {
    group.position.set(obj.position[0], obj.position[1], obj.position[2]);
    group.rotation.set(obj.rotation[0], obj.rotation[1], obj.rotation[2]);
    group.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
  }

  syncFromSimulation(dt = 0) {
    if (!this.sceneDoc) return;
    for (const obj of this.sceneDoc.objects) {
      const group = this.objectMeshes.get(obj.id);
      if (!group) continue;
      this.syncObjectTransform(obj, group);

      // Vortex internal ring motion strictly obeys temporalState
      if (obj.isVortex) {
        const rings = group.getObjectByName('vortex_rings');
        if (rings && !isTemporallyFrozen(obj.temporalState) && !this.reducedMotion) {
          rings.rotation.z += dt * 1.1;
          rings.rotation.y += dt * 0.65;
        }
      }

      // Subtle visual distinction between frozen and active in shaded mode
      if (this.inspectionMode === 'shaded' && !obj.isVortex) {
        const isFrozen = isTemporallyFrozen(obj.temporalState);
        group.traverse((child) => {
          if (child.isMesh && !child.userData.isCollisionHelper && child.material?.emissiveIntensity !== undefined) {
            child.material.emissiveIntensity = isFrozen ? 0.16 : 0.42;
          }
        });
      }
    }

    // Update bounded ripple pool
    for (const slot of this.ripplePool) {
      if (!slot.active) continue;
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
  }

  focusObject(objectId) {
    const obj = this.sceneDoc?.objects.find(o => o.id === objectId);
    if (!obj) return;
    this.controls.target.set(obj.position[0], obj.position[1], obj.position[2]);
    this.camera.position.set(obj.position[0] + 2.4, obj.position[1] + 1.2, obj.position[2] + 3.2);
    this.controls.update();
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
  }

  renderFrame() {
    this.controls.update();
    this.renderer.render(this.threeScene, this.camera);
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
      objectCount: this.objectMeshes.size,
    };
  }

  dispose() {
    this.controls.dispose();
    this.renderer.dispose();
    for (const tex of this.textureCache.values()) tex.dispose();
    this.textureCache.clear();
    this.loadedAssetCache.clear();
  }
}
