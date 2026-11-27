#!/usr/bin/env python3
"""
Frozen Aperture — Operator-Supplied Private Asset Standalone HTML Builder

Builds a local-only standalone offline HTML player embedding a private GLB asset
and source illustration without committing private bytes into Git.

Usage:
  python3 scripts/build.py \
    --asset /path/to/asset.glb \
    --source /path/to/source.png \
    --expected-sha256 <asset-sha256> \
    --output private-sample.local.html
"""

import argparse
import base64
import hashlib
import json
import mimetypes
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_glb_header(data: bytes) -> None:
    if len(data) < 12:
        raise ValueError(f"Asset is too small to be a valid GLB ({len(data)} bytes).")
    magic, version, length = struct.unpack("<III", data[:12])
    if magic != 0x46546C67:
        raise ValueError(f"Invalid GLB magic: 0x{magic:08x} (expected 0x46546c67).")
    if version != 2:
        raise ValueError(f"Unsupported glTF version: {version} (expected 2).")
    if length != len(data):
        raise ValueError(f"Declared GLB length ({length}) != actual bytes ({len(data)}).")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a private standalone Frozen Aperture HTML player.")
    parser.add_argument("--manifest", help="Path to a multi-body private scene manifest JSON (alternative to --asset/--source).")
    parser.add_argument("--asset", help="Path to operator-supplied self-contained GLB asset.")
    parser.add_argument("--source", help="Path to operator-supplied source illustration (PNG/JPEG/WebP).")
    parser.add_argument("--expected-sha256", help="Expected SHA-256 hex digest of the GLB asset.")
    parser.add_argument("--output", required=True, help="Output path (recommended: *.local.html, excluded from Git).")
    parser.add_argument("--name", default="Frozen Aperture — Private Build", help="Project display name.")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    base_html_path = repo_root / "index.html"
    if not base_html_path.exists():
        print("Error: index.html not found. Run `npm run build` first.", file=sys.stderr)
        return 1

    out_path = Path(args.output).expanduser().resolve()

    if args.manifest:
        return build_from_manifest(Path(args.manifest).expanduser().resolve(), base_html_path, out_path, args.name)

    if not args.asset or not args.source or not args.expected_sha256:
        print("Error: Either --manifest OR (--asset, --source, --expected-sha256) are required.", file=sys.stderr)
        return 1

    asset_path = Path(args.asset).expanduser().resolve()
    source_path = Path(args.source).expanduser().resolve()

    if not asset_path.is_file():
        print(f"Error: GLB asset not found: {asset_path}", file=sys.stderr)
        return 1
    if not source_path.is_file():
        print(f"Error: Source image not found: {source_path}", file=sys.stderr)
        return 1

    glb_bytes = asset_path.read_bytes()
    actual_glb_sha = sha256_bytes(glb_bytes)
    if actual_glb_sha.lower() != args.expected_sha256.strip().lower():
        print(
            f"Error: GLB SHA-256 mismatch.\n  Expected: {args.expected_sha256}\n  Actual:   {actual_glb_sha}",
            file=sys.stderr,
        )
        return 1

    validate_glb_header(glb_bytes)

    src_bytes = source_path.read_bytes()
    src_sha = sha256_bytes(src_bytes)
    mime_type, _ = mimetypes.guess_type(str(source_path))
    if not mime_type or not mime_type.startswith("image/"):
        mime_type = "image/png"

    now = datetime.now(timezone.utc).isoformat()
    asset_id = f"asset_private_{actual_glb_sha[:10]}"

    project_doc = {
        "schemaVersion": "1.0.0",
        "project": {
            "id": f"proj_private_{actual_glb_sha[:8]}",
            "name": args.name,
            "revision": 1,
            "createdAt": now,
            "modifiedAt": now,
            "isPublicFixture": False,
            "activeSceneId": "scene_main",
            "sourceIllustration": {
                "name": source_path.name,
                "mimeType": mime_type,
                "byteLength": len(src_bytes),
                "width": 1600,
                "height": 1000,
                "sha256": src_sha,
                "dataUrl": f"data:{mime_type};base64,{base64.b64encode(src_bytes).decode('ascii')}",
                "ingestedAt": now,
            },
        },
        "sourceObjects": [
            {
                "id": "src_primary_asset",
                "label": asset_path.stem,
                "category": "figure",
                "bbox": {"x": 520, "y": 200, "w": 560, "h": 620},
                "mask": None,
                "depthOrder": 1,
                "reconstructionStatus": "prototype_approved",
                "confidence": 1.0,
            }
        ],
        "assets": [
            {
                "id": asset_id,
                "revision": 1,
                "label": asset_path.name,
                "format": "glb",
                "sha256": actual_glb_sha,
                "byteLength": len(glb_bytes),
                "sourceObjectId": "src_primary_asset",
                "componentSlot": "full",
                "parentAssetId": None,
                "provider": "operator_private_build",
                "model": None,
                "rights": "private_operator_supplied",
                "publicationAllowed": False,
                "surfaceClassification": "observed",
                "lifecycleState": "prototype_approved",
                "validation": {
                    "valid": True,
                    "errors": [],
                    "warnings": [],
                    "stats": {"byteLength": len(glb_bytes)},
                    "checkedAt": now,
                },
                "history": [
                    {"at": now, "from": None, "to": "prototype_approved", "reason": "Verified SHA-256 via scripts/build.py"}
                ],
                "embeddedBase64": base64.b64encode(glb_bytes).decode("ascii"),
                "createdAt": now,
                "modifiedAt": now,
            }
        ],
        "scenes": [
            {
                "id": "scene_main",
                "name": "Private Operator Scene",
                "coordinateSystem": {"units": "meters", "upAxis": "Y", "handedness": "right"},
                "cameras": {
                    "sourceCamera": {
                        "projection": "perspective",
                        "fovDeg": 42,
                        "near": 0.1,
                        "far": 200,
                        "position": [0, 1.8, 7.5],
                        "target": [0, 1.2, 0],
                        "up": [0, 1, 0],
                        "imageWidth": 1600,
                        "imageHeight": 1000,
                        "calibrated": True,
                        "landmarks": [],
                    },
                    "namedViews": [
                        {"id": "source", "label": "Source View", "position": [0, 1.8, 7.5], "target": [0, 1.2, 0], "fovDeg": 42},
                        {"id": "side_left", "label": "Side Left", "position": [-6.5, 1.8, 1.5], "target": [0, 1.2, 0], "fovDeg": 42},
                        {"id": "rear", "label": "Rear Inspection", "position": [0, 2.0, -7.5], "target": [0, 1.2, 0], "fovDeg": 42},
                        {"id": "overhead", "label": "Overhead", "position": [0, 9.5, 1.5], "target": [0, 0.8, 0], "fovDeg": 46},
                    ],
                    "bookmarks": [],
                },
                "environment": {"backgroundColor": "#05070c", "fogDensity": 0.018, "floorReflectivity": 0.35, "vortexId": "obj_vortex_core"},
                "objects": [
                    {
                        "id": "obj_vortex_core",
                        "label": "Central Aperture Vortex",
                        "category": "vortex",
                        "isVortex": True,
                        "vortexRadius": 8.5,
                        "vortexStrength": 7.5,
                        "representationType": "environmental_effect",
                        "assetId": None,
                        "sourceObjectId": None,
                        "position": [0, 2.1, -1.6],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "pivot": [0, 0, 0],
                        "parentId": None,
                        "temporalState": "held",
                        "velocity": [0, 0, 0],
                        "angularVelocity": [0, 0, 1.4],
                        "collision": {"shape": "trigger", "radius": 1.0, "enabled": True},
                        "physics": {"mass": 10.0, "restitution": 0.3, "gravityScale": 0, "isStatic": False},
                        "material": {"color": "#05070b", "emissive": "#38bdf8", "roughness": 0.08, "metalness": 0.92},
                        "visible": True,
                        "interactive": True,
                    },
                    {
                        "id": "obj_private_primary",
                        "label": asset_path.stem,
                        "category": "figure",
                        "representationType": "volumetric_rigid_mesh",
                        "assetId": asset_id,
                        "sourceObjectId": "src_primary_asset",
                        "position": [0, 1.2, 0.5],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                        "pivot": [0, 0, 0],
                        "parentId": None,
                        "temporalState": "held",
                        "velocity": [0, 0, 0],
                        "angularVelocity": [0, 0, 0],
                        "collision": {"shape": "capsule", "radius": 0.45, "halfHeight": 0.55, "enabled": True},
                        "physics": {"mass": 2.2, "restitution": 0.35, "gravityScale": 1.0, "isStatic": False},
                        "material": {"color": "#ffffff", "emissive": "#000000", "roughness": 0.4, "metalness": 0.2},
                        "visible": True,
                        "interactive": True,
                    },
                ],
                "simulation": {
                    "fixedDt": 1 / 60,
                    "gravity": [0, -9.81, 0],
                    "linearDamping": 0.04,
                    "angularDamping": 0.08,
                    "restitution": 0.42,
                    "contactActivationImpulseThreshold": 0.15,
                    "seed": 20261126,
                    "tick": 0,
                    "initialState": [],
                    "tickLog": [],
                    "contactEvents": [],
                },
            }
        ],
        "jobs": [],
        "settings": {
            "qualityTier": "high",
            "reducedMotion": False,
            "audioMuted": False,
            "audioVolume": 0.55,
            "defaultExperienceMode": "frozen_second",
        },
    }

    safe_json = json.dumps(project_doc).replace("</script", "<\\/script")
    injection = f"<script>window.__FROZEN_APERTURE_EMBEDDED_PROJECT__ = {safe_json};</script>"
    base_html = base_html_path.read_text(encoding="utf-8")
    if "</head>" not in base_html:
        print("Error: index.html does not contain </head>.", file=sys.stderr)
        return 1

    out_html = base_html.replace("</head>", f"{injection}\n</head>", 1)
    out_path.write_text(out_html, encoding="utf-8")
    print(f"Built private standalone HTML: {out_path} ({len(out_html) // 1024} KB)")
    print(f"Verified GLB SHA-256: {actual_glb_sha}")
    print(f"Recorded Source SHA-256: {src_sha}")
    return 0


