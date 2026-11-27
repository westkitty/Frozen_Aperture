# Frozen Aperture

An independent illustration-to-playable-world research lab. A scene is a collection of persistent objects, not a single decorative image. Its first experience is selective local time: touch a suspended body, let contact awaken neighbors, suspend again, undo, restore, or inspect the volume from another angle.

## Run

Open [index.html](index.html) in a hardware-accelerated browser. No server or network is required for this checked-in build. The public calibration solid is synthetic; the source-region tool is a rectangular crop, not automatic semantic segmentation. Import a self-contained GLB to inspect a real asset. The baseline does not perform reconstruction itself.

- Drag to orbit; pinch or scroll to zoom.
- Click a body to release or suspend it; use the object controls for keyboard operation.
- Reverse view and wireframe reveal real mesh geometry.
- Release the impact weight for a three-body contact test. Undo or restore to repeat.
- Import your own image and save a rectangular region for reconstruction in your chosen provider.

## Rebuild

Use Node.js and Python 3. Install the pinned direct dependencies with npm, then run npm run build. npm run check checks JavaScript syntax. Set CHROMIUM_BIN to your installed Chromium-compatible executable and run npm run test:browser for the baseline browser test. The existing build requires WebGL 2.

For an operator-supplied private GLB/image pair, run:

    python3 scripts/build.py --asset /path/to/asset.glb --source /path/to/source.png --expected-sha256 <asset-hash> --output private-sample.local.html

Private builds and runtime captures are excluded from Git. The prior local demo used an actual DexDiffusion textured GLB (320,416 positions, 578,300 triangles) and passed the three-body test. Its bytes and source image are intentionally not published here.

## Direction

The render world, reconstruction provider, and time simulation must be independent. DexDiffusion is a potential provider, never a required dependency of the standalone player. The present runtime uses simple sphere contacts and is not a production physics solver. It does not yet demonstrate reconstruction of the original APERTURE ten-figure illustration, automatic scene assembly, rigging, or learned depth. See [operational state](OPERATIONAL_STATE.md), [project bible](Frozen_Aperture_bible.md), and [adversarial review](docs/adversarial-review.md).
