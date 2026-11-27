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
import { bakeSourceVertexColors } from './assets/vertex-color-baker.js';
import { ProviderRegistry } from './providers/provider-interface.js';
import { ManualGlbProvider, DexDiffusionAdapter } from './providers/dexdiffusion-adapter.js';
import { TemporalSimulationEngine } from './simulation/temporal-engine.js';
import { SceneRenderer } from './render/scene-renderer.js';
import { SpatialAudioEngine } from './render/audio-engine.js';
import { ingestImageFile, createSyntheticTestIllustration } from './source/image-ingestor.js';
import { SegmentationWorkbench } from './source/segmentation-canvas.js';
import { solveCameraFromLandmarks } from './source/camera-calibrator.js';
import { generateBackgroundPlateFromSource } from './source/background-plate.js';
import { compileIllustrationToPlayableScene } from './source/auto-decomposer.js';
import { evaluateCanvasSilhouetteIoU } from './render/silhouette-iou.js';
import { createPublicCalibrationProject } from './fixtures/calibration-scene.js';
import { buildStandaloneHtmlExport } from './export/offline-exporter.js';
import { exportProjectZipBundle, exportProjectZipBundleCompressed, importProjectZipBundleAsync } from './export/zip-bundle.js';

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
    this.activeStage = 'source';
    this.experienceMode = 'frozen_second';
    this.selectedObjectId = null;
    this.selectedSourceObjId = null;
    this.referenceOverlayOpacity = 0;
    this.gizmoMode = 'off'; // off | translate | rotate | scale
    this.gizmoSnap = false;
    this.lastIouResult = null;
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
      onTransformCommit: () => {
        this.sim.captureInitialState();
        if (this.workbenchOpen && this.activeStage === 'assembly') this.renderSidebar();
      },
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
        <h1 class="brand">
          <span class="brand-dot" aria-hidden="true"></span>
          <span>Frozen Aperture</span>
        </h1>
        <nav class="stage-tabs" role="tablist" aria-label="Authoring Workflow">
          ${WORKFLOW_STAGES.map((s, idx) => `<button class="stage-tab" id="tab-${s.id}" data-stage="${s.id}" role="tab" aria-selected="${s.id === this.activeStage ? 'true' : 'false'}" aria-controls="workbench-sidebar" tabindex="${idx === 0 ? '0' : '-1'}">${s.label}</button>`).join('')}
        </nav>
        <div class="wb-row" style="margin:0;flex-wrap:nowrap">
          <button class="wb-btn" id="btn-open-cmd" title="Command Palette (Ctrl/Cmd+K)" aria-label="Open Command Palette">⌘K</button>
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

          <div id="play-options-popover" role="dialog" aria-label="Play Display and Accessibility Options">
            <div class="popover-row">
              <label class="popover-label" for="play-mode-select">Experience Mode</label>
              <select class="play-select" id="play-mode-select">
                <option value="frozen_second">Frozen Second</option>
                <option value="living_illustration">Living Illustration</option>
                <option value="world_explorer">World Explorer</option>
                <option value="object_lab">Object Lab</option>
                <option value="scene_assembly">Scene Assembly</option>
              </select>
            </div>
            <div class="popover-row">
              <label class="popover-label" for="play-inspect-select">Inspection Shading</label>
              <select class="play-select" id="play-inspect-select">
                <option value="shaded">Shaded</option>
                <option value="clay">Clay</option>
                <option value="wireframe">Wireframe</option>
              </select>
            </div>
            <div class="popover-row">
              <label class="popover-label" for="play-quality-select">Quality Tier</label>
              <select class="play-select" id="play-quality-select">
                <option value="high">High</option>
                <option value="balanced">Balanced</option>
                <option value="economy">Economy</option>
              </select>
            </div>
            <div class="popover-row-inline">
              <button class="play-btn" id="play-source-view" title="Return to calibrated source camera">Source View</button>
              <button class="play-btn" id="play-reduced-motion" aria-pressed="false" title="Toggle reduced motion">Reduced Motion</button>
              <button class="play-btn" id="play-audio" aria-pressed="false" title="Toggle spatial audio">Spatial Audio</button>
            </div>
          </div>

          <div id="play-bar" role="toolbar" aria-label="Immersive Play Controls">
            <input type="file" id="quick-upload-input" accept="image/*" style="display:none" aria-hidden="true" tabindex="-1" />
            <button class="play-btn primary" id="play-upload-image" title="Upload any image to compile it into a playable frozen-time 3D scene">Upload Image</button>
            <span class="play-sep" aria-hidden="true"></span>
            <button class="play-btn" id="play-undo" title="Undo last temporal action">Undo</button>
            <button class="play-btn" id="play-reset" title="Reset scene to initial state">Reset</button>
            <button class="play-btn" id="play-impact" title="Release highest held object or impact weight">Impact Test</button>
            <button class="play-btn" id="play-options-toggle" aria-expanded="false" aria-controls="play-options-popover">Options</button>
            <span class="play-sep" aria-hidden="true"></span>
            <button class="play-btn" id="btn-open-workbench">Workbench</button>
          </div>

          <div id="toast" role="status" aria-live="polite"></div>
        </div>

        <aside id="workbench-sidebar" aria-label="Authoring Inspector" role="tabpanel"></aside>
      </main>

      <div id="cmd-palette-backdrop" role="dialog" aria-modal="true" aria-label="Command Palette">
        <div id="cmd-palette">
          <input id="cmd-input" type="search" placeholder="Jump to stage, camera view, shading, or action..." aria-label="Filter commands" />
          <div id="cmd-list" role="listbox" aria-label="Available commands"></div>
        </div>
      </div>
    `;
  }

  async bindActiveScene() {
    this.scene = getActiveScene(this.project);
    this.sim = new TemporalSimulationEngine(this.scene, {
      onEvent: (type, payload) => {
        this.audio.playEvent(type, payload);
        if (type === 'reset' || type === 'undo') {
          this.renderer.resetVisualEffects();
        }
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
    if (!this.workbenchOpen && this.renderer) {
      // (#8) Keep Immersive Play Mode strictly free of authoring gizmos
      this.gizmoMode = 'off';
      this.renderer.setGizmoEnabled(false);
    }
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
    if (stageId !== 'assembly' && this.renderer && this.gizmoMode !== 'off') {
      this.gizmoMode = 'off';
      this.renderer.setGizmoEnabled(false);
    }
    this.syncStageUi();
    this.renderSidebar();
  }

  syncStageUi() {
    document.querySelectorAll('.stage-tab').forEach(btn => {
      const isActive = btn.dataset.stage === this.activeStage;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
      btn.setAttribute('tabindex', isActive ? '0' : '-1');
    });
    const sb = document.getElementById('workbench-sidebar');
    if (sb) sb.setAttribute('aria-labelledby', `tab-${this.activeStage}`);
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

  async runWithBusyButton(btn, busyLabel, fn) {
    if (!btn) return fn();
    const prev = btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = busyLabel;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = prev;
    }
  }

  toggleOptionsPopover(force = null) {
    const pop = document.getElementById('play-options-popover');
    const trigger = document.getElementById('play-options-toggle');
    if (!pop || !trigger) return;
    const next = force !== null ? Boolean(force) : !pop.classList.contains('open');
    pop.classList.toggle('open', next);
    trigger.setAttribute('aria-expanded', String(next));
    trigger.classList.toggle('active', next);
    if (!next) trigger.focus();
  }

  getCommandItems() {
    const items = [
      ...WORKFLOW_STAGES.map(s => ({ label: `Stage: ${s.label}`, category: 'Workbench', run: () => this.setWorkbenchOpen(true, s.id) })),
      { label: 'Mode: Immersive Play', category: 'View', run: () => this.setWorkbenchOpen(false) },
      { label: 'Shading: Shaded', category: 'Inspect', run: () => this.renderer.setInspectionMode('shaded') },
      { label: 'Shading: Clay', category: 'Inspect', run: () => this.renderer.setInspectionMode('clay') },
      { label: 'Shading: Wireframe', category: 'Inspect', run: () => this.renderer.setInspectionMode('wireframe') },
      { label: 'Simulation: Release Impact Weight', category: 'Sim', run: () => this.sim.releaseObject('obj_impact_weight') },
      { label: 'Simulation: Toggle Central Vortex', category: 'Sim', run: () => this.sim.toggleObject('obj_vortex_core') },
      { label: 'Simulation: Undo', category: 'Sim', run: () => this.sim.undo() },
      { label: 'Simulation: Reset Scene', category: 'Sim', run: () => this.sim.reset() },
      ...(this.scene?.cameras?.namedViews || []).map(v => ({
        label: `Camera: ${v.label}`,
        category: 'Camera',
        run: () => this.renderer.applyCameraPose(v),
      })),
    ];
    return items;
  }

  openCommandPalette() {
    const backdrop = document.getElementById('cmd-palette-backdrop');
    const input = document.getElementById('cmd-input');
    if (!backdrop || !input) return;
    this._cmdPrevFocus = document.activeElement;
    backdrop.classList.add('open');
    input.value = '';
    this.renderCommandList('');
    input.focus();
  }

  closeCommandPalette() {
    const backdrop = document.getElementById('cmd-palette-backdrop');
    if (!backdrop) return;
    backdrop.classList.remove('open');
    if (this._cmdPrevFocus && typeof this._cmdPrevFocus.focus === 'function') {
      this._cmdPrevFocus.focus();
    }
  }

  renderCommandList(query) {
    const list = document.getElementById('cmd-list');
    if (!list) return;
    const q = String(query || '').trim().toLowerCase();
    const matches = this.getCommandItems().filter(it => !q || it.label.toLowerCase().includes(q) || it.category.toLowerCase().includes(q));
    list.innerHTML = matches.map((it, idx) => `
      <button class="cmd-item" role="option" data-cmd-idx="${idx}">
        <span>${escapeHtml(it.label)}</span>
        <span class="badge">${escapeHtml(it.category)}</span>
      </button>
    `).join('') || '<div class="empty-state">No matching commands.</div>';

    list.querySelectorAll('[data-cmd-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const chosen = matches[Number(btn.dataset.cmdIdx)];
        this.closeCommandPalette();
        if (chosen) chosen.run();
      });
    });
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

    // Global drag-and-drop for images (.png/.jpg/.webp) and .glb files anywhere on the window
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const lower = String(file.name || '').toLowerCase();
      try {
        if (lower.endsWith('.glb')) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const receipt = await this.providers.submitJob(this.project, {
            providerId: 'manual_glb',
            sourceObjectId: this.selectedSourceObjId,
            mode: 'import',
            operatorInitiated: true,
            input: { project: this.project, bytes, label: file.name, rights: 'private_unverified' },
          });
          if (receipt.state === 'completed') {
            this.setWorkbenchOpen(true, 'assembly');
            this.notify(`Imported & validated GLB "${file.name}". Select an object in Assembly and click "Bind Whole GLB".`);
          } else {
            this.notify(receipt.message, 'error');
          }
        } else {
          const meta = await ingestImageFile(file);
          await this.applyIngestedIllustration(meta);
        }
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const open = document.getElementById('cmd-palette-backdrop')?.classList.contains('open');
        if (open) this.closeCommandPalette();
        else this.openCommandPalette();
        return;
      }

      if (e.key === 'Escape') {
        if (document.getElementById('cmd-palette-backdrop')?.classList.contains('open')) {
          this.closeCommandPalette();
          return;
        }
        if (document.getElementById('play-options-popover')?.classList.contains('open')) {
          this.toggleOptionsPopover(false);
          return;
        }
      }

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
      } else if (!this.workbenchOpen && e.key === 'Tab' && this.scene?.objects?.length) {
        e.preventDefault();
        const objs = this.scene.objects;
        const curIdx = objs.findIndex(o => o.id === this.selectedObjectId);
        const nextIdx = e.shiftKey
          ? (curIdx <= 0 ? objs.length - 1 : curIdx - 1)
          : (curIdx + 1) % objs.length;
        const nextObj = objs[nextIdx];
        this.selectedObjectId = nextObj.id;
        this.renderer.setSelectedObject(nextObj.id);
        this.notify(`Focused: ${nextObj.label} (${nextObj.temporalState}) — press Space to toggle.`);
      } else if (!this.workbenchOpen && (e.key === ' ' || e.code === 'Space') && this.selectedObjectId) {
        e.preventDefault();
        this.handleViewportObjectTap(this.selectedObjectId);
      }
    });

    // Command palette events
    document.getElementById('btn-open-cmd')?.addEventListener('click', () => this.openCommandPalette());
    document.getElementById('cmd-palette-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'cmd-palette-backdrop') this.closeCommandPalette();
    });
    document.getElementById('cmd-input')?.addEventListener('input', (e) => this.renderCommandList(e.target.value));

    // WAI-ARIA ArrowLeft/ArrowRight/Home/End roving tabindex on stage tabs ([ST-02])
    const tabList = document.querySelector('.stage-tabs');
    tabList?.addEventListener('keydown', (e) => {
      const tabs = Array.from(tabList.querySelectorAll('.stage-tab'));
      const idx = tabs.indexOf(document.activeElement);
      if (idx === -1) return;
      let next = null;
      if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next !== null) {
        e.preventDefault();
        tabs[next].focus();
        this.setStage(tabs[next].dataset.stage);
      }
    });

    document.getElementById('play-options-toggle')?.addEventListener('click', () => this.toggleOptionsPopover());
    document.getElementById('btn-open-workbench').addEventListener('click', () => {
      this.toggleOptionsPopover(false);
      this.setWorkbenchOpen(true, this.activeStage);
    });
    document.getElementById('btn-exit-workbench').addEventListener('click', () => this.setWorkbenchOpen(false));

    document.querySelectorAll('.stage-tab').forEach(btn => {
      btn.addEventListener('click', () => this.setStage(btn.dataset.stage));
    });

    // Play bar controls
    const quickUpload = document.getElementById('quick-upload-input');
    document.getElementById('play-upload-image')?.addEventListener('click', () => {
      quickUpload?.click();
    });
    quickUpload?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const meta = await ingestImageFile(file);
        await this.applyIngestedIllustration(meta);
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });
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
      if (this.sim.getObject('obj_impact_weight')) {
        if (this.sim.releaseObject('obj_impact_weight')) {
          this.notify('Impact Weight released — three-body contact chain active.');
        } else {
          this.notify('Impact Weight already active or unavailable. Press Reset to repeat.');
        }
        return;
      }
      const heldDynamic = this.scene.objects
        .filter(o => !o.physics?.isStatic && (o.temporalState === 'held' || o.temporalState === 'suspended'))
        .sort((a, b) => (b.position?.[1] || 0) - (a.position?.[1] || 0));
      if (heldDynamic.length > 0 && this.sim.releaseObject(heldDynamic[0].id)) {
        this.notify(`Released ${heldDynamic[0].label} — watch gravity & contact propagation.`);
      } else {
        this.notify('All objects already active. Press Reset to freeze time again.');
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
    const token = (this.sidebarRenderToken = (this.sidebarRenderToken || 0) + 1);

    if (this.activeStage === 'source') this.renderSourcePanel(sb);
    else if (this.activeStage === 'objects') this.renderObjectsPanel(sb);
    else if (this.activeStage === 'reconstruction') this.renderReconstructionPanel(sb);
    else if (this.activeStage === 'assembly') this.renderAssemblyPanel(sb);
    else if (this.activeStage === 'simulation') this.renderSimulationPanel(sb);
    else if (this.activeStage === 'validation') this.renderValidationPanel(sb);
    else if (this.activeStage === 'export') this.renderExportPanel(sb, token);
  }

  async applyIngestedIllustration(meta, { sensitivity = this.parseSensitivity || 'balanced' } = {}) {
    this.parseSensitivity = sensitivity;
    this.notify(`Analyzing & compiling "${meta.name}" (${meta.width}×${meta.height}, ${sensitivity}) into playable 3D characters…`);
    const compiled = await compileIllustrationToPlayableScene(this.project, meta, { sensitivity });
    this.bgBackdropVisible = true;
    this.referenceOverlayOpacity = 0;
    await this.bindActiveScene();
    if (this.workbenchOpen && this.activeStage === 'objects') {
      this.segWorkbench.setImage(meta, this.project.sourceObjects);
    }
    this.renderSidebar();
    this.notify(`Parsed "${meta.name}" into ${compiled.objectCount} playable characters/objects! Click any object to release or suspend time.`);
    return compiled;
  }

  renderSourcePanel(sb) {
    const src = this.project.project.sourceIllustration;
    const bgPlate = this.scene.environment?.backgroundRepresentation;
    const sens = this.parseSensitivity || 'balanced';
    sb.innerHTML = `
      <h2 class="stage-heading">Source & Calibration</h2>
      <div class="wb-section">
        <h3 class="wb-title">Source Illustration</h3>
        <div class="notice">
          Upload <strong>any image</strong> (PNG, JPEG, WebP, GIF) below — or <strong>drag & drop an image anywhere onto the window</strong>. Frozen Aperture runs CIELAB per-row background modeling, GrabCut refinement, and silhouette-valley character splitting offline in your browser.
        </div>
        <div class="wb-row">
          <input type="file" id="in-source-file" aria-label="Import source illustration file" accept="image/*" class="wb-input" style="flex:1" />
        </div>
        <div class="wb-row">
          <button class="wb-btn primary" id="btn-choose-source">Upload Image…</button>
          <button class="wb-btn" id="btn-load-synthetic-plate">Demo Image</button>
          <button class="wb-btn" id="btn-restore-calibration">Calibration Scene</button>
        </div>
        ${src ? `
          <img src="${src.dataUrl}" alt="Uploaded source illustration preview" style="width:100%;max-height:180px;object-fit:contain;border:1px solid var(--border-subtle);border-radius:4px;background:#05070c;margin:8px 0" />
          <div class="mono" style="margin-bottom:8px">
            <div>File: ${escapeHtml(src.name)}</div>
            <div>Dims: ${src.width} × ${src.height} (${src.mimeType})</div>
            <div>SHA-256: ${src.sha256.slice(0, 24)}…</div>
            <div>Extracted Characters / Objects: ${this.scene.objects.length}</div>
          </div>
          <div class="wb-row">
            <label for="sel-parse-sens" class="mono">Parse:</label>
            <select class="wb-select" id="sel-parse-sens" aria-label="Character parser sensitivity" style="flex:1">
              <option value="tight" ${sens === 'tight' ? 'selected' : ''}>Tight (High Contrast)</option>
              <option value="balanced" ${sens === 'balanced' ? 'selected' : ''}>Balanced (Default)</option>
              <option value="broad" ${sens === 'broad' ? 'selected' : ''}>Broad (Subtle / Dark)</option>
            </select>
            <button class="wb-btn" id="btn-reparse-image">Re-Parse</button>
          </div>
          <div class="wb-row">
            <button class="wb-btn primary" id="btn-goto-objects">Refine Masks →</button>
            <button class="wb-btn" id="btn-toggle-bg-3d">${this.bgBackdropVisible ? 'Hide Background Plate' : 'Show Background Plate'}</button>
          </div>
        ` : '<div class="empty-state">No source illustration uploaded yet. Click "Upload Image…" or drag any image onto the window.</div>'}
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Source Camera & Calibration</h3>
        <div class="wb-row">
          <label for="in-ref-opacity">Reference Opacity</label>
          <input type="range" id="in-ref-opacity" aria-label="Reference overlay opacity" min="0" max="1" step="0.05" value="${this.referenceOverlayOpacity}" style="flex:1" />
          <span class="mono">${Math.round(this.referenceOverlayOpacity * 100)}%</span>
        </div>
        <div class="wb-row">
          <button class="wb-btn" id="btn-goto-src-cam">Go to Source Camera</button>
          <button class="wb-btn" id="btn-save-src-cam">Save Pose</button>
          <button class="wb-btn primary" id="btn-solve-landmarks">Solve Landmarks</button>
        </div>
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Disocclusion Background Plate</h3>
        <div class="wb-row">
          <button class="wb-btn primary" id="btn-gen-bg-plate">Regenerate Clean Background Plate</button>
        </div>
        ${bgPlate?.mode === 'disoccluded_inpainted_plate' ? `
          <div class="mono">
            Coverage: ${Math.round((bgPlate.coverage || 0) * 100)}% · Confidence: ${Math.round((bgPlate.confidence || 0) * 100)}% · Worker: ${bgPlate.offloadedToWorker ? 'yes' : 'main'} (collisionReady: false)
          </div>
        ` : '<div class="empty-state">Generate an inpainted background plate to inspect disocclusion continuity while orbiting.</div>'}
      </div>
    `;

    sb.querySelector('#btn-choose-source')?.addEventListener('click', () => {
      sb.querySelector('#in-source-file')?.click();
    });

    sb.querySelector('#btn-reparse-image')?.addEventListener('click', async (e) => {
      if (!src) return;
      const nextSens = sb.querySelector('#sel-parse-sens')?.value || 'balanced';
      await this.runWithBusyButton(e.currentTarget, 'Parsing…', async () => {
        await this.applyIngestedIllustration(src, { sensitivity: nextSens });
      });
    });

    sb.querySelector('#btn-goto-objects')?.addEventListener('click', () => {
      this.setStage('objects');
    });

    sb.querySelector('#in-source-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const meta = await ingestImageFile(file);
        await this.applyIngestedIllustration(meta);
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#btn-load-synthetic-plate')?.addEventListener('click', async () => {
      const meta = await createSyntheticTestIllustration();
      await this.applyIngestedIllustration(meta);
    });

    sb.querySelector('#btn-restore-calibration')?.addEventListener('click', async () => {
      this.project = await createPublicCalibrationProject(this.assetManager);
      this.bgBackdropVisible = false;
      this.referenceOverlayOpacity = 0;
      await this.bindActiveScene();
      this.renderSidebar();
      this.notify('Restored Public Calibration Scene (38 physics bodies + vortex).');
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

    sb.querySelector('#btn-solve-landmarks')?.addEventListener('click', () => {
      try {
        const srcCam = this.scene.cameras.sourceCamera;
        const w = srcCam.imageWidth || 1200;
        const h = srcCam.imageHeight || 750;
        const pairs = this.scene.objects
          .filter(o => o.sourceObjectId)
          .slice(0, 4)
          .map(o => {
            const so = this.project.sourceObjects.find(s => s.id === o.sourceObjectId);
            if (!so?.bbox) return null;
            return { world3D: [...o.position], pixel2D: [so.bbox.x + so.bbox.w * 0.5, so.bbox.y + so.bbox.h * 0.5] };
          })
          .filter(Boolean);
        const solved = solveCameraFromLandmarks({ ...srcCam, imageWidth: w, imageHeight: h }, pairs);
        this.scene.cameras.sourceCamera = solved.camera;
        this.renderer.applyCameraPose(solved.camera);
        this.notify(`Landmark calibration RMSE: ${solved.initialRmsePx}px → ${solved.finalRmsePx}px.`);
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#btn-gen-bg-plate')?.addEventListener('click', async (e) => {
      await this.runWithBusyButton(e.currentTarget, 'Inpainting…', async () => {
        try {
          const prev = this.scene.environment.backgroundRepresentation;
          const plate = await generateBackgroundPlateFromSource(this.project.project.sourceIllustration, this.project.sourceObjects);
          if (prev?.worldWidth) plate.worldWidth = prev.worldWidth;
          if (prev?.worldHeight) plate.worldHeight = prev.worldHeight;
          if (prev?.worldPosition) plate.worldPosition = prev.worldPosition;
          this.scene.environment.backgroundRepresentation = plate;
          this.bgBackdropVisible = true;
          this.renderer.setBackgroundPlate(plate.dataUrl, {
            width: plate.worldWidth,
            height: plate.worldHeight,
            position: plate.worldPosition,
          });
          this.renderSidebar();
          this.notify(`Generated disoccluded background plate (${plate.inpaintedPixels} px inpainted).`);
        } catch (err) {
          this.notify(err.message, 'error');
        }
      });
    });

    sb.querySelector('#btn-toggle-bg-3d')?.addEventListener('click', () => {
      this.bgBackdropVisible = !this.bgBackdropVisible;
      const plateUrl = bgPlate?.dataUrl || src?.dataUrl || null;
      this.renderer.setBackgroundPlate(this.bgBackdropVisible ? plateUrl : null, {
        width: bgPlate?.worldWidth,
        height: bgPlate?.worldHeight,
        position: bgPlate?.worldPosition,
      });
      this.renderSidebar();
    });
  }

  renderObjectsPanel(sb) {
    const objs = this.project.sourceObjects || [];
    const sel = objs.find(o => o.id === this.selectedSourceObjId) || objs[0] || null;

    sb.innerHTML = `
      <h2 class="stage-heading">Object Extraction</h2>
      <div class="wb-section">
        <h3 class="wb-title">Extracted Source Objects (${objs.length})</h3>
        <div class="notice">
          Draw Rect/Polygon masks on the left. In <strong>Select</strong> mode, drag polygon vertices, <strong>Shift+click</strong> an edge to insert a vertex, or <strong>right-click</strong> a vertex to delete it.
        </div>
        <div class="wb-list">
          ${objs.map(o => `
            <button class="wb-list-item ${sel?.id === o.id ? 'selected' : ''}" data-src-id="${escapeHtml(o.id)}">
              <span>${escapeHtml(o.label)}</span>
              <span class="badge">${escapeHtml(o.reconstructionStatus || 'extracted')}</span>
            </button>
          `).join('') || '<div class="empty-state">No source objects extracted yet.</div>'}
        </div>
      </div>

      ${sel ? `
        <div class="wb-section">
          <h3 class="wb-title">Selected Object & Mask Refinement</h3>
          <div class="wb-row">
            <input class="wb-input" id="in-src-label" aria-label="Source object label" value="${escapeHtml(sel.label)}" style="flex:1" />
            <button class="wb-btn" id="btn-rename-src">Rename</button>
          </div>
          <div class="mono" style="margin-bottom:8px">
            ID: ${escapeHtml(sel.id)} · BBox: ${sel.bbox ? `${sel.bbox.x},${sel.bbox.y} (${sel.bbox.w}×${sel.bbox.h})` : 'none'}
          </div>
          <div class="wb-row">
            <label class="mono" for="in-mask-feather">Feather(px)</label>
            <input class="wb-input" type="number" min="0" max="24" id="in-mask-feather" value="${this.segWorkbench.featherPx}" style="width:68px" />
            <label class="mono" for="in-mask-morph">Dilate/Erode</label>
            <input class="wb-input" type="number" min="-12" max="12" id="in-mask-morph" value="${this.segWorkbench.morphologyPx}" style="width:68px" />
          </div>
          <div class="wb-row">
            <label class="mono" for="in-mask-png">Import Mask PNG:</label>
            <input type="file" id="in-mask-png" accept="image/png" class="wb-input" style="flex:1" />
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

    sb.querySelector('#in-mask-feather')?.addEventListener('change', (e) => {
      this.segWorkbench.featherPx = Math.max(0, Number(e.target.value) || 0);
    });
    sb.querySelector('#in-mask-morph')?.addEventListener('change', (e) => {
      this.segWorkbench.morphologyPx = Number(e.target.value) || 0;
    });
    sb.querySelector('#in-mask-png')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file || !sel) return;
      try {
        const meta = await ingestImageFile(file);
        this.segWorkbench.importBinaryMaskDataUrl(sel.id, meta.dataUrl);
        this.notify(`Imported binary PNG mask onto ${sel.label}.`);
      } catch (err) {
        this.notify(err.message, 'error');
      }
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
      <h2 class="stage-heading">Reconstruction Providers</h2>
      <div class="wb-section">
        <h3 class="wb-title">Available Providers</h3>
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
          <input class="wb-input" id="in-dex-url" aria-label="Local DexDiffusion endpoint URL" placeholder="http://big-mac.local:8787 (optional)" value="${escapeHtml(this.dexProvider.baseUrl)}" style="flex:1" />
          <button class="wb-btn" id="btn-probe-providers">Probe 3D & World</button>
        </div>
      </div>

      <div class="wb-section">
        <h3 class="wb-title">Manual GLB Import (Offline Ready)</h3>
        <div class="wb-row">
          <input type="file" id="in-glb-file" aria-label="Import binary GLB mesh file" accept=".glb,model/gltf-binary" class="wb-input" style="flex:1" />
        </div>
        <div class="empty-state">Imported GLBs undergo full binary glTF 2.0 structural, coordinate, bounds, and topology validation before entering the asset registry.</div>
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
          `).join('') || '<div class="empty-state">No reconstruction jobs run yet.</div>'}
        </div>
      </div>
    `;

    sb.querySelector('#btn-probe-providers')?.addEventListener('click', async (e) => {
      await this.runWithBusyButton(e.currentTarget, 'Probing…', async () => {
        const url = sb.querySelector('#in-dex-url')?.value || '';
        this.dexProvider.setBaseUrl(url);
        this.providerStatuses = await this.providers.discoverAll();
        const worldStatus = await this.dexProvider.probeWorldWorkers();
        this.renderSidebar();
        this.notify(`Probed providers (World/SHARP: ${worldStatus.state}).`);
      });
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
      <h2 class="stage-heading">Scene Assembly</h2>
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
          <h3 class="wb-title">Transform & 3D Gizmo — ${escapeHtml(sel.label)}</h3>
          <div class="mono" style="margin-bottom:8px">ID: ${escapeHtml(sel.id)} · State: ${escapeHtml(sel.temporalState)}</div>
          <div class="wb-row">
            <select class="wb-select" id="sel-gizmo-mode" aria-label="3D Transform Gizmo Mode" style="flex:1">
              <option value="off" ${this.gizmoMode === 'off' ? 'selected' : ''}>Gizmo: Off</option>
              <option value="translate" ${this.gizmoMode === 'translate' ? 'selected' : ''}>Gizmo: Translate</option>
              <option value="rotate" ${this.gizmoMode === 'rotate' ? 'selected' : ''}>Gizmo: Rotate</option>
              <option value="scale" ${this.gizmoMode === 'scale' ? 'selected' : ''}>Gizmo: Scale</option>
            </select>
            <button class="wb-btn ${this.gizmoSnap ? 'primary' : ''}" id="btn-gizmo-snap" aria-pressed="${this.gizmoSnap}">Snap: ${this.gizmoSnap ? 'ON' : 'OFF'}</button>
          </div>
          <div class="mono" style="margin-bottom:4px">Position (m)</div>
          <div class="wb-grid-3" style="margin-bottom:8px">
            <input class="wb-input" type="number" step="0.1" id="tx" aria-label="Position X in meters" value="${sel.position[0]}" />
            <input class="wb-input" type="number" step="0.1" id="ty" aria-label="Position Y in meters" value="${sel.position[1]}" />
            <input class="wb-input" type="number" step="0.1" id="tz" aria-label="Position Z in meters" value="${sel.position[2]}" />
          </div>
          <div class="mono" style="margin-bottom:4px">Scale</div>
          <div class="wb-grid-3" style="margin-bottom:10px">
            <input class="wb-input" type="number" step="0.1" min="0.1" id="sx" aria-label="Scale X" value="${sel.scale[0]}" />
            <input class="wb-input" type="number" step="0.1" min="0.1" id="sy" aria-label="Scale Y" value="${sel.scale[1]}" />
            <input class="wb-input" type="number" step="0.1" min="0.1" id="sz" aria-label="Scale Z" value="${sel.scale[2]}" />
          </div>
          <div class="wb-row">
            <button class="wb-btn primary" id="btn-apply-xform">Apply Transform</button>
            <button class="wb-btn" id="btn-focus-obj">Focus</button>
            <button class="wb-btn" id="btn-isolate-obj">${this.renderer.isolatedObjectId === sel.id ? 'Un-Isolate' : 'Isolate'}</button>
          </div>
        </div>

        <div class="wb-section">
          <h3 class="wb-title">Asset & Multi-Component Slots</h3>
          <div class="wb-row">
            <select class="wb-select" id="sel-bind-asset" aria-label="Select Validated GLB Asset" style="flex:1">
              ${validAssets.map(a => `<option value="${escapeHtml(a.id)}" ${sel.assetId === a.id ? 'selected' : ''}>${escapeHtml(a.label)} [${escapeHtml(a.lifecycleState)}]</option>`).join('')}
            </select>
          </div>
          <div class="wb-row">
            <button class="wb-btn primary" id="btn-bind-asset">Bind Whole GLB</button>
            <button class="wb-btn" id="btn-revert-asset" ${!sel.assetHistory?.length ? 'disabled' : ''}>Revert Previous</button>
            <button class="wb-btn" id="btn-autofit-col">Auto-Fit Proxy</button>
          </div>
          <div class="wb-row">
            <select class="wb-select" id="sel-comp-slot" aria-label="Select Component Slot">
              <option value="body">Slot: body</option>
              <option value="weapon">Slot: weapon</option>
              <option value="clothing">Slot: clothing</option>
              <option value="effect">Slot: effect</option>
            </select>
            <button class="wb-btn" id="btn-bind-comp">Bind Slot</button>
            <button class="wb-btn" id="btn-bake-vcol">Bake Vertex Colors</button>
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
        this.renderer.setSelectedObject(this.selectedObjectId);
        this.renderSidebar();
      });
    });

    sb.querySelector('#sel-gizmo-mode')?.addEventListener('change', (e) => {
      this.gizmoMode = e.target.value;
      this.renderer.setGizmoEnabled(this.gizmoMode !== 'off', this.gizmoMode === 'off' ? 'translate' : this.gizmoMode, this.gizmoSnap);
    });
    sb.querySelector('#btn-gizmo-snap')?.addEventListener('click', () => {
      this.gizmoSnap = !this.gizmoSnap;
      this.renderer.setGizmoEnabled(this.gizmoMode !== 'off', this.gizmoMode === 'off' ? 'translate' : this.gizmoMode, this.gizmoSnap);
      this.renderSidebar();
    });

    sb.querySelector('#btn-apply-xform')?.addEventListener('click', () => {
      if (!sel) return;
      sel.position = [Number(sb.querySelector('#tx').value) || 0, Number(sb.querySelector('#ty').value) || 0, Number(sb.querySelector('#tz').value) || 0];
      sel.scale = [Math.max(0.1, Number(sb.querySelector('#sx').value) || 1), Math.max(0.1, Number(sb.querySelector('#sy').value) || 1), Math.max(0.1, Number(sb.querySelector('#sz').value) || 1)];
      this.sim.captureInitialState();
      this.renderer.syncFromSimulation(0, this.sim);
      this.renderer.markDirty();
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

    sb.querySelector('#btn-bind-comp')?.addEventListener('click', async () => {
      const assetId = sb.querySelector('#sel-bind-asset')?.value;
      const slot = sb.querySelector('#sel-comp-slot')?.value || 'body';
      if (!sel || !assetId) return;
      try {
        this.assetManager.bindComponentSlot(this.project, this.scene, sel.id, slot, assetId);
        await this.renderer.upsertObjectMesh(sel);
        this.notify(`Bound component slot '${slot}' on ${sel.id}.`);
        this.renderSidebar();
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#btn-autofit-col')?.addEventListener('click', async () => {
      const assetId = sel?.assetId || sb.querySelector('#sel-bind-asset')?.value;
      if (!sel || !assetId) return;
      try {
        const col = this.assetManager.fitCollisionProxyFromAsset(this.project, sel, assetId, 'capsule');
        await this.renderer.upsertObjectMesh(sel);
        this.notify(`Auto-fitted ${col.shape} proxy (r=${col.radius}) from GLB bounds.`);
      } catch (err) {
        this.notify(err.message, 'error');
      }
    });

    sb.querySelector('#btn-bake-vcol')?.addEventListener('click', async () => {
      const src = this.project.project.sourceIllustration;
      const group = sel && this.renderer.objectMeshes.get(sel.id);
      if (!src?.dataUrl || !group) {
        this.notify('Load a source illustration and select a 3D mesh first.', 'warn');
        return;
      }
      try {
        const img = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = src.dataUrl;
        });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, c.width, c.height);
        const stats = bakeSourceVertexColors(group, imgData, this.scene.cameras.sourceCamera);
        this.renderer.markDirty();
        this.notify(`Baked vertex colors: ${stats.observedVertices} observed / ${stats.inferredVertices} inferred.`);
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
      <h2 class="stage-heading">Temporal Simulation</h2>
      <div class="wb-section">
        <h3 class="wb-title">Simulation Controls</h3>
        <div class="mono" style="margin-bottom:10px">
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
          <button class="wb-btn" id="sim-col-vis" aria-pressed="${this.renderer.showCollisionProxies}">${this.renderer.showCollisionProxies ? 'Hide' : 'Show'} Collision Proxies</button>
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
    const assets = this.project.assets || [];
    const canCompare = assets.length >= 2;
    const cmp = canCompare ? this.assetManager.compareCandidates(this.project, assets[0].id, assets[1].id) : null;

    sb.innerHTML = `
      <h2 class="stage-heading">Validation & QA</h2>
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
        <h3 class="wb-title">Silhouette IoU Alignment</h3>
        <div class="wb-row">
          <button class="wb-btn primary" id="btn-eval-iou">Evaluate Selected Silhouette IoU</button>
        </div>
        ${this.lastIouResult ? `
          <div class="mono" style="margin-bottom:8px">
            IoU: <strong>${this.lastIouResult.iouPercent}%</strong> · Precision: ${Math.round(this.lastIouResult.precision * 100)}% · Recall: ${Math.round(this.lastIouResult.recall * 100)}%
          </div>
          <img src="${this.lastIouResult.heatmapDataUrl}" alt="Silhouette IoU difference heatmap" style="width:100%;border:1px solid var(--border-subtle);background:#05070c" />
        ` : '<div class="empty-state">Green = match · Cyan = 3D outside mask · Magenta = source missing.</div>'}
      </div>

      ${cmp ? `
        <div class="wb-section">
          <h3 class="wb-title">Candidate Comparator</h3>
          <div class="mono">
            <div><strong>Incumbent:</strong> ${escapeHtml(cmp.incumbent.label)} (${cmp.incumbent.vertices}v / ${cmp.incumbent.triangles}t)</div>
            <div><strong>Candidate:</strong> ${escapeHtml(cmp.candidate.label)} (${cmp.candidate.vertices}v / ${cmp.candidate.triangles}t)</div>
            <div><strong>Delta:</strong> ${cmp.deltas.vertexDelta >= 0 ? '+' : ''}${cmp.deltas.vertexDelta}v · ${cmp.deltas.triangleDelta >= 0 ? '+' : ''}${cmp.deltas.triangleDelta}t · ${cmp.deltas.byteDelta >= 0 ? '+' : ''}${cmp.deltas.byteDelta}B</div>
          </div>
        </div>
      ` : ''}

      <div class="wb-section">
        <h3 class="wb-title">Asset Registry & Lifecycle (${assets.length})</h3>
        <div class="wb-list">
          ${assets.map(a => `
            <div class="wb-list-item" style="flex-direction:column;align-items:flex-start;cursor:default">
              <div style="display:flex;justify-content:space-between;width:100%">
                <strong>${escapeHtml(a.label)}</strong>
                <span class="badge ${a.validation?.valid ? 'ok' : 'err'}">${escapeHtml(a.lifecycleState)}</span>
              </div>
              <div class="mono">
                Verts: ${a.validation?.stats?.vertexCount || 0} · Tris: ${a.validation?.stats?.triangleCount || 0} · Watertight: ${a.validation?.stats?.topology?.watertight ? 'yes' : 'no'}
              </div>
              <div class="mono">SHA-256: ${a.sha256.slice(0, 18)}… · Rights: ${escapeHtml(a.rights)}</div>
              <div class="wb-row" style="margin-top:6px;margin-bottom:0;width:100%">
                <select class="wb-select" aria-label="Lifecycle state for ${escapeHtml(a.label)}" data-asset-state="${escapeHtml(a.id)}" style="flex:1">
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
          Objects: ${tel.objectCount} (Instanced: ${tel.instancedCount})<br/>
          Idle Frames Skipped: ${tel.idleFramesSkipped} · Rendered: ${tel.framesRendered}
        </div>
      </div>
    `;

    sb.querySelector('#btn-eval-iou')?.addEventListener('click', () => {
      const selObj = this.scene.objects.find(o => o.id === this.selectedObjectId && o.sourceObjectId)
        || this.scene.objects.find(o => o.sourceObjectId);
      const so = selObj && this.project.sourceObjects.find(s => s.id === selObj.sourceObjectId);
      if (!selObj || !so) {
        this.notify('Select a scene object linked to a source object mask.', 'warn');
        return;
      }
      const prevIso = this.renderer.isolatedObjectId;
      this.renderer.applyCameraPose(this.scene.cameras.sourceCamera);
      this.renderer.setIsolatedObject(selObj.id);
      this.renderer.renderFrame(true);
      const srcW = this.scene.cameras.sourceCamera.imageWidth || 1200;
      const srcH = this.scene.cameras.sourceCamera.imageHeight || 750;
      this.lastIouResult = evaluateCanvasSilhouetteIoU(this.renderer.renderer.domElement, so, srcW, srcH);
      this.renderer.setIsolatedObject(prevIso);
      this.renderer.renderFrame(true);
      this.notify(`Silhouette IoU for ${selObj.label}: ${this.lastIouResult.iouPercent}%.`);
      this.renderSidebar();
    });

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

  async renderExportPanel(sb, renderToken = this.sidebarRenderToken) {
    const [saved, quota] = await Promise.all([
      this.store.listSavedAsync(),
      this.store.getStorageEstimate(),
    ]);
    if (renderToken !== this.sidebarRenderToken || this.activeStage !== 'export') return;
    const quotaText = quota
      ? `${(quota.usageBytes / (1024 * 1024)).toFixed(2)} MB / ${(quota.quotaBytes / (1024 * 1024)).toFixed(0)} MB used`
      : 'Browser storage estimate unavailable';

    sb.innerHTML = `
      <h2 class="stage-heading">Save & Export</h2>
      <div class="wb-section">
        <h3 class="wb-title">Project Persistence — IndexedDB & Bundles</h3>
        <div class="mono" style="margin-bottom:8px">
          Project: ${escapeHtml(this.project.project.name)} (rev ${this.project.project.revision})<br/>
          Storage: ${escapeHtml(quotaText)}
        </div>
        <div class="wb-row">
          <button class="wb-btn primary" id="btn-save-proj">Save (IndexedDB)</button>
          <button class="wb-btn primary" id="btn-export-zip">Export .fap.zip</button>
          <button class="wb-btn" id="btn-export-json">Export JSON</button>
        </div>
        <div class="wb-row">
          <label class="mono" for="in-import-zip">Import .fap.zip:</label>
          <input type="file" id="in-import-zip" accept=".zip,.fap.zip,application/zip" class="wb-input" style="flex:1" />
        </div>
        <div class="wb-row">
          <label class="mono" for="in-import-json">Open JSON:</label>
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
            <div class="wb-list-item" style="cursor:default">
              <button class="wb-btn" data-load-proj="${escapeHtml(item.id)}" style="flex:1;text-align:left;border:none;background:transparent;padding:0">
                ${escapeHtml(item.name)} (rev ${item.revision})
              </button>
              <button class="wb-btn danger" data-del-proj="${escapeHtml(item.id)}" aria-label="Delete saved project ${escapeHtml(item.name)}">Delete</button>
            </div>
          `).join('') || '<div class="empty-state">No browser-saved projects yet. Click Save (IndexedDB) above to store a revision.</div>'}
        </div>
      </div>
    `;

    sb.querySelector('#btn-save-proj')?.addEventListener('click', async (e) => {
      await this.runWithBusyButton(e.currentTarget, 'Saving…', async () => {
        try {
          const res = await this.store.saveProjectAsync(this.project, this.assetManager);
          this.notify(res.message);
          this.renderSidebar();
        } catch (err) {
          this.notify(err.message, 'error');
        }
      });
    });

    sb.querySelector('#btn-export-zip')?.addEventListener('click', async (e) => {
      await this.runWithBusyButton(e.currentTarget, 'Compressing…', async () => {
        try {
          const zipBytes = await exportProjectZipBundleCompressed(this.project, this.assetManager);
          const blob = new Blob([zipBytes], { type: 'application/zip' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = sanitizeFilename(`${this.project.project.id}_rev${this.project.project.revision}.fap.zip`);
          a.click();
          URL.revokeObjectURL(url);
          this.notify(`Exported DEFLATE-compressed .fap.zip bundle (${(zipBytes.byteLength / 1024).toFixed(1)} KB).`);
        } catch (err) {
          this.notify(err.message, 'error');
        }
      });
    });

    sb.querySelector('#in-import-zip')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const { project, entryCount } = await importProjectZipBundleAsync(buf, this.assetManager);
        this.project = project;
        await this.bindActiveScene();
        this.renderSidebar();
        this.notify(`Imported .fap.zip bundle (${entryCount} entries).`);
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
          const { project } = await this.store.loadProjectAsync(btn.dataset.loadProj, this.assetManager);
          this.project = project;
          await this.bindActiveScene();
          this.renderSidebar();
          this.notify(`Loaded ${project.project.name}.`);
        } catch (err) {
          this.notify(err.message, 'error');
        }
      });
    });

    sb.querySelectorAll('[data-del-proj]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await this.store.deleteProjectAsync(btn.dataset.delProj);
          this.notify('Deleted saved browser project.');
          this.renderSidebar();
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
      this.renderer.syncFromSimulation(dt, this.sim);
      this.renderer.renderFrame(false);
      this.audio.updateListener(this.renderer.camera);
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
      releaseObject: (id) => { const r = this.sim.releaseObject(id); this.renderer.markDirty(); return r; },
      suspendObject: (id) => { const r = this.sim.suspendObject(id); this.renderer.markDirty(); return r; },
      releaseAll: () => { const r = this.sim.releaseAll(); this.renderer.markDirty(); return r; },
      undo: () => { const r = this.sim.undo(); this.renderer.markDirty(); return r; },
      reset: () => { const r = this.sim.reset(); this.renderer.markDirty(); return r; },
      stepTicks: (n) => {
        for (let i = 0; i < n; i++) this.sim.stepFixed();
        this.renderer.syncFromSimulation(n / 60, this.sim);
        this.renderer.renderFrame(true);
        return this.sim.getStats();
      },
      setWorkbenchOpen: (open, stage) => this.setWorkbenchOpen(open, stage),
      setInspectionMode: (m) => {
        this.renderer.setInspectionMode(m);
        this.renderer.renderFrame(true);
      },
      setQualityTier: (q) => {
        this.renderer.setQualityTier(q);
        this.renderer.renderFrame(true);
      },
      setReducedMotion: (f) => this.renderer.setReducedMotion(f),
      setExperienceMode: (m) => this.setExperienceMode(m),
      setGizmoMode: (mode, snap = false) => {
        this.gizmoMode = mode;
        this.gizmoSnap = snap;
        this.renderer.setGizmoEnabled(mode !== 'off', mode === 'off' ? 'translate' : mode, snap);
        this.renderer.renderFrame(true);
      },
      applyNamedView: (viewId) => {
        const v = this.scene.cameras?.namedViews?.find(x => x.id === viewId);
        if (v) {
          this.renderer.applyCameraPose(v);
          this.renderer.renderFrame(true);
        }
      },
      focusObject: (id) => {
        this.renderer.focusObject(id);
        this.renderer.renderFrame(true);
      },
      loadSyntheticPlate: async () => {
        const meta = await createSyntheticTestIllustration();
        this.project.project.sourceIllustration = meta;
        this.updateReferenceOverlay();
        if (this.workbenchOpen) this.renderSidebar();
        return meta.sha256;
      },
      compileSyntheticIllustrationTest: async () => {
        const meta = await createSyntheticTestIllustration();
        await this.applyIngestedIllustration(meta);
        this.renderer.renderFrame(true);
        return {
          objectCount: this.scene.objects.length,
          sourceLayerCount: this.scene.objects.filter(o => o.representationType === 'source_image_layer').length,
          hasBgPlate: Boolean(this.renderer.bgBackdropMesh),
          firstObjectId: this.scene.objects[0]?.id || null,
        };
      },
      loadStressScene114: async () => {
        this.project = await createPublicCalibrationProject(this.assetManager, { fragmentCount: 100 });
        await this.bindActiveScene();
        this.renderer.renderFrame(true);
        return {
          totalObjects: this.scene.objects.length,
          telemetry: this.renderer.getTelemetry(),
        };
      },
      exportStandaloneHtml: () => buildStandaloneHtmlExport(this.project, document.documentElement.outerHTML),
      exportZipBundleSize: () => exportProjectZipBundle(this.project, this.assetManager).byteLength,
    };
  }
}

const app = new FrozenApertureApp();
app.init().catch(err => {
  console.error('Frozen Aperture init failed:', err);
  const el = document.getElementById('app');
  if (el) el.innerHTML = `<pre style="color:#fda4af;padding:24px">Frozen Aperture initialization error:\n${err.stack || err.message}</pre>`;
});
