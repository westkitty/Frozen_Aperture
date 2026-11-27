# Frozen Aperture — Project Bible

## 1. Identity & Core Thesis

**Frozen Aperture** is an independent illustration-to-playable-world research lab and compiler.

A scene is a collection of persistent, individually addressable objects — never a single decorative image. **Frozen Second** (selective local time) is the first experience mode; the canonical scene document is designed to drive multiple experience modes (`frozen_second`, `living_illustration`, `world_explorer`, `object_lab`, `scene_assembly`) without duplicating world state.

## 2. Architectural Laws

1. **Canonical Scene Document as Single Source of Truth**: The renderer, simulation, authoring workbench, and exporter all consume the same versioned `v1.0.0` project document (`src/core/schema.js`).
2. **Independence of Concerns**: The render world, reconstruction providers, and temporal simulation are strictly decoupled. DexDiffusion (`westkitty/Image_Gen`) is an optional replaceable provider adapter — never a hard dependency of the standalone player.
3. **Honest Representation Reporting**: Every scene object declares its true `representationType` (`source_image_layer`, `depth_aware_surface`, `volumetric_rigid_mesh`, `articulated_mesh`, `procedural_geometry`, `environmental_effect`, `background_representation`). Flat image layers are never marketed as volumetric meshes.
4. **Minimalist Play Interface Law**: Ordinary play exposes no permanent HUD, timeline, inventory, or physics dashboard. Technical authoring controls live exclusively in the separate Authoring Workbench.
5. **Temporal Integrity**:
   - Frozen bodies (`held`, `suspended`, `restored`) never advance transforms and contribute zero effective collision velocity.
   - Suspending an active body freezes it in place while preserving linear and angular velocity for later release.
   - Contact-driven propagation requires real simulation contact above the impulse threshold — never scripted pulses or decorative substitutes.
   - Quality tiers (`high`, `balanced`, `economy`) and `reducedMotion` may alter visual fidelity but never alter authoritative simulation outcomes.
6. **Privacy & Publication Boundaries**: Private artwork, unapproved generated meshes, credentials, and personal machine paths are excluded from Git (`*.local.html`, `private/`). Public builds ship safe synthetic calibration fixtures only.

## 3. Authoring Pipeline

`SOURCE → OBJECTS → RECONSTRUCTION → ASSEMBLY → SIMULATION → VALIDATION → PLAY → EXPORT`

- **Source**: Ingest validated illustrations with SHA-256 identity and original byte preservation; calibrate source camera & reference overlay.
- **Objects**: Extract individual source objects via rectangular or polygon masks, inspect overlaps, export alpha-aware crops, and promote to 3D layers.
- **Reconstruction**: Probe providers (`Manual GLB Import` offline or local `DexDiffusion`), run operator-initiated bounded jobs (`concurrency = 1`), and retain receipts.
- **Assembly**: Position objects in a shared metric coordinate system, inspect 360° named views, bind volumetric GLBs while preserving logical object IDs, and revert replacements cleanly.
- **Simulation**: Test selective release, suspension, contact chains, Central Aperture vortex activation, undo, reset, and deterministic replay.
- **Validation**: Verify schema integrity, GLB structural/topology validation, asset lifecycle transitions, and live WebGL 2 telemetry.
- **Play & Export**: Enter Immersive Play or export portable project JSON / zero-network standalone offline HTML players.
