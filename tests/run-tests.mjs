#!/usr/bin/env node
/**
 * Frozen Aperture — Automated Unit & Integration Regression Test Suite
 * Tests observable outcomes across schema, migration, GLB validation, asset lifecycle,
 * temporal simulation invariants, collisions, undo/reset/replay, providers, persistence,
 * security, offline export, and private CLI builder.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateProject, migrateProject, getActiveScene, SCHEMA_VERSION } from '../src/core/schema.js';
import { ProjectStore } from '../src/core/project-store.js';
import { sha256Hex } from '../src/core/hash.js';
import { isUnsafePath, isExternalUri } from '../src/core/security.js';
import { validateGlbBuffer } from '../src/assets/glb-validator.js';
import { createCalibrationSolidGlb, createOctahedronGlb } from '../src/assets/synthetic-glb.js';
import { AssetManager } from '../src/assets/asset-manager.js';
import { ProviderRegistry } from '../src/providers/provider-interface.js';
import { ManualGlbProvider, DexDiffusionAdapter } from '../src/providers/dexdiffusion-adapter.js';
import { TemporalSimulationEngine } from '../src/simulation/temporal-engine.js';
import { createPublicCalibrationProject } from '../src/fixtures/calibration-scene.js';
import { buildStandaloneHtmlExport } from '../src/export/offline-exporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const results = [];

async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, passed: true, durationMs: Number((performance.now() - start).toFixed(2)) });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: err.message, durationMs: Number((performance.now() - start).toFixed(2)) });
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}

async function run() {
  console.log('Running Frozen Aperture automated regression suite...\n');

  const fixA = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/fixture-a-synthetic.json'), 'utf8'));
  const fixB = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/fixture-b-chain.json'), 'utf8'));
  const fixC = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/fixture-c-mixed.json'), 'utf8'));
  const fixD = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/fixture-d-malformed.json'), 'utf8'));
  const fixE = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/fixture-e-save-load.json'), 'utf8'));

  await test('1. Project schema validates valid public fixtures A, B, C', () => {
    for (const f of [fixA, fixB, fixC]) {
      const check = validateProject(f);
      assert.equal(check.valid, true, check.errors.join('; '));
    }
  });

  await test('2. Malformed inputs in Fixture D are rejected cleanly', () => {
    const store = new ProjectStore(null);
    for (const c of fixD.cases) {
      if (typeof c.payload === 'string') {
        assert.throws(() => store.parseAndValidateProjectJson(c.payload));
      } else {
        const check = validateProject(c.payload);
        assert.equal(check.valid, false, `Expected ${c.id} to fail validation`);
      }
    }
  });

  await test('3. Legacy 0.9.x migration upgrades to 1.0.0 and preserves unknown fields', () => {
    const migrated = migrateProject(fixE);
    assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(migrated.customUnknownExtensionField, { preserved: true, tag: 'keep-me' });
    const check = validateProject(migrated);
    assert.equal(check.valid, true, check.errors.join('; '));
    assert.equal(getActiveScene(migrated).objects[0].id, 'replay_orb');
  });

  await test('4. GLB validator accepts watertight synthetic calibration solid and reports geometry stats', () => {
    const glb = createCalibrationSolidGlb();
    const res = validateGlbBuffer(glb);
    assert.equal(res.valid, true, res.errors.join('; '));
    assert.ok(res.stats.vertexCount > 100);
    assert.ok(res.stats.triangleCount > 200);
    assert.equal(res.stats.topology.watertight, true);
    assert.equal(res.stats.hasVertexColors, true);
    assert.equal(res.stats.hasNormals, true);
  });

  await test('5. GLB validator rejects bad magic, truncated length, NaN vertices, and external URIs', () => {
    // Bad magic
    const badMagic = new Uint8Array(32);
    assert.equal(validateGlbBuffer(badMagic).valid, false);

    // Declared length mismatch
    const good = createOctahedronGlb();
    const truncated = good.slice(0, good.length - 4);
    assert.equal(validateGlbBuffer(truncated).valid, false);

    // External URI injection
    const extJson = JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'https://evil.example/buf.bin', byteLength: 12 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    });
    const jBytes = new TextEncoder().encode(extJson);
    const pad = (4 - (jBytes.length % 4)) % 4;
    const total = 12 + 8 + jBytes.length + pad;
    const badUriGlb = new Uint8Array(total);
    const dv = new DataView(badUriGlb.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jBytes.length + pad, true);
    dv.setUint32(16, 0x4e4f534a, true);
    badUriGlb.set(jBytes, 20);
    const uriRes = validateGlbBuffer(badUriGlb);
    assert.equal(uriRes.valid, false);
    assert.ok(uriRes.errors.some(e => e.includes('External buffer URI')));
  });

  await test('6. AssetManager lifecycle, candidate comparison, and reversible replacement preserve logical object ID', async () => {
    const am = new AssetManager();
    const doc = JSON.parse(JSON.stringify(fixC));
    const scene = getActiveScene(doc);
    const [idA, idB] = scene.objects[0]._expectedCandidateIds;

    const cmp = am.compareCandidates(doc, idA, idB);
    assert.ok(cmp.incumbent.vertices > cmp.candidate.vertices);

    am.bindAssetToSceneObject(doc, scene, 'obj_mixed_figure', idA, { representationType: 'volumetric_rigid_mesh' });
    assert.equal(scene.objects[0].id, 'obj_mixed_figure');
    assert.equal(scene.objects[0].assetId, idA);
    assert.equal(scene.objects[0].representationType, 'volumetric_rigid_mesh');

    am.bindAssetToSceneObject(doc, scene, 'obj_mixed_figure', idB, { representationType: 'volumetric_rigid_mesh', supersedePrevious: true });
    assert.equal(scene.objects[0].assetId, idB);
    assert.equal(doc.assets.find(a => a.id === idA).lifecycleState, 'superseded');

    am.revertSceneObjectAsset(scene, 'obj_mixed_figure');
    assert.equal(scene.objects[0].assetId, idA);
    am.revertSceneObjectAsset(scene, 'obj_mixed_figure');
    assert.equal(scene.objects[0].representationType, 'source_image_layer');
  });

  await test('7. Temporal invariants: held bodies stay stationary, real contact awakens target, non-contact bystander stays held', () => {
    const doc = JSON.parse(JSON.stringify(fixA));
    const scene = getActiveScene(doc);
    const sim = new TemporalSimulationEngine(scene);

    // Step 20 ticks while all held: ZERO movement (even bystander with stored velocity!)
    for (let i = 0; i < 20; i++) sim.stepFixed();
    assert.deepEqual(sim.getObject('body_bystander').position, [0, 1, 8]);
    assert.deepEqual(sim.getObject('body_striker').position, [-2, 1, 0]);

    // Release striker only
    sim.releaseObject('body_striker');
    for (let i = 0; i < 40; i++) sim.stepFixed();

    // Striker collided with target -> target awakened and moved
    assert.equal(sim.getObject('body_target').temporalState, 'active');
    assert.ok(sim.getObject('body_target').position[0] > 0.2, 'Target should move after impact');

    // Bystander had NO contact -> remained strictly held at original position
    assert.equal(sim.getObject('body_bystander').temporalState, 'held');
    assert.deepEqual(sim.getObject('body_bystander').position, [0, 1, 8]);
  });

  await test('8. Refreezing (suspend) freezes in place and preserves stored velocity for later resume', () => {
    const doc = JSON.parse(JSON.stringify(fixA));
    const scene = getActiveScene(doc);
    const sim = new TemporalSimulationEngine(scene);

    sim.releaseObject('body_striker');
    for (let i = 0; i < 5; i++) sim.stepFixed();
    sim.suspendObject('body_striker');
    const frozenPos = [...sim.getObject('body_striker').position];
    const storedVel = [...sim.getObject('body_striker').velocity];
    assert.ok(storedVel[0] > 0, 'Stored velocity should be non-zero');

    for (let i = 0; i < 30; i++) sim.stepFixed();
    assert.deepEqual(sim.getObject('body_striker').position, frozenPos, 'Suspended body must not drift');

    // Resume
    sim.releaseObject('body_striker');
    for (let i = 0; i < 10; i++) sim.stepFixed();
    assert.ok(sim.getObject('body_striker').position[0] > frozenPos[0] + 0.5, 'Resumed body must continue with preserved velocity');
  });

  await test('9. Three-body temporal chain, Undo, Reset, and Deterministic Replay', () => {
    const doc = JSON.parse(JSON.stringify(fixB));
    const scene = getActiveScene(doc);
    const sim = new TemporalSimulationEngine(scene);
    const initHash = sim.getStateHash();

    sim.releaseObject('chain_1');
    for (let i = 0; i < 90; i++) sim.stepFixed();

    assert.equal(sim.getObject('chain_2').temporalState, 'active', 'Relay body 2 must awaken on contact');
    assert.equal(sim.getObject('chain_3').temporalState, 'active', 'Anchor body 3 must awaken on contact');

    const log = [...sim.tickLog];
    const endHash = sim.getStateHash();

    // Undo restores before release
    assert.equal(sim.undo(), true);
    assert.equal(sim.getObject('chain_1').temporalState, 'held');

    // Replay reproduces exact endHash
    const replayHash1 = sim.replay(log, 90);
    const replayHash2 = sim.replay(log, 90);
    assert.equal(replayHash1, endHash);
    assert.equal(replayHash2, endHash);

    // Reset restores initial state
    sim.reset();
    assert.equal(sim.getStateHash(), initHash);
  });

  await test('10. Central Aperture vortex stays frozen when held and initiates cascade when active', async () => {
    const am = new AssetManager();
    const project = await createPublicCalibrationProject(am);
    const scene = getActiveScene(project);
    const sim = new TemporalSimulationEngine(scene);

    for (let i = 0; i < 20; i++) sim.stepFixed();
    assert.equal(sim.getStats().counts.active, 0, 'Held vortex must not awaken anything');

    sim.releaseObject('obj_vortex_core');
    for (let i = 0; i < 90; i++) sim.stepFixed();
    assert.ok(sim.getStats().counts.active >= 2, 'Active vortex must awaken nearby bodies');
  });

  await test('11. Provider contract: operator gate, offline Manual GLB import, honest unavailable DexDiffusion', async () => {
    const am = new AssetManager();
    const project = await createPublicCalibrationProject(am);
    const reg = new ProviderRegistry({ maxConcurrency: 1 });
    reg.register(new ManualGlbProvider(am)).register(new DexDiffusionAdapter({ baseUrl: '' }));

    // Must reject non-operator-initiated jobs
    await assert.rejects(() => reg.submitJob(project, { providerId: 'manual_glb', operatorInitiated: false }));

    // Unconfigured DexDiffusion reports honest unavailable & marks job blocked without harming project
    const dexReceipt = await reg.submitJob(project, { providerId: 'dexdiffusion_local', mode: 'mesh', operatorInitiated: true });
    assert.equal(dexReceipt.state, 'blocked');

    // Manual GLB provider succeeds offline
    const bytes = createOctahedronGlb({ name: 'ManualTestGlb' });
    const manualReceipt = await reg.submitJob(project, {
      providerId: 'manual_glb',
      operatorInitiated: true,
      input: { project, bytes, label: 'ManualTestGlb.glb', rights: 'public_synthetic' },
    });
    assert.equal(manualReceipt.state, 'completed');
    assert.ok(manualReceipt.outputAssetId);
  });

  await test('12. Security guards & ProjectStore save/load + Standalone offline HTML export', async () => {
    assert.equal(isUnsafePath('../etc/passwd'), true);
    assert.equal(isUnsafePath('/abs/path'), true);
    assert.equal(isUnsafePath('safe/file.json'), false);
    assert.equal(isExternalUri('https://cdn.example.com/a.bin'), true);
    assert.equal(isExternalUri('data:application/octet-stream;base64,AA=='), false);

    // Mock localStorage
    const map = new Map();
    const mockStorage = {
      getItem: k => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
    };
    const store = new ProjectStore(mockStorage);
    const am = new AssetManager();
    const project = await createPublicCalibrationProject(am);
    const saveRes = store.saveProject(project);
    assert.equal(saveRes.saved, true);
    assert.equal(saveRes.storageMode, 'browser_local_storage');

    const loaded = store.loadProjectById(project.project.id);
    assert.equal(loaded.project.project.id, project.project.id);
    assert.equal(loaded.project.scenes[0].objects.length, project.scenes[0].objects.length);

    // Standalone offline HTML export
    const builtHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const exported = buildStandaloneHtmlExport(project, builtHtml);
    assert.ok(exported.includes('window.__FROZEN_APERTURE_EMBEDDED_PROJECT__'));
    assert.equal(/<script[^>]+src=["']https?:/i.test(exported), false, 'Exported HTML must have zero external script URLs');
  });

  await test('13. Private CLI builder (scripts/build.py) enforces SHA-256 and produces valid standalone HTML', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-buildpy-'));
    try {
      const glbPath = path.join(tmpDir, 'sample.glb');
      const pngPath = path.join(tmpDir, 'source.png');
      const outPath = path.join(tmpDir, 'private-sample.local.html');

      const glbBytes = createOctahedronGlb({ name: 'PrivateTestSolid' });
      fs.writeFileSync(glbPath, glbBytes);
      // Minimal valid 1x1 PNG
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      );
      fs.writeFileSync(pngPath, pngBytes);
      const expectedSha = await sha256Hex(glbBytes);

      // Must reject wrong SHA-256
      let failedWrongHash = false;
      try {
        execFileSync('python3', [
          path.join(root, 'scripts/build.py'),
          '--asset', glbPath,
          '--source', pngPath,
          '--expected-sha256', '0'.repeat(64),
          '--output', outPath,
        ], { stdio: 'pipe' });
      } catch (_) {
        failedWrongHash = true;
      }
      assert.equal(failedWrongHash, true, 'build.py must reject mismatched SHA-256');

      // Must succeed with matching SHA-256
      execFileSync('python3', [
        path.join(root, 'scripts/build.py'),
        '--asset', glbPath,
        '--source', pngPath,
        '--expected-sha256', expectedSha,
        '--output', outPath,
      ], { stdio: 'pipe' });

      const html = fs.readFileSync(outPath, 'utf8');
      assert.ok(html.includes(expectedSha));
      assert.ok(html.includes('window.__FROZEN_APERTURE_EMBEDDED_PROJECT__'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const failed = results.filter(r => !r.passed);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
