/**
 * Frozen Aperture — Main Application Bootstrap & Workflow Orchestrator
 * Connects canonical Project/Scene state, AssetManager, Providers, Segmentation Workbench,
 * TemporalSimulationEngine, WebGL 2 SceneRenderer, SpatialAudioEngine, and Offline Exporter.
 */

import './styles.css';
import { getActiveScene, validateProject, EXPERIENCE_MODES, ASSET_LIFECYCLE_STATES } from './core/schema.js';
import { ProjectStore } from './core/project-store.js';
import { escapeHtml, sanitizeFilename, sanitizeLabel } from './core/security.js';
import { AssetManager } from './assets/asset-manager.js';
import { ProviderRegistry } from './providers/provider-interface.js';
import { ManualGlbProvider, DexDiffusionAdapter } from './providers/dexdiffusion-adapter.js';
import { TemporalSimulationEngine } from './simulation/temporal-engine.js';
import { SceneRenderer } from './render/scene-renderer.js';
import { SpatialAudioEngine } from './render/audio-engine.js';
import { ingestImageFile, createSyntheticTestIllustration } from './source/image-ingestor.js';
import { SegmentationWorkbench } from './source/segmentation-canvas.js';
import { createPublicCalibrationProject } from './fixtures/calibration-scene.js';
import { buildStandaloneHtmlExport } from './export/offline-exporter.js';

const WORKFLOW_STAGES = [
  { id: 'source', label: 'Source' },
  { id: 'objects', label: 'Objects' },
  { id: 'reconstruction', label: 'Reconstruction' },
  { id: 'assembly', label: 'Assembly' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'validation', label: 'Validation' },
  { id: 'play', label: 'Play' },
  { id: 'export', label: 'Export' },
];

class FrozenApertureApp {
  constructor() {
    this.store = new ProjectStore();
    this.assetManager = new AssetManager();
    this.providers = new ProviderRegistry();
    this.manualProvider = new ManualGlbProvider(this.assetManager);
    this.dexProvider = new DexDiffusionAdapter();
    this.providers.register(this.manualProvider).register(this.dexProvider);
    this.audio = new SpatialAudioEngine();

    this.project = null;
    this.scene = null;
    this.sim = null;
    this.renderer = null;
    this.segWorkbench = null;

    this.workbenchOpen = false;
    this.activeStage = 'assembly';
    this.experienceMode = 'frozen_second';
    this.selectedObjectId = null;
    this.selectedSourceObjId = null;
    this.referenceOverlayOpacity = 0;
    this.providerStatuses = [];
    this.lastFrameTime = 0;
    this.frameTimes = [];
    this.toastTimer = null;
  }

