# Final Adversarial Review & Remaining Defect Register

**Review Date**: 2026-11-26
**Scope**: Complete testing-ready public infrastructure milestone (`main`)

---

## Adversarial Readiness Checklist

| Question | Answer | Evidence |
| :--- | :--- | :--- |
| Is this still the original project? | **Yes** | Preserves selective local time, 3-body impact test, Central Aperture vortex, source-camera alignment, clay/wireframe inspection, offline HTML playback, and `scripts/build.py` private CLI contract. |
| Are all apparent controls genuinely functional? | **Yes** | Every play-bar control and all 8 workbench stages execute real state mutations, validations, or exports; zero dead buttons. |
| Can a new illustration enter the workflow? | **Yes** | `Source` ingests PNG/JPEG/WebP with MIME/dimension/SHA-256 validation; `Objects` extracts rect/polygon masks and promotes alpha crops to 3D `source_image_layer`. |
| Can an imported mesh replace a layer? | **Yes** | `AssetManager.bindAssetToSceneObject` + `Assembly` panel bind validated GLBs while preserving logical object ID and supporting 1-click revert. |
| Does local time genuinely affect simulation? | **Yes** | Verified in `tests/run-tests.mjs` (#7–#10) and `tests/browser-acceptance.mjs`: frozen bodies stay stationary, stored velocity never leaks into active collisions, real contact awakens `held` targets. |
| Is the standalone player genuinely offline? | **Yes** | `index.html` bundles Three.js and all modules inline; verified under `file://` in headless Chromium with `external=0` network requests. |
| Are representation types honestly reported? | **Yes** | Every object displays its exact `representationType`; public build explicitly labels its synthetic calibration plate and solids. |
| Can a fresh clone reproduce the build? | **Yes** | `npm ci && npm run build && npm run check && npm test` verified from clean state. |
| Are private assets protected? | **Yes** | `.gitignore` excludes `*.local.html`, `*.local.glb`, `private/`, `reports/screenshots/`; zero private artwork or machine paths committed. |

---

## Remaining Defect Register

### CRITICAL
- *None in public infrastructure.*

### HIGH
- **DEF-001 (External Prerequisite)**: Private APERTURE ten-figure illustration, 114-body scene data, and approved 31,576-vertex Azure Sentinel GLB (`azure_sentinel_source_color.glb`) were not present in the cloud VM, GitHub repo, or Google Drive. Private scene regression testing must be executed on the MacBook using `scripts/build.py` or local Workbench import.

### MEDIUM
- **DEF-002 (Physics Fidelity)**: Narrowphase collision supports `sphere`, `box`, `capsule`, and `trigger` proxies with Baumgarte positional correction, but does not yet implement continuous swept collision (CCD) for ultra-high-speed thin geometry or compound convex hulls. Acceptable for testing milestone; evaluate Rapier only if representative stress fixtures demonstrate tunneling.
- **DEF-003 (Hardware Performance Baseline)**: Browser acceptance and frame-time telemetry were captured on headless Linux Chromium ANGLE SwiftShader (software WebGL 2). Native MacBook GPU and physical mobile browser profiling remain to be captured on hardware.
- **DEF-004 (DexDiffusion Live E2E)**: `DexDiffusionAdapter` endpoints were verified read-only against `westkitty/Image_Gen/operator-console/server.js` and `asset3d-bridge.js`, and unavailable/blocked handling is unit-tested, but a live Big Mac `POST /api/3d/jobs` run could not be executed from the isolated cloud VM.

### LOW
- **DEF-005 (Mask Import UI)**: `SegmentationWorkbench` supports rect/polygon drawing, inversion, overlap overlays, undo, and alpha PNG export; adding a direct binary PNG mask file-upload importer in the `Objects` toolbar is a straightforward future enhancement.
- **DEF-006 (Bundle Size)**: Standalone `index.html` is ~721 KB because Three.js + OrbitControls + GLTFLoader are inlined for zero-network offline playback; tree-shaking custom Three.js builds could reduce size further if needed.
