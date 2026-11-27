# Frozen Aperture — Operational State

**Last Updated**: 2026-11-26
**Repository**: `https://github.com/westkitty/Frozen_Aperture`
**Active Branch**: `main`
**Pre-Milestone Checkpoint Tag**: `checkpoint/pre-milestone-8456584` (`845658466ad200b622475c487b6bf43c86d73dbe`)
**Milestone Status**: **Partially Complete (Testing-Ready Public Infrastructure Complete; Private APERTURE Artwork & Approved Sentinel GLB Unavailable in Cloud VM)**

---

## 1. Baseline Recovery Findings (Truthful Record)

Before modifying any files, the repository, Git history, GitHub metadata, and connected Google Drive were inspected:

- **Repository Baseline**: Commit `8456584` (`Initialize Frozen Aperture`) contained only `README.md` (27 lines). No source code, `package.json`, `index.html`, `OPERATIONAL_STATE.md`, `Frozen_Aperture_bible.md`, or `docs/adversarial-review.md` existed in Git.
- **Missing Private Assets (Not Present in Cloud VM, GitHub, or Google Drive)**:
  - `FROZEN_APERTURE_Directors_Cut.html`
  - `THE_FROZEN_SECOND_APERTURE.html`
  - `THE_FROZEN_SECOND_APERTURE_P003_HYBRID.html`
  - `azure_sentinel_input.png`
  - `azure_sentinel_mask.png`
  - `azure_sentinel_repair_candidate.glb`
  - `azure_sentinel_source_color.glb`
  - `color_report.json` / `repair_report.json`
- **Honesty & Privacy Rule**: No private artwork or Sentinel GLB was fabricated. The public build ships a clearly labeled **Public Synthetic Calibration Scene** (`src/fixtures/calibration-scene.js`) with genuine watertight synthetic GLBs (`src/assets/synthetic-glb.js`). Private assets can be bound locally via the Authoring Workbench (`Source` → `Reconstruction` → `Assembly`) or via `python3 scripts/build.py --asset ... --source ... --expected-sha256 ... --output private-sample.local.html` (excluded from Git by `.gitignore`).

---

## 2. Implemented Capabilities (Testing-Ready Milestone)

- **Canonical Versioned Project & Scene Schema (`v1.0.0`)** (`src/core/schema.js`): Project identity, source objects, asset lifecycle records, scene objects with explicit `representationType`, calibrated source camera + named views, simulation settings, validation, backward-compatible `0.9.x` → `1.0.0` migration, and unknown-field preservation.
- **Binary glTF 2.0 / GLB Structural & Geometry Validator** (`src/assets/glb-validator.js`): Magic/version/length checks, chunk boundary validation, accessor/bufferView bounds, finite vertex checks, index bounds, external URI rejection, degenerate triangle and manifold/watertight edge analysis.
- **Asset Lifecycle & Reversible Replacement** (`src/assets/asset-manager.js`): `imported` → `structurally_valid` → `visually_inspected` → `reconstruction_candidate` → `prototype_approved` → `production_approved` / `rejected` / `superseded`, candidate side-by-side comparison, component-slot lineage, and reversible binding preserving logical object IDs.
- **Replaceable Reconstruction Providers** (`src/providers/provider-interface.js`, `src/providers/dexdiffusion-adapter.js`):
  - `ManualGlbProvider`: Always available offline.
  - `DexDiffusionAdapter`: Verified read-only against `westkitty/Image_Gen/operator-console/server.js` and `asset3d-bridge.js` (`GET /api/3d/workers`, `POST /api/3d/jobs`, `GET /api/jobs/:jobId`, `POST /api/jobs/:id/cancel`, `GET /api/world/workers`, `GET /api/media/:id/download`). Reports honest unavailable/unconfigured state without modifying DexDiffusion.
  - Enforces explicit operator initiation and bounded concurrency (`maxConcurrency = 1`).
- **Source Ingestion & 2D Segmentation Workbench** (`src/source/image-ingestor.js`, `src/source/segmentation-canvas.js`): Image MIME/dimension/pixel validation, SHA-256 hashing, pan/zoom/fit/1:1, rectangular & polygon mask creation, mask inversion, overlap overlays, undo, alpha-aware PNG crop export, and promotion into 3D as `source_image_layer`.
- **Authoritative Selective Local-Time Simulation** (`src/simulation/temporal-engine.js`, `src/simulation/collision.js`): Fixed-step `1/60s` clock, spatial-hash broadphase with deterministic ID-sorted pair ordering, multi-shape narrowphase (`sphere`, `box`, `capsule`, `trigger`), zero effective collision velocity for frozen bodies (no stored-velocity leakage), genuine contact-driven activation, Central Aperture vortex field (strictly obeys `temporalState`), Undo, Reset, and Deterministic Replay.
- **WebGL 2 Renderer & Spatial Audio** (`src/render/scene-renderer.js`, `src/render/audio-engine.js`): Offline Three.js GLB parsing, glossy black-liquid Central Aperture, Shaded/Clay/Wireframe/Collision-Proxy modes, 360° named inspection views, tap-vs-drag/pinch disambiguation, bounded VFX ripple pool, quality tiers (`high`/`balanced`/`economy`), reduced-motion mode, and user-gesture-gated procedural Web Audio.
- **Two Distinct Presentation Modes** (`src/main.js`, `src/styles.css`): Minimalist Immersive Play Mode (no permanent HUD) + 8-stage Authoring Workbench (`SOURCE → OBJECTS → RECONSTRUCTION → ASSEMBLY → SIMULATION → VALIDATION → PLAY → EXPORT`) + 5 Experience Modes (`frozen_second`, `living_illustration`, `world_explorer`, `object_lab`, `scene_assembly`).
- **Persistence & Offline Export** (`src/core/project-store.js`, `src/export/offline-exporter.js`, `scripts/build.mjs`, `scripts/build.py`): Browser `localStorage` revisions, portable JSON import/export, standalone offline HTML export (`index.html`), and private CLI builder (`scripts/build.py`).

---

## 3. Verification Status

- `npm run fixtures`: Generates public deterministic Fixtures A–E (`fixtures/fixture-*.json`).
- `npm run check`: Syntax validation across all JS/MJS modules.
- `npm test`: 13/13 automated unit & integration tests passing.
- `npm run test:browser`: 10/10 headless Chromium WebGL 2 acceptance checks passing (`file://` offline load, zero external requests, zero uncaught errors), machine-readable report at `reports/validation-report.json`.
- **Unverified / Externally Blocked**:
  - Private APERTURE 114-body scene and approved 31,576-vertex Azure Sentinel GLB could not be tested in this cloud VM because the private files are located on the user's MacBook / Big Mac and are excluded from public Git.
  - Physical MacBook GPU and physical mobile device frame pacing have not been measured (browser QA ran on headless Linux SwiftShader software WebGL 2).
  - Live DexDiffusion Big Mac 3D worker execution was not run from the cloud VM (Big Mac LAN/Tailscale endpoint is not reachable from the remote VM).

---

## 4. Next Recommended Operator Steps

1. Pull `main` on the MacBook and run `npm ci && npm run build && npm test`.
2. Open `index.html` in a hardware-accelerated browser and test the Public Calibration Scene + Workbench.
3. Build a private local test player using `scripts/build.py` with the approved `azure_sentinel_source_color.glb` and original APERTURE illustration (outputs `*.local.html`, gitignored).
4. Optionally configure the Big Mac DexDiffusion URL in Workbench → `Reconstruction` to probe `GET /api/3d/workers` and run a single bounded candidate reconstruction experiment.
