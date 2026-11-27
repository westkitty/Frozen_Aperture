/**
 * Frozen Aperture — Asset Lifecycle, Candidate Comparison & Component Lineage Manager
 * Distinguishes imported, structurally_valid, visually_inspected, reconstruction_candidate,
 * prototype_approved, production_approved, rejected, and superseded states.
 */

import { sha256Hex, bytesToBase64, base64ToBytes } from '../core/hash.js';
import { sanitizeId, sanitizeLabel } from '../core/security.js';
import { ASSET_LIFECYCLE_STATES } from '../core/schema.js';
import { validateGlbBuffer } from './glb-validator.js';

export class AssetManager {
  constructor() {
    /** @type {Map<string, Uint8Array>} In-memory original byte store keyed by assetId */
    this.binaryStore = new Map();
  }

  /**
   * Registers an imported or generated GLB buffer with full structural validation.
   * Preserves original bytes and computes SHA-256 hash.
   */
  async registerGlbAsset(project, {
    bytes,
    label = 'Imported GLB',
    sourceObjectId = null,
    componentSlot = 'body', // body | weapon | clothing | effect | full
    provider = 'manual_glb_import',
    model = null,
    rights = 'private_unverified',
    surfaceClassification = 'inferred',
    parentAssetId = null,
    notes = '',
  }) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const sha256 = await sha256Hex(u8);
    const validation = validateGlbBuffer(u8);

    const existingSameHash = project.assets.find(
      a => a.sha256 === sha256 && a.sourceObjectId === sourceObjectId && a.componentSlot === componentSlot
    );
    if (existingSameHash) {
      this.binaryStore.set(existingSameHash.id, u8);
      return { asset: existingSameHash, validation, reused: true };
    }

    const id = sanitizeId(`asset_${sha256.slice(0, 10)}_${Date.now().toString(36)}`);
    const now = new Date().toISOString();
    const lifecycleState = validation.valid ? 'structurally_valid' : 'rejected';

    const assetRecord = {
      id,
      revision: 1,
      label: sanitizeLabel(label, 'Imported GLB'),
      format: 'glb',
      sha256,
      byteLength: u8.byteLength,
      sourceObjectId,
      componentSlot,
      parentAssetId,
      provider,
      model,
      rights,
      publicationAllowed: rights === 'public_synthetic' || rights === 'authorized_public',
      surfaceClassification,
      lifecycleState,
      validation: {
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings,
        stats: validation.stats,
        checkedAt: now,
      },
      history: [
        {
          at: now,
          from: null,
          to: lifecycleState,
          reason: validation.valid
            ? (notes || 'Imported and passed structural GLB validation.')
            : `Rejected on structural validation: ${validation.errors.join('; ')}`,
        },
      ],
      embeddedBase64: u8.byteLength <= 4 * 1024 * 1024 ? bytesToBase64(u8) : null,
      createdAt: now,
      modifiedAt: now,
    };

