/**
 * Frozen Aperture — Public Synthetic Calibration Scene Builder
 *
 * IMPORTANT PRIVACY & HONESTY BOUNDARY:
 * This builder produces a PUBLIC SYNTHETIC CALIBRATION SCENE with zero private artwork.
 * It exercises the full Frozen Aperture architecture (central black-liquid vortex,
 * 10 distinct calibration figure slots, 1 genuine watertight volumetric GLB calibration solid,
 * 3-body impact chain, orbiting suspended shards, mixed representation types) without
 * claiming to be the private APERTURE illustration or the private Azure Sentinel GLB.
 */

import { createEmptyProject, getActiveScene } from '../core/schema.js';
import { createCalibrationSolidGlb, createOctahedronGlb } from '../assets/synthetic-glb.js';

export async function createPublicCalibrationProject(assetManager, { fragmentCount = 24 } = {}) {
  const project = createEmptyProject({
    id: 'proj_public_calibration_v1',
    name: 'Frozen Aperture — Public Calibration Scene',
    isPublicFixture: true,
  });

  const scene = getActiveScene(project);
  scene.name = 'Public Synthetic Calibration World';
  scene.environment.vortexId = 'obj_vortex_core';

  // Generate genuine watertight volumetric GLB assets for calibration
  const sentinelCalBytes = createCalibrationSolidGlb({
    name: 'SyntheticCalibrationSentinel',
    radius: 0.48,
    height: 1.75,
    radialSegments: 18,
    heightSegments: 12,
    baseColor: [0.22, 0.68, 0.96, 1.0],
  });
  const crystalBytes = createOctahedronGlb({
    name: 'SyntheticImpactCrystal',
    radius: 0.42,
    baseColor: [0.95, 0.36, 0.52, 1.0],
  });

  const { asset: sentinelCalAsset } = await assetManager.registerGlbAsset(project, {
    bytes: sentinelCalBytes,
    label: 'Synthetic Calibration Solid (Volumetric GLB)',
    sourceObjectId: 'src_fig_01',
    componentSlot: 'body',
    provider: 'synthetic_calibration',
    rights: 'public_synthetic',
    surfaceClassification: 'manually_authored',
    notes: 'Public watertight synthetic calibration solid for 360-degree volumetric inspection.',
  });
  assetManager.transitionAssetState(project, sentinelCalAsset.id, 'prototype_approved', 'Approved public synthetic calibration solid');

  const { asset: crystalAsset } = await assetManager.registerGlbAsset(project, {
    bytes: crystalBytes,
    label: 'Synthetic Impact Weight (Volumetric GLB)',
    sourceObjectId: 'src_impact_weight',
    componentSlot: 'full',
    provider: 'synthetic_calibration',
    rights: 'public_synthetic',
    surfaceClassification: 'manually_authored',
    notes: 'Public synthetic impact weight for deterministic three-body contact test.',
  });
  assetManager.transitionAssetState(project, crystalAsset.id, 'prototype_approved', 'Approved synthetic impact solid');

  // 1. Central Aperture Vortex
  scene.objects.push({
    id: 'obj_vortex_core',
    label: 'Central Aperture Vortex',
    category: 'vortex',
    isVortex: true,
    vortexRadius: 9.5,
    vortexStrength: 8.5,
    representationType: 'environmental_effect',
    assetId: null,
    sourceObjectId: 'src_vortex',
    position: [0, 2.35, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    pivot: [0, 0, 0],
    parentId: null,
    temporalState: 'held',
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 1.4],
    collision: { shape: 'trigger', radius: 1.15, enabled: true },
    physics: { mass: 10.0, restitution: 0.3, gravityScale: 0, isStatic: false },
    material: { color: '#05070b', emissive: '#38bdf8', roughness: 0.08, metalness: 0.92 },
    visible: true,
    interactive: true,
  });

  // 2. Ten Calibration Figure Slots in a theatrical crescent around the Central Aperture
  const figureSpecs = [
    { id: 'obj_fig_01_sentinel_cal', srcId: 'src_fig_01', label: 'Calibration Sentinel (Volumetric GLB)', pos: [-3.2, 1.35, 1.6], color: '#38bdf8', emissive: '#0ea5e9', rep: 'volumetric_rigid_mesh', assetId: sentinelCalAsset.id },
    { id: 'obj_fig_02_emerald', srcId: 'src_fig_02', label: 'Figure 02 — Emerald Proxy', pos: [-4.6, 1.3, 0.2], color: '#10b981', emissive: '#059669', rep: 'procedural_geometry', assetId: null },
    { id: 'obj_fig_03_crimson', srcId: 'src_fig_03', label: 'Figure 03 — Crimson Proxy', pos: [-2.4, 1.4, -2.2], color: '#f43f5e', emissive: '#e11d48', rep: 'procedural_geometry', assetId: null },
    { id: 'obj_fig_04_amber', srcId: 'src_fig_04', label: 'Figure 04 — Amber Proxy', pos: [-0.9, 1.5, -3.1], color: '#f59e0b', emissive: '#d97706', rep: 'procedural_geometry', assetId: null },
    { id: 'obj_fig_05_violet', srcId: 'src_fig_05', label: 'Figure 05 — Violet Proxy', pos: [1.1, 1.5, -3.0], color: '#a855f7', emissive: '#7c3aed', rep: 'procedural_geometry', assetId: null },
    { id: 'obj_fig_06_cyan', srcId: 'src_fig_06', label: 'Figure 06 — Cyan Proxy', pos: [2.8, 1.35, -2.0], color: '#06b6d4', emissive: '#0891b2', rep: 'procedural_geometry', assetId: null },
    { id: 'obj_fig_07_indigo', srcId: 'src_fig_07', label: 'Figure 07 — Indigo Proxy', pos: [4.5, 1.3, 0.3], color: '#6366f1', emissive: '#4f46e5', rep: 'procedural_geometry', assetId: null },
    { id: 'obj_fig_08_gold', srcId: 'src_fig_08', label: 'Figure 08 — Gold Proxy', pos: [3.3, 1.35, 1.8], color: '#eab308', emissive: '#ca8a04', rep: 'procedural_geometry', assetId: null },
    { id: 'obj_fig_09_silver', srcId: 'src_fig_09', label: 'Figure 09 — Silver Proxy', pos: [-1.5, 1.25, 3.1], color: '#94a3b8', emissive: '#475569', rep: 'procedural_geometry', assetId: null },
    { id: 'obj_fig_10_obsidian', srcId: 'src_fig_10', label: 'Figure 10 — Obsidian Proxy', pos: [1.6, 1.25, 3.0], color: '#334155', emissive: '#64748b', rep: 'procedural_geometry', assetId: null },
  ];

  for (let i = 0; i < figureSpecs.length; i++) {
    const f = figureSpecs[i];
    project.sourceObjects.push({
      id: f.srcId,
      label: f.label,
      category: 'figure',
      bbox: { x: 42 + i * 112, y: 260, w: 96, h: 330 },
      mask: null,
      depthOrder: i + 1,
      reconstructionStatus: f.assetId ? 'prototype_approved' : 'pending_reconstruction',
      confidence: f.assetId ? 0.95 : 0.4,
    });

    scene.objects.push({
      id: f.id,
      label: f.label,
      category: 'figure',
      representationType: f.rep,
      assetId: f.assetId,
      sourceObjectId: f.srcId,
      position: [...f.pos],
      rotation: [0, Math.atan2(-f.pos[0], -f.pos[2]), 0],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
      parentId: null,
      temporalState: 'held',
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      collision: { shape: 'capsule', radius: 0.45, halfHeight: 0.55, enabled: true },
      physics: { mass: 2.2, restitution: 0.35, gravityScale: 1.0, isStatic: false },
      material: { color: f.color, emissive: f.emissive, roughness: 0.38, metalness: 0.45 },
      visible: true,
      interactive: true,
    });
  }

  // 3. Deterministic Three-Body Impact Chain (Impact Weight -> Relay Shard -> Anchor Orb)
  scene.objects.push(
    {
      id: 'obj_impact_weight',
      label: 'Impact Weight (Three-Body Test)',
      category: 'impact_weight',
      representationType: 'volumetric_rigid_mesh',
      assetId: crystalAsset.id,
      sourceObjectId: 'src_impact_weight',
      position: [-0.85, 4.3, 1.85],
      rotation: [0.3, 0.5, 0.2],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
      parentId: null,
      temporalState: 'held',
      velocity: [0, -2.5, 0],
      angularVelocity: [0.6, 0.9, 0.4],
      collision: { shape: 'sphere', radius: 0.42, enabled: true },
      physics: { mass: 2.5, restitution: 0.55, gravityScale: 1.0, isStatic: false },
      material: { color: '#fb7185', emissive: '#e11d48', roughness: 0.25, metalness: 0.6 },
      visible: true,
      interactive: true,
    },
    {
      id: 'obj_chain_relay',
      label: 'Relay Shard (Body 2)',
      category: 'fragment',
      representationType: 'procedural_geometry',
      assetId: null,
      sourceObjectId: null,
      position: [-0.85, 2.55, 1.85],
      rotation: [0.2, 0.8, 0.1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
      parentId: null,
      temporalState: 'held',
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      collision: { shape: 'sphere', radius: 0.36, enabled: true },
      physics: { mass: 1.2, restitution: 0.52, gravityScale: 1.0, isStatic: false },
      material: { color: '#38bdf8', emissive: '#0284c7', roughness: 0.3, metalness: 0.7 },
      visible: true,
      interactive: true,
    },
    {
      id: 'obj_chain_anchor',
      label: 'Anchor Orb (Body 3)',
      category: 'fragment',
      representationType: 'procedural_geometry',
      assetId: null,
      sourceObjectId: null,
      position: [-0.85, 1.05, 1.85],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
      parentId: null,
      temporalState: 'held',
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      collision: { shape: 'box', halfExtents: [0.38, 0.38, 0.38], enabled: true },
      physics: { mass: 1.5, restitution: 0.45, gravityScale: 1.0, isStatic: false },
      material: { color: '#c084fc', emissive: '#7e22ce', roughness: 0.32, metalness: 0.65 },
      visible: true,
      interactive: true,
    }
  );

  // 4. Orbiting Suspended Fragments around the Central Aperture
  const shardColors = ['#38bdf8', '#818cf8', '#f472b6', '#2dd4bf', '#94a3b8'];
  for (let i = 0; i < fragmentCount; i++) {
    const angle = (i / fragmentCount) * Math.PI * 2;
    const ring = 2.0 + (i % 3) * 0.95;
    const y = 1.6 + Math.sin(angle * 2.0 + i) * 1.15 + (i % 2) * 0.6;
    const x = Math.cos(angle) * ring;
    const z = Math.sin(angle) * ring;
    const radius = 0.16 + (i % 4) * 0.045;
    const col = shardColors[i % shardColors.length];

    scene.objects.push({
      id: `obj_shard_${String(i + 1).padStart(3, '0')}`,
      label: `Suspended Fragment ${String(i + 1).padStart(2, '0')}`,
      category: 'fragment',
      representationType: 'procedural_geometry',
      assetId: null,
      sourceObjectId: null,
      position: [Number(x.toFixed(3)), Number(y.toFixed(3)), Number(z.toFixed(3))],
      rotation: [Number((i * 0.4).toFixed(2)), Number((i * 0.7).toFixed(2)), Number((i * 0.2).toFixed(2))],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
      parentId: null,
      temporalState: 'held',
      velocity: [Number((-Math.sin(angle) * 0.6).toFixed(3)), 0.15, Number((Math.cos(angle) * 0.6).toFixed(3))],
      angularVelocity: [0.4, 0.7, 0.3],
      collision: { shape: i % 3 === 0 ? 'box' : 'sphere', radius, halfExtents: [radius, radius, radius], enabled: true },
      physics: { mass: 0.5 + (i % 3) * 0.25, restitution: 0.5, gravityScale: 0.65, isStatic: false },
      material: { color: col, emissive: col, roughness: 0.28, metalness: 0.75 },
      visible: true,
      interactive: true,
    });
  }

  return project;
}
