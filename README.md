# Frozen Aperture

An independent illustration-to-playable-world research lab and compiler. A scene is a collection of persistent objects, not a single decorative image. Its first experience is selective local time (**Frozen Second**): touch a suspended body, let contact awaken neighbors, suspend again, undo, restore, or inspect the volume from another angle.

## Quick Start (Offline Standalone Player)

Open [index.html](index.html) directly in a hardware-accelerated WebGL 2 browser. **No server or network connection is required.**

The checked-in build ships a **Public Synthetic Calibration Scene** (central black-liquid aperture vortex, 10 synthetic calibration figure slots including a genuine watertight volumetric GLB solid, a deterministic three-body impact test, and orbiting fragments). Private APERTURE artwork and generated private meshes are intentionally excluded from public Git.

### Immersive Play Controls
- **Drag** to orbit; **scroll / pinch** to zoom (camera gestures never accidentally release objects).
- **Click / tap** any body to release or suspend its local time.
- **Impact Test** releases the impact weight for a deterministic three-body contact chain; **Undo** or **Reset** to repeat.
- Switch experience modes (`Frozen Second`, `Living Illustration`, `World Explorer`, `Object Lab`, `Scene Assembly`), inspection shading (`Shaded`, `Clay`, `Wireframe`), quality tiers (`High`, `Balanced`, `Economy`), `Motion` (reduced-motion), and spatial `Audio`.
- Click **Workbench** to enter the 8-stage Authoring Workbench (`SOURCE → OBJECTS → RECONSTRUCTION → ASSEMBLY → SIMULATION → VALIDATION → PLAY → EXPORT`).

## Build & Test from Clean Checkout

Requires **Node.js 22+** and **Python 3.10+**.

```bash
# 1. Install pinned dependencies
npm ci

# 2. Generate deterministic public test fixtures (A-E)
npm run fixtures

# 3. Build standalone offline index.html (zero external network deps)
npm run build

# 4. Syntax check + automated regression suite
npm run check
npm test

# 5. Headless Chromium WebGL 2 browser acceptance & visual QA
CHROMIUM_BIN=/usr/bin/google-chrome npm run test:browser
```

## Building a Private Local Player (Operator-Supplied Assets)

For an operator-supplied private GLB/image pair (kept strictly local and excluded from Git via `*.local.html`):

```bash
python3 scripts/build.py \
  --asset /path/to/asset.glb \
  --source /path/to/source.png \
  --expected-sha256 <asset-sha256> \
  --output private-sample.local.html
```

## Architecture & Documentation

- [Project Bible](Frozen_Aperture_bible.md) — Architectural laws, temporal integrity, and authoring pipeline.
- [Operational State](OPERATIONAL_STATE.md) — Baseline recovery, verified results, missing private dependencies, and next steps.
- [Adversarial Review & Defect Register](docs/adversarial-review.md) — Readiness audit and severity-classified open issues.
- [Validation Report](reports/validation-report.json) — Machine-readable browser acceptance & telemetry evidence.

### Core Modules
- `src/core/` — Versioned `v1.0.0` project/scene schema, migration, SHA-256 hashing, security/budget guards, persistence store.
- `src/source/` — Validated image ingestion and 2D segmentation workbench (rect/polygon masks, overlaps, alpha crop export).
- `src/assets/` — Binary glTF 2.0 / GLB structural & topology validator, asset lifecycle manager, reversible replacement, synthetic GLB builder.
- `src/providers/` — Replaceable reconstruction provider interface (`ManualGlbProvider` offline + read-only-verified `DexDiffusionAdapter`).
- `src/simulation/` — Fixed-step (`1/60s`) selective local-time physics engine, spatial-hash broadphase, undo/reset/deterministic replay.
- `src/render/` — Three.js WebGL 2 renderer (offline GLB parsing, glossy Central Aperture, inspection modes, bounded VFX) + procedural Web Audio.
- `src/export/` — Standalone offline HTML exporter.