  async init() {
    this.mountShell();

    // Load embedded standalone project if present, otherwise initialize Public Calibration Scene
    if (window.__FROZEN_APERTURE_EMBEDDED_PROJECT__) {
      const check = validateProject(window.__FROZEN_APERTURE_EMBEDDED_PROJECT__);
      if (check.valid) {
        this.project = window.__FROZEN_APERTURE_EMBEDDED_PROJECT__;
      }
    }
    if (!this.project) {
      this.project = await createPublicCalibrationProject(this.assetManager);
    }

    this.scene = getActiveScene(this.project);
    this.renderer = new SceneRenderer(document.getElementById('viewport'), {
      assetManager: this.assetManager,
      onSelectObject: (id) => {
        this.selectedObjectId = id;
        if (this.workbenchOpen) this.renderSidebar();
      },
      onObjectTap: (id) => this.handleViewportObjectTap(id),
      onContextLost: (lost) => {
        this.notify(lost ? 'WebGL context lost — preserving project state.' : 'WebGL context restored.', lost ? 'warn' : 'info');
      },
    });

    this.segWorkbench = new SegmentationWorkbench(document.getElementById('seg-canvas'), {
      onSelectionChange: (obj) => {
        this.selectedSourceObjId = obj ? obj.id : null;
        this.renderSidebar();
      },
      onObjectsChange: () => this.renderSidebar(),
      onCoordChange: (c) => {
        const el = document.getElementById('seg-coords');
        if (el) el.textContent = `X: ${c.x}  Y: ${c.y}  Zoom: ${Math.round(c.zoom * 100)}%`;
      },
    });

    await this.bindActiveScene();
    this.applySettings(this.project.settings || {});
    this.providerStatuses = await this.providers.discoverAll();
    this.renderSidebar();
    this.bindGlobalEvents();
    this.exposeAutomationApi();

    this.lastFrameTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  mountShell() {
    const app = document.getElementById('app');
    app.innerHTML = `
      <header id="workbench-topbar" role="banner">
        <div class="brand">
          <span class="brand-dot"></span>
          <span>Frozen Aperture</span>
        </div>
        <nav class="stage-tabs" role="tablist" aria-label="Authoring Workflow">
          ${WORKFLOW_STAGES.map(s => `<button class="stage-tab" data-stage="${s.id}" role="tab">${s.label}</button>`).join('')}
        </nav>
        <div>
          <button class="wb-btn primary" id="btn-exit-workbench">Immersive Play</button>
        </div>
      </header>

      <main id="stage-shell">
        <div id="viewport-wrap">
          <div id="viewport" aria-label="Frozen Aperture 3D Viewport"></div>

          <div id="reference-overlay">
            <div id="reference-badge">Reference Source Overlay</div>
            <img id="reference-img" alt="Original source illustration reference" />
          </div>

          <section id="seg-stage" aria-label="Source Segmentation Workbench">
            <div id="seg-toolbar">
              <button class="wb-btn" data-seg-tool="rect">Rect Mask</button>
              <button class="wb-btn" data-seg-tool="polygon">Polygon Mask</button>
              <button class="wb-btn" id="btn-seg-commit-poly">Finish Polygon</button>
              <button class="wb-btn" data-seg-tool="select">Select</button>
              <button class="wb-btn" data-seg-tool="pan">Pan</button>
              <button class="wb-btn" id="btn-seg-fit">Fit</button>
              <button class="wb-btn" id="btn-seg-native">1:1</button>
              <button class="wb-btn" id="btn-seg-invert">Invert Mask</button>
              <button class="wb-btn" id="btn-seg-undo">Undo Mask</button>
              <span class="mono" id="seg-coords" style="margin-left:auto">X: 0 Y: 0</span>
            </div>
            <div id="seg-canvas-wrap">
              <canvas id="seg-canvas" width="960" height="620"></canvas>
            </div>
          </section>

          <div id="play-bar" role="toolbar" aria-label="Immersive Play Controls">
            <button class="play-btn" id="play-undo" title="Undo last temporal action">Undo</button>
            <button class="play-btn" id="play-reset" title="Reset scene to initial state">Reset</button>
            <button class="play-btn" id="play-source-view" title="Return to calibrated source camera">Source View</button>
            <button class="play-btn" id="play-impact" title="Release impact weight for three-body test">Impact Test</button>
            <span class="play-sep"></span>
            <select class="play-select" id="play-mode-select" aria-label="Experience Mode">
              <option value="frozen_second">Frozen Second</option>
              <option value="living_illustration">Living Illustration</option>
              <option value="world_explorer">World Explorer</option>
              <option value="object_lab">Object Lab</option>
              <option value="scene_assembly">Scene Assembly</option>
            </select>
            <select class="play-select" id="play-inspect-select" aria-label="Inspection Shading">
              <option value="shaded">Shaded</option>
              <option value="clay">Clay</option>
              <option value="wireframe">Wireframe</option>
            </select>
            <select class="play-select" id="play-quality-select" aria-label="Quality Tier">
              <option value="high">High</option>
              <option value="balanced">Balanced</option>
              <option value="economy">Economy</option>
            </select>
            <button class="play-btn" id="play-reduced-motion" aria-pressed="false" title="Toggle reduced motion">Motion</button>
            <button class="play-btn" id="play-audio" aria-pressed="false" title="Toggle spatial audio">Audio</button>
            <span class="play-sep"></span>
            <button class="play-btn primary" id="btn-open-workbench">Workbench</button>
          </div>

          <div id="toast" role="status" aria-live="polite"></div>
        </div>

        <aside id="workbench-sidebar" aria-label="Authoring Inspector"></aside>
      </main>
    `;
  }

  async bindActiveScene() {
    this.scene = getActiveScene(this.project);
    this.sim = new TemporalSimulationEngine(this.scene, {
      onEvent: (type, payload) => {
        this.audio.playEvent(type, payload);
        if ((type === 'release' || type === 'propagation' || type === 'vortex_activated') && payload?.position) {
          this.renderer.spawnRipple(payload.position, type === 'vortex_activated' ? 0x6366f1 : 0x38bdf8);
        }
      },
    });
    await this.renderer.loadScene(this.project, this.scene);
    this.selectedObjectId = this.scene.objects[0]?.id || null;
    this.updateReferenceOverlay();
  }

  applySettings(s) {
    this.renderer.setQualityTier(s.qualityTier || 'high');
    this.renderer.setReducedMotion(Boolean(s.reducedMotion));
    this.audio.setMuted(Boolean(s.audioMuted));
    this.audio.setVolume(s.audioVolume ?? 0.55);

    const qSel = document.getElementById('play-quality-select');
    if (qSel) qSel.value = s.qualityTier || 'high';
    const rmBtn = document.getElementById('play-reduced-motion');
    if (rmBtn) {
      rmBtn.setAttribute('aria-pressed', String(Boolean(s.reducedMotion)));
      rmBtn.classList.toggle('active', Boolean(s.reducedMotion));
    }
  }

  handleViewportObjectTap(objectId) {
    this.audio.unlock();
    if (this.experienceMode === 'world_explorer' || this.experienceMode === 'scene_assembly') {
      this.notify(`Selected ${objectId} (temporal interaction paused in ${this.experienceMode}).`);
      return;
    }
    if (this.experienceMode === 'object_lab') {
      this.renderer.setIsolatedObject(objectId);
      this.renderer.focusObject(objectId);
      this.notify(`Inspecting ${objectId} in Object Lab.`);
      return;
    }
    const nextState = this.sim.toggleObject(objectId);
    if (nextState) {
      const obj = this.sim.getObject(objectId);
      this.notify(`${obj?.label || objectId}: ${nextState}`);
    }
  }

  setExperienceMode(mode) {
    if (!EXPERIENCE_MODES.includes(mode)) return;
    this.experienceMode = mode;
    this.renderer.experienceMode = mode;
    const sel = document.getElementById('play-mode-select');
    if (sel) sel.value = mode;

    if (mode !== 'object_lab') {
      this.renderer.setIsolatedObject(null);
    }
    if (mode === 'living_illustration') {
      this.sim.releaseAll();
      this.notify('Living Illustration: all supported bodies released.');
    } else if (mode === 'world_explorer') {
      this.notify('World Explorer: free navigation without temporal activation.');
    } else if (mode === 'object_lab') {
      const target = this.selectedObjectId || this.scene.objects.find(o => o.assetId)?.id || this.scene.objects[0]?.id;
      if (target) {
        this.renderer.setIsolatedObject(target);
        this.renderer.focusObject(target);
      }
      this.notify('Object Lab: isolated asset inspection (click Workbench → Assembly to switch object).');
    } else if (mode === 'scene_assembly') {
      this.setWorkbenchOpen(true, 'assembly');
    } else {
      this.notify('Frozen Second: click any body to release or suspend local time.');
    }
  }

  setWorkbenchOpen(open, stage = null) {
    this.workbenchOpen = Boolean(open);
    document.getElementById('app').classList.toggle('workbench-open', this.workbenchOpen);
    if (stage) this.setStage(stage);
    else this.syncStageUi();
    setTimeout(() => this.renderer.resize(), 20);
  }

  setStage(stageId) {
    if (stageId === 'play') {
      this.setWorkbenchOpen(false);
      document.getElementById('seg-stage').classList.remove('active');
      return;
    }
    this.activeStage = stageId;
    this.syncStageUi();
    this.renderSidebar();
  }

  syncStageUi() {
    document.querySelectorAll('.stage-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.stage === this.activeStage);
    });
    const showSeg = this.workbenchOpen && this.activeStage === 'objects';
    document.getElementById('seg-stage').classList.toggle('active', showSeg);
    if (showSeg) {
      const wrap = document.getElementById('seg-canvas-wrap');
      const canvas = document.getElementById('seg-canvas');
      canvas.width = Math.max(480, wrap.clientWidth || 800);
      canvas.height = Math.max(360, wrap.clientHeight || 520);
      this.segWorkbench.setImage(this.project.project.sourceIllustration, this.project.sourceObjects);
    }
  }