    if (validation.valid) {
      this.binaryStore.set(id, u8);
    }
    project.assets.push(assetRecord);
    return { asset: assetRecord, validation, reused: false };
  }

  getBytes(project, assetId) {
    if (this.binaryStore.has(assetId)) return this.binaryStore.get(assetId);
    const rec = project.assets.find(a => a.id === assetId);
    if (rec && rec.embeddedBase64) {
      const bytes = base64ToBytes(rec.embeddedBase64);
      this.binaryStore.set(assetId, bytes);
      return bytes;
    }
    return null;
  }

  /**
   * Transitions an asset's lifecycle state with an explicit audit reason.
   */
  transitionAssetState(project, assetId, nextState, reason = '') {
    if (!ASSET_LIFECYCLE_STATES.includes(nextState)) {
      throw new Error(`Invalid asset lifecycle state: ${nextState}`);
    }
    const asset = project.assets.find(a => a.id === assetId);
    if (!asset) throw new Error(`Asset not found: ${assetId}`);
    if (
      (nextState === 'prototype_approved' || nextState === 'production_approved') &&
      !asset.validation?.valid
    ) {
      throw new Error('Cannot approve an asset that failed structural validation.');
    }
    const prev = asset.lifecycleState;
    asset.lifecycleState = nextState;
    asset.modifiedAt = new Date().toISOString();
    asset.history.push({
      at: asset.modifiedAt,
      from: prev,
      to: nextState,
      reason: sanitizeLabel(reason || `Transitioned to ${nextState}`, 'State updated'),
    });
    return asset;
  }

  /**
   * Reversibly replaces a scene object's bound asset while preserving its logical object ID,
   * world transform, relationships, and marking prior incumbent as superseded if desired.
   */
  bindAssetToSceneObject(project, scene, sceneObjectId, newAssetId, {
    representationType = 'volumetric_rigid_mesh',
    reason = 'Operator bound candidate asset',
    supersedePrevious = false,
  } = {}) {
    const obj = scene.objects.find(o => o.id === sceneObjectId);
    if (!obj) throw new Error(`Scene object not found: ${sceneObjectId}`);
    const asset = project.assets.find(a => a.id === newAssetId);
    if (!asset) throw new Error(`Asset not found: ${newAssetId}`);
    if (!asset.validation?.valid) {
      throw new Error(`Cannot bind invalid asset ${newAssetId} to scene object ${sceneObjectId}.`);
    }

    const previousAssetId = obj.assetId || null;
    const previousRep = obj.representationType;
    if (!Array.isArray(obj.assetHistory)) obj.assetHistory = [];
    obj.assetHistory.push({
      at: new Date().toISOString(),
      previousAssetId,
      previousRepresentationType: previousRep,
      nextAssetId: newAssetId,
      nextRepresentationType: representationType,
      reason,
    });

    obj.assetId = newAssetId;
    obj.representationType = representationType;

    if (supersedePrevious && previousAssetId && previousAssetId !== newAssetId) {
      const prevAsset = project.assets.find(a => a.id === previousAssetId);
      if (prevAsset && prevAsset.lifecycleState !== 'superseded') {
        this.transitionAssetState(project, previousAssetId, 'superseded', `Superseded by ${newAssetId}`);
      }
    }

    return { object: obj, previousAssetId, newAssetId };
  }

  /**
   * Reverts a scene object to its immediately prior asset binding (reversible replacement).
   */
  revertSceneObjectAsset(scene, sceneObjectId) {
    const obj = scene.objects.find(o => o.id === sceneObjectId);
    if (!obj || !Array.isArray(obj.assetHistory) || obj.assetHistory.length === 0) {
      throw new Error(`No asset replacement history to revert for ${sceneObjectId}.`);
    }
    const last = obj.assetHistory.pop();
    obj.assetId = last.previousAssetId;
    obj.representationType = last.previousRepresentationType;
    return obj;
  }

  /**
   * Side-by-side comparison summary between two candidate assets.
   */
  compareCandidates(project, assetIdA, assetIdB) {
    const a = project.assets.find(x => x.id === assetIdA);
    const b = project.assets.find(x => x.id === assetIdB);
    if (!a || !b) throw new Error('Both candidate assets must exist to compare.');
    const sa = a.validation?.stats || {};
    const sb = b.validation?.stats || {};
    return {
      incumbent: {
        id: a.id,
        label: a.label,
        lifecycleState: a.lifecycleState,
        sha256: a.sha256,
        vertices: sa.vertexCount || 0,
        triangles: sa.triangleCount || 0,
        watertight: Boolean(sa.topology?.watertight),
        hasVertexColors: Boolean(sa.hasVertexColors),
        hasUVs: Boolean(sa.hasUVs),
        byteLength: a.byteLength,
      },
      candidate: {
        id: b.id,
        label: b.label,
        lifecycleState: b.lifecycleState,
        sha256: b.sha256,
        vertices: sb.vertexCount || 0,
        triangles: sb.triangleCount || 0,
        watertight: Boolean(sb.topology?.watertight),
        hasVertexColors: Boolean(sb.hasVertexColors),
        hasUVs: Boolean(sb.hasUVs),
        byteLength: b.byteLength,
      },
      deltas: {
        vertexDelta: (sb.vertexCount || 0) - (sa.vertexCount || 0),
        triangleDelta: (sb.triangleCount || 0) - (sa.triangleCount || 0),
        byteDelta: (b.byteLength || 0) - (a.byteLength || 0),
      },
    };
  }
}