def build_from_manifest(manifest_path: Path, base_html_path: Path, out_path: Path, default_name: str) -> int:
    if not manifest_path.is_file():
        print(f"Error: Manifest not found: {manifest_path}", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    base_dir = manifest_path.parent
    now = datetime.now(timezone.utc).isoformat()

    src_info = None
    if manifest.get("source"):
        sp = (base_dir / manifest["source"]).resolve()
        if not sp.is_file():
            print(f"Error: Manifest source image not found: {sp}", file=sys.stderr)
            return 1
        src_bytes = sp.read_bytes()
        src_sha = sha256_bytes(src_bytes)
        if manifest.get("sourceSha256") and src_sha.lower() != manifest["sourceSha256"].lower():
            print(f"Error: Source SHA-256 mismatch ({src_sha}).", file=sys.stderr)
            return 1
        mime_type, _ = mimetypes.guess_type(str(sp))
        if not mime_type or not mime_type.startswith("image/"):
            mime_type = "image/png"
        src_info = {
            "name": sp.name,
            "mimeType": mime_type,
            "byteLength": len(src_bytes),
            "width": int(manifest.get("sourceWidth", 1600)),
            "height": int(manifest.get("sourceHeight", 1000)),
            "sha256": src_sha,
            "dataUrl": f"data:{mime_type};base64,{base64.b64encode(src_bytes).decode('ascii')}",
            "ingestedAt": now,
        }

    assets = []
    scene_objects = []
    for idx, entry in enumerate(manifest.get("objects", [])):
        obj_id = entry.get("id") or f"obj_manifest_{idx + 1:03d}"
        asset_id = None
        rep_type = entry.get("representationType", "procedural_geometry")

        if entry.get("glb"):
            gp = (base_dir / entry["glb"]).resolve()
            if not gp.is_file():
                print(f"Error: Manifest GLB not found for {obj_id}: {gp}", file=sys.stderr)
                return 1
            glb_bytes = gp.read_bytes()
            actual_sha = sha256_bytes(glb_bytes)
            expected_sha = entry.get("expectedSha256")
            if not expected_sha or actual_sha.lower() != expected_sha.strip().lower():
                print(f"Error: GLB SHA-256 mismatch for {obj_id}: expected {expected_sha}, got {actual_sha}", file=sys.stderr)
                return 1
            validate_glb_header(glb_bytes)
            asset_id = f"asset_{obj_id}_{actual_sha[:8]}"
            rep_type = "volumetric_rigid_mesh"
            assets.append({
                "id": asset_id,
                "revision": 1,
                "label": gp.name,
                "format": "glb",
                "sha256": actual_sha,
                "byteLength": len(glb_bytes),
                "sourceObjectId": entry.get("sourceObjectId"),
                "componentSlot": entry.get("componentSlot", "full"),
                "provider": "operator_manifest_build",
                "rights": "private_operator_supplied",
                "publicationAllowed": False,
                "surfaceClassification": "observed",
                "lifecycleState": "prototype_approved",
                "validation": {"valid": True, "errors": [], "warnings": [], "stats": {"byteLength": len(glb_bytes)}, "checkedAt": now},
                "history": [{"at": now, "from": None, "to": "prototype_approved", "reason": "Verified SHA-256 via scripts/build.py --manifest"}],
                "embeddedBase64": base64.b64encode(glb_bytes).decode("ascii"),
                "createdAt": now,
                "modifiedAt": now,
            })

        scene_objects.append({
            "id": obj_id,
            "label": entry.get("label", obj_id),
            "category": entry.get("category", "figure"),
            "isVortex": bool(entry.get("isVortex", False)),
            "representationType": rep_type,
            "assetId": asset_id,
            "sourceObjectId": entry.get("sourceObjectId"),
            "position": entry.get("position", [0, 1.2, 0]),
            "rotation": entry.get("rotation", [0, 0, 0]),
            "scale": entry.get("scale", [1, 1, 1]),
            "pivot": [0, 0, 0],
            "parentId": None,
            "temporalState": entry.get("temporalState", "held"),
            "velocity": entry.get("velocity", [0, 0, 0]),
            "angularVelocity": entry.get("angularVelocity", [0, 0, 0]),
            "collision": entry.get("collision", {"shape": "capsule", "radius": 0.45, "halfHeight": 0.55, "enabled": True}),
            "physics": entry.get("physics", {"mass": 2.0, "restitution": 0.35, "gravityScale": 1.0, "isStatic": False}),
            "material": entry.get("material", {"color": "#38bdf8", "emissive": "#000000", "roughness": 0.4, "metalness": 0.3}),
            "visible": True,
            "interactive": True,
        })

    project_doc = {
        "schemaVersion": "1.0.0",
        "project": {
            "id": manifest.get("id", "proj_private_manifest"),
            "name": manifest.get("name", default_name),
            "revision": 1,
            "createdAt": now,
            "modifiedAt": now,
            "isPublicFixture": False,
            "activeSceneId": "scene_main",
            "sourceIllustration": src_info,
        },
        "sourceObjects": manifest.get("sourceObjects", []),
        "assets": assets,
        "scenes": [{
            "id": "scene_main",
            "name": manifest.get("sceneName", "Private Multi-Body Scene"),
            "coordinateSystem": {"units": "meters", "upAxis": "Y", "handedness": "right"},
            "cameras": manifest.get("cameras", {
                "sourceCamera": {"projection": "perspective", "fovDeg": 42, "near": 0.1, "far": 200, "position": [0, 1.8, 12.5], "target": [0, 1.4, 0], "up": [0, 1, 0], "imageWidth": 1600, "imageHeight": 1000, "calibrated": True, "landmarks": []},
                "namedViews": [
                    {"id": "source", "label": "Source View", "position": [0, 1.8, 12.5], "target": [0, 1.4, 0], "fovDeg": 42},
                    {"id": "rear", "label": "Rear Inspection", "position": [0, 2.0, -12.0], "target": [0, 1.4, 0], "fovDeg": 42},
                ],
                "bookmarks": [],
            }),
            "environment": {"backgroundColor": "#05070c", "fogDensity": 0.018, "floorReflectivity": 0.35, "vortexId": manifest.get("vortexId")},
            "objects": scene_objects,
            "simulation": {"fixedDt": 1 / 60, "gravity": [0, -9.81, 0], "linearDamping": 0.04, "angularDamping": 0.08, "restitution": 0.42, "contactActivationImpulseThreshold": 0.15, "seed": 20261126, "tick": 0, "initialState": [], "tickLog": [], "contactEvents": []},
        }],
        "jobs": [],
        "settings": {"qualityTier": "high", "reducedMotion": False, "audioMuted": False, "audioVolume": 0.55, "defaultExperienceMode": "frozen_second"},
    }

    safe_json = json.dumps(project_doc).replace("</script", "<\\/script")
    injection = f"<script>window.__FROZEN_APERTURE_EMBEDDED_PROJECT__ = {safe_json};</script>"
    base_html = base_html_path.read_text(encoding="utf-8")
    out_html = base_html.replace("</head>", f"{injection}\n</head>", 1)
    out_path.write_text(out_html, encoding="utf-8")
    print(f"Built multi-body private HTML: {out_path} ({len(scene_objects)} objects, {len(assets)} verified GLBs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