  updateReferenceOverlay() {
    const ov = document.getElementById('reference-overlay');
    const img = document.getElementById('reference-img');
    const src = this.project.project.sourceIllustration;
    if (src?.dataUrl && this.referenceOverlayOpacity > 0.01) {
      img.src = src.dataUrl;
      ov.style.opacity = String(this.referenceOverlayOpacity);
      ov.classList.add('active');
    } else {
      ov.classList.remove('active');
    }
  }

  bindGlobalEvents() {
    window.addEventListener('resize', () => {
      this.renderer.resize();
      if (this.workbenchOpen && this.activeStage === 'objects') this.syncStageUi();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'Escape') {
        if (this.renderer.isolatedObjectId) {
          this.renderer.setIsolatedObject(null);
          this.notify('Exited isolated inspection.');
        } else if (this.workbenchOpen) {
          this.setWorkbenchOpen(false);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.sim.undo();
      }
    });

    document.getElementById('btn-open-workbench').addEventListener('click', () => this.setWorkbenchOpen(true, this.activeStage));
    document.getElementById('btn-exit-workbench').addEventListener('click', () => this.setWorkbenchOpen(false));

    document.querySelectorAll('.stage-tab').forEach(btn => {
      btn.addEventListener('click', () => this.setStage(btn.dataset.stage));
    });

    // Play bar controls
    document.getElementById('play-undo').addEventListener('click', () => {
      this.audio.unlock();
      if (!this.sim.undo()) this.notify('Nothing to undo.');
    });
    document.getElementById('play-reset').addEventListener('click', () => {
      this.audio.unlock();
      this.sim.reset();
      this.notify('Scene restored to initial state.');
    });
    document.getElementById('play-source-view').addEventListener('click', () => {
      this.renderer.applyCameraPose(this.scene.cameras?.sourceCamera);
      this.notify('Returned to calibrated Source Camera.');
    });
    document.getElementById('play-impact').addEventListener('click', () => {
      this.audio.unlock();
      if (this.sim.releaseObject('obj_impact_weight')) {
        this.notify('Impact Weight released — three-body contact chain active.');
      } else {
        this.notify('Impact Weight already active or unavailable. Press Reset to repeat.');
      }
    });
    document.getElementById('play-mode-select').addEventListener('change', (e) => this.setExperienceMode(e.target.value));
    document.getElementById('play-inspect-select').addEventListener('change', (e) => this.renderer.setInspectionMode(e.target.value));
    document.getElementById('play-quality-select').addEventListener('change', (e) => {
      this.project.settings.qualityTier = e.target.value;
      this.renderer.setQualityTier(e.target.value);
      this.notify(`Quality tier: ${e.target.value} (simulation outcomes unchanged).`);
    });
    document.getElementById('play-reduced-motion').addEventListener('click', (e) => {
      const next = !this.renderer.reducedMotion;
      this.project.settings.reducedMotion = next;
      this.renderer.setReducedMotion(next);
      e.target.setAttribute('aria-pressed', String(next));
      e.target.classList.toggle('active', next);
      this.notify(next ? 'Reduced motion enabled.' : 'Reduced motion disabled.');
    });
    document.getElementById('play-audio').addEventListener('click', (e) => {
      this.audio.unlock();
      const nextMuted = !this.audio.muted;
      this.audio.setMuted(nextMuted);
      this.project.settings.audioMuted = nextMuted;
      e.target.setAttribute('aria-pressed', String(!nextMuted));
      e.target.classList.toggle('active', !nextMuted);
      this.notify(nextMuted ? 'Audio muted.' : 'Spatial audio active.');
    });

    // Segmentation toolbar
    document.querySelectorAll('[data-seg-tool]').forEach(btn => {
      btn.addEventListener('click', () => this.segWorkbench.setTool(btn.dataset.segTool));
    });
    document.getElementById('btn-seg-commit-poly').addEventListener('click', () => this.segWorkbench.commitPolygon());
    document.getElementById('btn-seg-fit').addEventListener('click', () => this.segWorkbench.fitToView());
    document.getElementById('btn-seg-native').addEventListener('click', () => this.segWorkbench.setNativeZoom());
    document.getElementById('btn-seg-invert').addEventListener('click', () => {
      this.segWorkbench.invertMask = !this.segWorkbench.invertMask;
      this.notify(`Mask inversion: ${this.segWorkbench.invertMask ? 'ON' : 'OFF'}`);
    });
    document.getElementById('btn-seg-undo').addEventListener('click', () => this.segWorkbench.undo());
  }

  renderSidebar() {
    const sb = document.getElementById('workbench-sidebar');
    if (!sb || !this.project) return;

    if (this.activeStage === 'source') this.renderSourcePanel(sb);
    else if (this.activeStage === 'objects') this.renderObjectsPanel(sb);
    else if (this.activeStage === 'reconstruction') this.renderReconstructionPanel(sb);
    else if (this.activeStage === 'assembly') this.renderAssemblyPanel(sb);
    else if (this.activeStage === 'simulation') this.renderSimulationPanel(sb);
    else if (this.activeStage === 'validation') this.renderValidationPanel(sb);
    else if (this.activeStage === 'export') this.renderExportPanel(sb);
  }

