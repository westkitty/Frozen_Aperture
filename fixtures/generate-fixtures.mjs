#!/usr/bin/env node
/**
 * Frozen Aperture — Deterministic Public Test Fixture Generator (Fixtures A-E)
 * Generates safe, publishable synthetic JSON fixtures for automated regression testing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyProject, getActiveScene } from '../src/core/schema.js';
import { AssetManager } from '../src/assets/asset-manager.js';
import { createCalibrationSolidGlb, createOctahedronGlb } from '../src/assets/synthetic-glb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function generate() {
  const am = new AssetManager();

  // FIXTURE A — Small synthetic scene with known geometry and expected collision behavior
  const fixA = createEmptyProject({ id: 'fixture_a_synthetic', name: 'Fixture A — Synthetic Collision', isPublicFixture: true });
  const scA = getActiveScene(fixA);
  scA.simulation.gravity = [0, 0, 0];
  scA.objects.push(
    {
      id: 'body_striker',
      label: 'Striker Sphere',
      category: 'test',
      representationType: 'procedural_geometry',
      assetId: null,
      position: [-2.0, 1.0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      temporalState: 'held',
      velocity: [6.0, 0, 0],
      angularVelocity: [0, 0, 0],
      collision: { shape: 'sphere', radius: 0.5, enabled: true },
      physics: { mass: 1.0, restitution: 0.8, gravityScale: 0, isStatic: false },
      visible: true,
    },
    {
      id: 'body_target',
      label: 'Target Sphere',
      category: 'test',
      representationType: 'procedural_geometry',
      assetId: null,
      position: [0.0, 1.0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      temporalState: 'held',
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      collision: { shape: 'sphere', radius: 0.5, enabled: true },
      physics: { mass: 1.0, restitution: 0.8, gravityScale: 0, isStatic: false },
      visible: true,
    },
    {
      id: 'body_bystander',
      label: 'Isolated Bystander',
      category: 'test',
      representationType: 'procedural_geometry',
      assetId: null,
      position: [0.0, 1.0, 8.0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      temporalState: 'held',
      velocity: [5.0, 0, 0], // Stored future velocity must NOT move while held
      angularVelocity: [0, 0, 0],
      collision: { shape: 'sphere', radius: 0.5, enabled: true },
      physics: { mass: 1.0, restitution: 0.8, gravityScale: 0, isStatic: false },
      visible: true,
    }
  );
  fs.writeFileSync(path.join(__dirname, 'fixture-a-synthetic.json'), JSON.stringify(fixA, null, 2));

  // FIXTURE B — Multi-object temporal chain with deterministic expected outcomes
  const fixB = createEmptyProject({ id: 'fixture_b_chain', name: 'Fixture B — 3-Body Temporal Chain', isPublicFixture: true });
  const scB = getActiveScene(fixB);
  scB.objects.push(
    {
      id: 'chain_1',
      label: 'Impact Weight',
      category: 'impact_weight',
      representationType: 'procedural_geometry',
      assetId: null,
      position: [0, 3.6, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      temporalState: 'held',
      velocity: [0, -3.0, 0],
      angularVelocity: [0, 0, 0],
      collision: { shape: 'sphere', radius: 0.45, enabled: true },
      physics: { mass: 2.0, restitution: 0.5, gravityScale: 1.0, isStatic: false },
      visible: true,
    },
    {
      id: 'chain_2',
      label: 'Middle Relay',
      category: 'fragment',
      representationType: 'procedural_geometry',
      assetId: null,
      position: [0, 2.2, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      temporalState: 'held',
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      collision: { shape: 'sphere', radius: 0.4, enabled: true },
      physics: { mass: 1.0, restitution: 0.5, gravityScale: 1.0, isStatic: false },
      visible: true,
    },
    {
      id: 'chain_3',
      label: 'Lower Anchor',
      category: 'fragment',
      representationType: 'procedural_geometry',
      assetId: null,
      position: [0, 0.9, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      temporalState: 'held',
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      collision: { shape: 'box', halfExtents: [0.4, 0.4, 0.4], enabled: true },
      physics: { mass: 1.2, restitution: 0.4, gravityScale: 1.0, isStatic: false },
      visible: true,
    }
  );
  fs.writeFileSync(path.join(__dirname, 'fixture-b-chain.json'), JSON.stringify(fixB, null, 2));

  // FIXTURE C — Mixed layer/mesh scene exercising representation replacement
  const fixC = createEmptyProject({ id: 'fixture_c_mixed', name: 'Fixture C — Mixed Layer & Mesh Replacement', isPublicFixture: true });
  const scC = getActiveScene(fixC);
  const solidA = createCalibrationSolidGlb({ name: 'ReplacementMeshA', radialSegments: 10, heightSegments: 6 });
  const solidB = createOctahedronGlb({ name: 'ReplacementMeshB' });
  const regA = await am.registerGlbAsset(fixC, { bytes: solidA, label: 'Candidate A', rights: 'public_synthetic' });
  const regB = await am.registerGlbAsset(fixC, { bytes: solidB, label: 'Candidate B', rights: 'public_synthetic' });
  scC.objects.push({
    id: 'obj_mixed_figure',
    label: 'Replaceable Figure',
    category: 'figure',
    representationType: 'source_image_layer',
    assetId: null,
    position: [0, 1.4, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    temporalState: 'held',
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    collision: { shape: 'capsule', radius: 0.4, halfHeight: 0.5, enabled: true },
    physics: { mass: 2.0, restitution: 0.3, gravityScale: 1.0, isStatic: false },
    visible: true,
    _expectedCandidateIds: [regA.asset.id, regB.asset.id],
  });
  fs.writeFileSync(path.join(__dirname, 'fixture-c-mixed.json'), JSON.stringify(fixC, null, 2));

  // FIXTURE D — Malformed asset/input suite
  const fixD = {
    description: 'Malformed inputs that must be cleanly rejected without corrupting valid project state.',
    cases: [
      { id: 'bad_schema_root', payload: '[]' },
      { id: 'future_schema_major', payload: JSON.stringify({ schemaVersion: '9.0.0', project: { id: 'x', name: 'x' }, sourceObjects: [], assets: [], scenes: [] }) },
      { id: 'nan_position', payload: { schemaVersion: '1.0.0', project: { id: 'x', name: 'x' }, sourceObjects: [], assets: [], scenes: [{ id: 's', objects: [{ id: 'o', position: [null, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }] }] } },
      { id: 'invalid_temporal_state', payload: { schemaVersion: '1.0.0', project: { id: 'x', name: 'x' }, sourceObjects: [], assets: [], scenes: [{ id: 's', objects: [{ id: 'o', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], temporalState: 'teleported' }] }] } },
    ],
  };
  fs.writeFileSync(path.join(__dirname, 'fixture-d-malformed.json'), JSON.stringify(fixD, null, 2));

  // FIXTURE E — Save/load/replay & legacy 0.9.x migration fixture
  const fixE = {
    schemaVersion: '0.9.2',
    id: 'fixture_e_legacy',
    name: 'Fixture E — Legacy Migration & Replay',
    customUnknownExtensionField: { preserved: true, tag: 'keep-me' },
    objects: [
      {
        id: 'replay_orb',
        label: 'Replay Orb',
        representationType: 'procedural_geometry',
        position: [0, 3.0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        temporalState: 'held',
        velocity: [1.5, 0, 0],
        angularVelocity: [0, 0.5, 0],
        collision: { shape: 'sphere', radius: 0.4, enabled: true },
        physics: { mass: 1.0, restitution: 0.5, gravityScale: 1.0, isStatic: false },
        visible: true,
      },
    ],
  };
  fs.writeFileSync(path.join(__dirname, 'fixture-e-save-load.json'), JSON.stringify(fixE, null, 2));

  console.log('Generated deterministic public fixtures A-E in fixtures/.');
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