  renderSourcePanel(sb) {
    const src = this.project.project.sourceIllustration;
    sb.innerHTML = `
      <div class="wb-section">
        <h3 class="wb-title">Source Illustration</h3>
        <div class="notice">
          Public Calibration Scene active. Private APERTURE artwork is excluded from Git; import any local PNG/JPEG/WebP or load the synthetic calibration plate to test end-to-end extraction.
        </div>
        <div class="wb-row">
          <input type="file" id="in-source-file" accept="image/png,image/jpeg,image/webp" class="wb-input" style="flex:1" />
        </div>
        <div class="wb-row">
          <button class="wb-btn primary" id="btn-load-synthetic-plate">Load Synthetic Calibration Plate</button>
        </div>
        ${src ? `
          <div class="mono">
            <div>File: ${escapeHtml(src.name)}</div>
            <div>Dims: ${src.width} × ${src.height} (${src.mimeType})</div>
            <div>SHA-256: ${src.sha256.slice(0, 24)}…</div>
          </div>
        ` : '<div class="mono">No source illustration attached yet.</div>'}
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Source Camera & Reference Overlay</h3>
        <div class="wb-row">
          <label for="in-ref-opacity">Reference Opacity</label>
          <input type="range" id="in-ref-opacity" min="0" max="1" step="0.05" value="${this.referenceOverlayOpacity}" style="flex:1" />
          <span class="mono">${Math.round(this.referenceOverlayOpacity * 100)}%</span>
        </div>
        <div class="wb-row">
          <button class="wb-btn" id="btn-goto-src-cam">Go to Source Camera</button>
          <button class="wb-btn" id="btn-save-src-cam">Calibrate Current View as Source</button>
        </div>
      </div>
    `;

    sb.querySelector('#in-source-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const meta = await ingestImageFile(file);
        this.project.project.sourceIllustration = meta;
        this.scene.cameras.sourceCamera.imageWidth = meta.width;
        this.scene.cameras.sourceCamera.imageHeight = meta.height;
        this.updateReferenceOverlay();
        this.renderSidebar();
        this.notify(`Ingested ${meta.name} (${meta.width}×${meta.height}).`);
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#btn-load-synthetic-plate')?.addEventListener('click', async () => {
      const meta = await createSyntheticTestIllustration();
      this.project.project.sourceIllustration = meta;
      this.scene.cameras.sourceCamera.imageWidth = meta.width;
      this.scene.cameras.sourceCamera.imageHeight = meta.height;
      this.updateReferenceOverlay();
      this.renderSidebar();
      this.notify('Loaded Public Synthetic Calibration Plate.');
    });

    sb.querySelector('#in-ref-opacity')?.addEventListener('input', (e) => {
      this.referenceOverlayOpacity = Number(e.target.value);
      this.updateReferenceOverlay();
      this.renderSidebar();
    });

    sb.querySelector('#btn-goto-src-cam')?.addEventListener('click', () => {
      this.renderer.applyCameraPose(this.scene.cameras.sourceCamera);
    });

    sb.querySelector('#btn-save-src-cam')?.addEventListener('click', () => {
      const pose = this.renderer.getCameraPose();
      Object.assign(this.scene.cameras.sourceCamera, pose, { calibrated: true });
      this.notify('Saved current camera pose as calibrated Source Camera.');
    });
  }

  renderObjectsPanel(sb) {
    const objs = this.project.sourceObjects || [];
    const sel = objs.find(o => o.id === this.selectedSourceObjId) || objs[0] || null;

    sb.innerHTML = `
      <div class="wb-section">
        <h3 class="wb-title">Extracted Source Objects (${objs.length})</h3>
        <div class="notice">
          Draw a rectangular or polygon mask directly on the 2D canvas on the left. Promote any extracted object to the 3D scene as an honest <code>source_image_layer</code>, then replace it with a volumetric GLB later without changing its logical ID.
        </div>
        <div class="wb-list">
          ${objs.map(o => `
            <button class="wb-list-item ${sel?.id === o.id ? 'selected' : ''}" data-src-id="${escapeHtml(o.id)}">
              <span>${escapeHtml(o.label)}</span>
              <span class="badge">${escapeHtml(o.reconstructionStatus || 'extracted')}</span>
            </button>
          `).join('') || '<div class="mono">No source objects yet.</div>'}
        </div>
      </div>

      ${sel ? `
        <div class="wb-section">
          <h3 class="wb-title">Selected Source Object</h3>
          <div class="wb-row">
            <input class="wb-input" id="in-src-label" value="${escapeHtml(sel.label)}" style="flex:1" />
            <button class="wb-btn" id="btn-rename-src">Rename</button>
          </div>
          <div class="mono" style="margin-bottom:8px">
            ID: ${escapeHtml(sel.id)}<br/>
            BBox: ${sel.bbox ? `${sel.bbox.x},${sel.bbox.y} (${sel.bbox.w}×${sel.bbox.h})` : 'none'}
          </div>
          <div class="wb-row">
            <button class="wb-btn primary" id="btn-promote-layer">Add to 3D Scene as Layer</button>
            <button class="wb-btn" id="btn-export-crop">Export Alpha PNG</button>
          </div>
        </div>
      ` : ''}
    `;

    sb.querySelectorAll('[data-src-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.selectedSourceObjId = btn.dataset.srcId;
        this.segWorkbench.selectedId = this.selectedSourceObjId;
        this.segWorkbench.render();
        this.renderSidebar();
      });
    });

    sb.querySelector('#btn-rename-src')?.addEventListener('click', () => {
      const val = sb.querySelector('#in-src-label')?.value;
      if (sel && val) {
        sel.label = sanitizeLabel(val, sel.label);
        this.segWorkbench.render();
        this.renderSidebar();
      }
    });

    sb.querySelector('#btn-promote-layer')?.addEventListener('click', async () => {
      if (!sel) return;
      const crop = this.segWorkbench.exportAlphaCrop(sel);
      if (!crop) {
        this.notify('Load a source illustration first to crop and promote a layer.', 'warn');
        return;
      }
      const existing = this.scene.objects.find(o => o.sourceObjectId === sel.id);
      if (existing) {
        existing.representationType = 'source_image_layer';
        existing.layerDataUrl = crop.dataUrl;
        existing.layerAspect = crop.cropRect.w / Math.max(1, crop.cropRect.h);
        await this.renderer.upsertObjectMesh(existing);
        this.notify(`Updated ${existing.id} with alpha source layer.`);
      } else {
        const nx = ((sel.bbox.x + sel.bbox.w * 0.5) / crop.sourceWidth - 0.5) * 8.0;
        const ny = (1 - (sel.bbox.y + sel.bbox.h * 0.5) / crop.sourceHeight) * 3.5 + 0.6;
        const newObj = {
          id: `obj_${sel.id}`,
          label: sel.label,
          category: sel.category || 'figure',
          representationType: 'source_image_layer',
          assetId: null,
          sourceObjectId: sel.id,
          layerDataUrl: crop.dataUrl,
          layerAspect: crop.cropRect.w / Math.max(1, crop.cropRect.h),
          position: [Number(nx.toFixed(2)), Number(ny.toFixed(2)), 0.5],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          pivot: [0, 0, 0],
          parentId: null,
          temporalState: 'held',
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          collision: { shape: 'box', halfExtents: [0.45, 0.85, 0.15], enabled: true },
          physics: { mass: 1.5, restitution: 0.35, gravityScale: 1.0, isStatic: false },
          material: { color: '#ffffff', emissive: '#000000', roughness: 0.6, metalness: 0.1 },
          visible: true,
          interactive: true,
        };
        this.scene.objects.push(newObj);
        this.sim.captureInitialState();
        await this.renderer.upsertObjectMesh(newObj);
        this.notify(`Promoted ${sel.label} into 3D scene as source_image_layer.`);
      }
    });

    sb.querySelector('#btn-export-crop')?.addEventListener('click', () => {
      if (!sel) return;
      const crop = this.segWorkbench.exportAlphaCrop(sel);
      if (!crop) {
        this.notify('No source image loaded for alpha crop export.', 'warn');
        return;
      }
      const a = document.createElement('a');
      a.href = crop.dataUrl;
      a.download = sanitizeFilename(`${sel.id}_crop.png`, 'crop.png');
      a.click();
    });
  }

  renderReconstructionPanel(sb) {
    const jobs = this.project.jobs || [];
    sb.innerHTML = `
      <div class="wb-section">
        <h3 class="wb-title">Reconstruction Providers</h3>
        ${this.providerStatuses.map(p => `
          <div class="wb-list-item" style="flex-direction:column;align-items:flex-start;cursor:default;margin-bottom:6px">
            <div style="display:flex;justify-content:space-between;width:100%">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="badge ${p.status.available ? 'ok' : 'warn'}">${escapeHtml(p.status.state)}</span>
            </div>
            <div class="mono">${escapeHtml(p.status.reason || '')}</div>
          </div>
        `).join('')}
        <div class="wb-row">
          <input class="wb-input" id="in-dex-url" placeholder="http://big-mac.local:8787 (optional)" value="${escapeHtml(this.dexProvider.baseUrl)}" style="flex:1" />
          <button class="wb-btn" id="btn-probe-providers">Probe</button>
        </div>
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Manual GLB Import (Offline Ready)</h3>
        <div class="wb-row">
          <input type="file" id="in-glb-file" accept=".glb,model/gltf-binary" class="wb-input" style="flex:1" />
        </div>
        <div class="mono">Imported GLBs undergo full binary glTF 2.0 structural, coordinate, bounds, and topology validation before entering the asset registry.</div>
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Job Receipts (${jobs.length})</h3>
        <div class="wb-list">
          ${jobs.slice(-12).reverse().map(j => `
            <div class="wb-list-item" style="flex-direction:column;align-items:flex-start;cursor:default">
              <div style="display:flex;justify-content:space-between;width:100%">
                <span class="mono">${escapeHtml(j.providerId)} (${escapeHtml(j.mode)})</span>
                <span class="badge ${j.state === 'completed' ? 'ok' : j.state === 'failed' || j.state === 'blocked' ? 'err' : 'accent'}">${escapeHtml(j.state)}</span>
              </div>
              <div class="mono">${escapeHtml(j.message || '')}</div>
            </div>
          `).join('') || '<div class="mono">No reconstruction jobs run yet.</div>'}
        </div>
      </div>
    `;

    sb.querySelector('#btn-probe-providers')?.addEventListener('click', async () => {
      const url = sb.querySelector('#in-dex-url')?.value || '';
      this.dexProvider.setBaseUrl(url);
      this.providerStatuses = await this.providers.discoverAll();
      this.renderSidebar();
      this.notify('Refreshed provider capabilities.');
    });

    sb.querySelector('#in-glb-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const receipt = await this.providers.submitJob(this.project, {
          providerId: 'manual_glb',
          sourceObjectId: this.selectedSourceObjId,
          mode: 'import',
          operatorInitiated: true,
          input: { project: this.project, bytes, label: file.name, rights: 'private_unverified' },
        });
        if (receipt.state === 'completed') {
          this.notify(`Validated & registered GLB: ${file.name}`);
        } else {
          this.notify(receipt.message, 'error');
        }
        this.renderSidebar();
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });
  }

  renderAssemblyPanel(sb) {
    const objs = this.scene.objects;
    const sel = objs.find(o => o.id === this.selectedObjectId) || objs[0];
    const validAssets = this.project.assets.filter(a => a.validation?.valid);

    sb.innerHTML = `
      <div class="wb-section">
        <h3 class="wb-title">Scene Objects (${objs.length})</h3>
        <div class="wb-list">
          ${objs.map(o => `
            <button class="wb-list-item ${sel?.id === o.id ? 'selected' : ''}" data-obj-id="${escapeHtml(o.id)}">
              <span>${escapeHtml(o.label)}</span>
              <span class="badge ${o.representationType === 'volumetric_rigid_mesh' ? 'accent' : ''}">${escapeHtml(o.representationType)}</span>
            </button>
          `).join('')}
        </div>
      </div>

      ${sel ? `
        <div class="wb-section">
          <h3 class="wb-title">Transform — ${escapeHtml(sel.label)}</h3>
          <div class="mono" style="margin-bottom:6px">ID: ${escapeHtml(sel.id)} · State: ${escapeHtml(sel.temporalState)}</div>
          <label class="mono">Position (m)</label>
          <div class="wb-grid-3" style="margin-bottom:6px">
            <input class="wb-input" type="number" step="0.1" id="tx" value="${sel.position[0]}" />
            <input class="wb-input" type="number" step="0.1" id="ty" value="${sel.position[1]}" />
            <input class="wb-input" type="number" step="0.1" id="tz" value="${sel.position[2]}" />
          </div>
          <label class="mono">Scale</label>
          <div class="wb-grid-3" style="margin-bottom:8px">
            <input class="wb-input" type="number" step="0.1" min="0.1" id="sx" value="${sel.scale[0]}" />
            <input class="wb-input" type="number" step="0.1" min="0.1" id="sy" value="${sel.scale[1]}" />
            <input class="wb-input" type="number" step="0.1" min="0.1" id="sz" value="${sel.scale[2]}" />
          </div>
          <div class="wb-row">
            <button class="wb-btn primary" id="btn-apply-xform">Apply Transform</button>
            <button class="wb-btn" id="btn-focus-obj">Focus</button>
            <button class="wb-btn" id="btn-isolate-obj">${this.renderer.isolatedObjectId === sel.id ? 'Un-Isolate' : 'Isolate'}</button>
          </div>
        </div>

        <div class="wb-section">
          <h3 class="wb-title">Asset Binding & Reversible Replacement</h3>
          <div class="wb-row">
            <select class="wb-select" id="sel-bind-asset" style="flex:1">
              ${validAssets.map(a => `<option value="${escapeHtml(a.id)}" ${sel.assetId === a.id ? 'selected' : ''}>${escapeHtml(a.label)} [${escapeHtml(a.lifecycleState)}]</option>`).join('')}
            </select>
          </div>
          <div class="wb-row">
            <button class="wb-btn primary" id="btn-bind-asset">Bind Volumetric GLB</button>
            <button class="wb-btn" id="btn-revert-asset" ${!sel.assetHistory?.length ? 'disabled' : ''}>Revert Previous</button>
          </div>
        </div>
      ` : ''}

      <div class="wb-section">
        <h3 class="wb-title">Inspection Camera Views</h3>
        <div class="wb-row">
          ${(this.scene.cameras?.namedViews || []).map(v => `<button class="wb-btn" data-cam-view="${escapeHtml(v.id)}">${escapeHtml(v.label)}</button>`).join('')}
        </div>
      </div>
    `;

    sb.querySelectorAll('[data-obj-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.selectedObjectId = btn.dataset.objId;
        this.renderSidebar();
      });
    });

    sb.querySelector('#btn-apply-xform')?.addEventListener('click', () => {
      if (!sel) return;
      sel.position = [Number(sb.querySelector('#tx').value) || 0, Number(sb.querySelector('#ty').value) || 0, Number(sb.querySelector('#tz').value) || 0];
      sel.scale = [Math.max(0.1, Number(sb.querySelector('#sx').value) || 1), Math.max(0.1, Number(sb.querySelector('#sy').value) || 1), Math.max(0.1, Number(sb.querySelector('#sz').value) || 1)];
      this.sim.captureInitialState();
      this.renderer.syncFromSimulation();
      this.notify(`Updated transform for ${sel.id}.`);
    });

    sb.querySelector('#btn-focus-obj')?.addEventListener('click', () => sel && this.renderer.focusObject(sel.id));
    sb.querySelector('#btn-isolate-obj')?.addEventListener('click', () => {
      if (!sel) return;
      const next = this.renderer.isolatedObjectId === sel.id ? null : sel.id;
      this.renderer.setIsolatedObject(next);
      this.renderSidebar();
    });

    sb.querySelector('#btn-bind-asset')?.addEventListener('click', async () => {
      const assetId = sb.querySelector('#sel-bind-asset')?.value;
      if (!sel || !assetId) return;
      try {
        this.assetManager.bindAssetToSceneObject(this.project, this.scene, sel.id, assetId, {
          representationType: 'volumetric_rigid_mesh',
          reason: 'Bound via Assembly Workbench',
        });
        await this.renderer.upsertObjectMesh(sel);
        this.notify(`Bound volumetric GLB to ${sel.id} (logical ID preserved).`);
        this.renderSidebar();
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#btn-revert-asset')?.addEventListener('click', async () => {
      if (!sel) return;
      try {
        this.assetManager.revertSceneObjectAsset(this.scene, sel.id);
        await this.renderer.upsertObjectMesh(sel);
        this.notify(`Reverted asset binding on ${sel.id}.`);
        this.renderSidebar();
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelectorAll('[data-cam-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = this.scene.cameras?.namedViews?.find(v => v.id === btn.dataset.camView);
        if (view) this.renderer.applyCameraPose(view);
      });
    });
  }

  renderSimulationPanel(sb) {
    const stats = this.sim.getStats();
    const sel = this.scene.objects.find(o => o.id === this.selectedObjectId);

    sb.innerHTML = `
      <div class="wb-section">
        <h3 class="wb-title">Temporal Simulation Controls</h3>
        <div class="mono" style="margin-bottom:8px">
          Tick: ${stats.tick} · Active: ${stats.counts.active} · Held: ${stats.counts.held} · Suspended: ${stats.counts.suspended} · Contacts: ${stats.contacts}
        </div>
        <div class="wb-row">
          <button class="wb-btn primary" id="sim-impact">Release Impact Weight</button>
          <button class="wb-btn primary" id="sim-vortex">Toggle Central Vortex</button>
        </div>
        <div class="wb-row">
          <button class="wb-btn" id="sim-rel-all">Release All</button>
          <button class="wb-btn" id="sim-sus-all">Suspend All</button>
          <button class="wb-btn" id="sim-undo">Undo</button>
          <button class="wb-btn" id="sim-reset">Reset</button>
        </div>
        ${sel ? `
          <div class="wb-row">
            <button class="wb-btn" id="sim-toggle-sel">Toggle ${escapeHtml(sel.label)} (${escapeHtml(sel.temporalState)})</button>
          </div>
        ` : ''}
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Physics & Determinism Diagnostics</h3>
        <div class="wb-row">
          <button class="wb-btn" id="sim-col-vis">${this.renderer.showCollisionProxies ? 'Hide' : 'Show'} Collision Proxies</button>
          <button class="wb-btn" id="sim-replay-check">Verify Deterministic Replay</button>
        </div>
        <div class="mono" id="sim-hash-out">State Hash: ${this.sim.getStateHash()}</div>
      </div>
    `;

    sb.querySelector('#sim-impact')?.addEventListener('click', () => { this.sim.releaseObject('obj_impact_weight'); this.renderSidebar(); });
    sb.querySelector('#sim-vortex')?.addEventListener('click', () => { this.sim.toggleObject('obj_vortex_core'); this.renderSidebar(); });
    sb.querySelector('#sim-rel-all')?.addEventListener('click', () => { this.sim.releaseAll(); this.renderSidebar(); });
    sb.querySelector('#sim-sus-all')?.addEventListener('click', () => { this.sim.suspendAll(); this.renderSidebar(); });
    sb.querySelector('#sim-undo')?.addEventListener('click', () => { this.sim.undo(); this.renderSidebar(); });
    sb.querySelector('#sim-reset')?.addEventListener('click', () => { this.sim.reset(); this.renderSidebar(); });
    sb.querySelector('#sim-toggle-sel')?.addEventListener('click', () => { if (sel) this.sim.toggleObject(sel.id); this.renderSidebar(); });
    sb.querySelector('#sim-col-vis')?.addEventListener('click', () => {
      this.renderer.setShowCollisionProxies(!this.renderer.showCollisionProxies);
      this.renderSidebar();
    });
    sb.querySelector('#sim-replay-check')?.addEventListener('click', () => {
      const log = [...this.sim.tickLog];
      const targetTick = Math.max(this.sim.tick, 60);
      const h1 = this.sim.replay(log, targetTick);
      const h2 = this.sim.replay(log, targetTick);
      const match = h1 === h2;
      this.notify(match ? `Deterministic replay verified (hash ${h1} over ${targetTick} ticks).` : `Replay mismatch: ${h1} vs ${h2}`, match ? 'info' : 'error');
      this.renderSidebar();
    });
  }

  renderValidationPanel(sb) {
    const check = validateProject(this.project);
    const tel = this.renderer.getTelemetry();

    sb.innerHTML = `
      <div class="wb-section">
        <h3 class="wb-title">Project Schema Validation</h3>
        <div class="wb-row">
          <span class="badge ${check.valid ? 'ok' : 'err'}">${check.valid ? 'VALID v' + this.project.schemaVersion : 'INVALID'}</span>
          <span class="mono">${check.errors.length} errors · ${check.warnings.length} warnings</span>
        </div>
        ${check.errors.map(e => `<div class="mono" style="color:var(--err)">• ${escapeHtml(e)}</div>`).join('')}
        ${check.warnings.map(w => `<div class="mono" style="color:var(--warn)">• ${escapeHtml(w)}</div>`).join('')}
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Asset Registry & Lifecycle (${this.project.assets.length})</h3>
        <div class="wb-list">
          ${this.project.assets.map(a => `
            <div class="wb-list-item" style="flex-direction:column;align-items:flex-start;cursor:default">
              <div style="display:flex;justify-content:space-between;width:100%">
                <strong>${escapeHtml(a.label)}</strong>
                <span class="badge ${a.validation?.valid ? 'ok' : 'err'}">${escapeHtml(a.lifecycleState)}</span>
              </div>
              <div class="mono">
                Verts: ${a.validation?.stats?.vertexCount || 0} · Tris: ${a.validation?.stats?.triangleCount || 0} · Watertight: ${a.validation?.stats?.topology?.watertight ? 'yes' : 'no'}
              </div>
              <div class="mono">SHA-256: ${a.sha256.slice(0, 18)}… · Rights: ${escapeHtml(a.rights)}</div>
              <div class="wb-row" style="margin-top:4px;margin-bottom:0">
                <select class="wb-select" data-asset-state="${escapeHtml(a.id)}">
                  ${ASSET_LIFECYCLE_STATES.map(st => `<option value="${st}" ${a.lifecycleState === st ? 'selected' : ''}>${st}</option>`).join('')}
                </select>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Renderer Telemetry</h3>
        <div class="mono">
          Draw Calls: ${tel.drawCalls} · Triangles: ${tel.triangles}<br/>
          Geometries: ${tel.geometries} · Textures: ${tel.textures}<br/>
          Quality: ${tel.qualityTier} · Objects: ${tel.objectCount}
        </div>
      </div>
    `;

    sb.querySelectorAll('[data-asset-state]').forEach(sel => {
      sel.addEventListener('change', (e) => {
        try {
          this.assetManager.transitionAssetState(this.project, sel.dataset.assetState, e.target.value, 'Updated in Validation panel');
          this.notify(`Asset transitioned to ${e.target.value}.`);
          this.renderSidebar();
        } catch (err) {
          this.notify(err.message, 'error');
          this.renderSidebar();
        }
      });
    });
  }

  renderExportPanel(sb) {
    const saved = this.store.listSaved();
    sb.innerHTML = `
      <div class="wb-section">
        <h3 class="wb-title">Project Persistence</h3>
        <div class="mono" style="margin-bottom:8px">
          Project: ${escapeHtml(this.project.project.name)} (rev ${this.project.project.revision})
        </div>
        <div class="wb-row">
          <button class="wb-btn primary" id="btn-save-proj">Save Revision (Browser)</button>
          <button class="wb-btn" id="btn-export-json">Export Project JSON</button>
        </div>
        <div class="wb-row">
          <label class="mono" for="in-import-json">Open Project JSON:</label>
          <input type="file" id="in-import-json" accept="application/json,.json" class="wb-input" style="flex:1" />
        </div>
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Standalone Offline HTML Player</h3>
        <div class="notice">
          Exports a self-contained HTML player embedding the active project and validated assets with zero external network dependencies.
        </div>
        <button class="wb-btn primary" id="btn-export-html">Export Offline HTML Player</button>
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Saved Browser Projects (${saved.length})</h3>
        <div class="wb-list">
          ${saved.map(item => `
            <button class="wb-list-item" data-load-proj="${escapeHtml(item.id)}">
              <span>${escapeHtml(item.name)} (rev ${item.revision})</span>
              <span class="badge">Open</span>
            </button>
          `).join('') || '<div class="mono">No browser-saved projects yet.</div>'}
        </div>
      </div>
    `;

    sb.querySelector('#btn-save-proj')?.addEventListener('click', () => {
      try {
        const res = this.store.saveProject(this.project);
        this.notify(res.message);
        this.renderSidebar();
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#btn-export-json')?.addEventListener('click', () => {
      try {
        const json = this.store.serializeProject(this.project);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = sanitizeFilename(`${this.project.project.id}_rev${this.project.project.revision}.json`);
        a.click();
        URL.revokeObjectURL(url);
        this.notify('Exported portable project JSON.');
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#in-import-json')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const { project, warnings } = this.store.parseAndValidateProjectJson(text);
        this.project = project;
        await this.bindActiveScene();
        this.renderSidebar();
        this.notify(`Opened project ${project.project.name}${warnings.length ? ` (${warnings.length} warnings)` : ''}.`);
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#btn-export-html')?.addEventListener('click', () => {
      try {
        const html = buildStandaloneHtmlExport(this.project, document.documentElement.outerHTML);
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = sanitizeFilename(`${this.project.project.id}_offline_player.html`);
        a.click();
        URL.revokeObjectURL(url);
        this.notify('Exported standalone offline HTML player.');
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelectorAll('[data-load-proj]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const { project } = this.store.loadProjectById(btn.dataset.loadProj);
          this.project = project;
          await this.bindActiveScene();
          this.renderSidebar();
          this.notify(`Loaded ${project.project.name}.`);
        } catch (err) {
          this.notify(err.message, 'error');
        }
      });
    });
  }

  notify(msg, kind = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `visible ${kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : ''}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('visible'), 3600);
  }

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    if (document.visibilityState === 'hidden') {
      this.lastFrameTime = now;
      return;
    }

    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;

    if (this.frameTimes.length < 180) this.frameTimes.push(dt * 1000);
    else {
      this.frameTimes.shift();
      this.frameTimes.push(dt * 1000);
    }

    if (this.sim) {
      this.sim.advance(dt);
    }
    if (this.renderer) {
      this.renderer.syncFromSimulation(dt);
      this.renderer.renderFrame();
    }
  }

  exposeAutomationApi() {
    window.__FROZEN_APERTURE__ = {
      getProject: () => this.project,
      getScene: () => this.scene,
      getSimStats: () => this.sim.getStats(),
      getStateHash: () => this.sim.getStateHash(),
      getTelemetry: () => ({
        ...this.renderer.getTelemetry(),
        frameTimesMs: [...this.frameTimes],
      }),
      releaseObject: (id) => this.sim.releaseObject(id),
      suspendObject: (id) => this.sim.suspendObject(id),
      releaseAll: () => this.sim.releaseAll(),
      undo: () => this.sim.undo(),
      reset: () => this.sim.reset(),
      stepTicks: (n) => {
        for (let i = 0; i < n; i++) this.sim.stepFixed();
        this.renderer.syncFromSimulation(n / 60);
        this.renderer.renderFrame();
        return this.sim.getStats();
      },
      setWorkbenchOpen: (open, stage) => this.setWorkbenchOpen(open, stage),
      setInspectionMode: (m) => {
        this.renderer.setInspectionMode(m);
        this.renderer.renderFrame();
      },
      setQualityTier: (q) => {
        this.renderer.setQualityTier(q);
        this.renderer.renderFrame();
      },
      setReducedMotion: (f) => this.renderer.setReducedMotion(f),
      setExperienceMode: (m) => this.setExperienceMode(m),
      applyNamedView: (viewId) => {
        const v = this.scene.cameras?.namedViews?.find(x => x.id === viewId);
        if (v) {
          this.renderer.applyCameraPose(v);
          this.renderer.renderFrame();
        }
      },
      focusObject: (id) => {
        this.renderer.focusObject(id);
        this.renderer.renderFrame();
      },
      loadSyntheticPlate: async () => {
        const meta = await createSyntheticTestIllustration();
        this.project.project.sourceIllustration = meta;
        this.updateReferenceOverlay();
        if (this.workbenchOpen) this.renderSidebar();
        return meta.sha256;
      },
      exportStandaloneHtml: () => buildStandaloneHtmlExport(this.project, document.documentElement.outerHTML),
    };
  }
}

const app = new FrozenApertureApp();
app.init().catch(err => {
  console.error('Frozen Aperture init failed:', err);
  const el = document.getElementById('app');
  if (el) el.innerHTML = `<pre style="color:#fda4af;padding:24px">Frozen Aperture initialization error:\n${err.stack || err.message}</pre>`;
});
