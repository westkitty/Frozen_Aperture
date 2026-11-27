/**
 * Frozen Aperture — Versioned Project & Scene Document Schema (v1.0.0)
 * Canonical source of truth consumed by renderer, simulation, authoring workbench, and exporter.
 * Supports validation, backward-compatible migration, and unknown-field preservation.
 */

import { RESOURCE_LIMITS, isFiniteVec3, sanitizeId, sanitizeLabel } from './security.js';

export const SCHEMA_VERSION = '1.0.0';

export const REPRESENTATION_TYPES = Object.freeze([
  'source_image_layer',
  'depth_aware_surface',
  'volumetric_rigid_mesh',
  'articulated_mesh',
  'procedural_geometry',
  'environmental_effect',
  'background_representation',
]);

export const TEMPORAL_STATES = Object.freeze([
  'held',
  'active',
  'sleeping',
  'suspended',
  'restored',
]);

export const ASSET_LIFECYCLE_STATES = Object.freeze([
  'imported',
  'structurally_valid',
  'visually_inspected',
  'reconstruction_candidate',
  'prototype_approved',
  'production_approved',
  'rejected',
  'superseded',
]);

export const COLLISION_SHAPES = Object.freeze([
  'sphere',
  'capsule',
  'box',
  'convex_hull',
  'compound_convex',
  'static_mesh',
  'trigger',
]);

export const EXPERIENCE_MODES = Object.freeze([
  'frozen_second',
  'living_illustration',
  'world_explorer',
  'object_lab',
  'scene_assembly',
]);

export const SURFACE_CLASSIFICATIONS = Object.freeze([
  'observed',
  'inferred',
  'manually_authored',
]);

export function createDefaultCamera(width = 1600, height = 1000) {
  return {
    sourceCamera: {
      projection: 'perspective',
      fovDeg: 42,
      near: 0.1,
      far: 200,
      position: [0, 1.8, 12.5],
      target: [0, 1.4, 0],
      up: [0, 1, 0],
      imageWidth: width,
      imageHeight: height,
      calibrated: true,
      landmarks: [],
    },
    namedViews: [
      { id: 'source', label: 'Source View', position: [0, 1.8, 12.5], target: [0, 1.4, 0], fovDeg: 42 },
      { id: 'side_left', label: 'Side Left', position: [-11.5, 2.2, 2.5], target: [0, 1.4, 0], fovDeg: 42 },
      { id: 'side_right', label: 'Side Right', position: [11.5, 2.2, 2.5], target: [0, 1.4, 0], fovDeg: 42 },
      { id: 'rear', label: 'Rear Inspection', position: [0, 2.4, -12.0], target: [0, 1.4, 0], fovDeg: 42 },
      { id: 'overhead', label: 'Overhead', position: [0, 13.5, 2.5], target: [0, 0.8, 0], fovDeg: 46 },
    ],
    bookmarks: [],
  };
}

export function createEmptyProject({
  id = `proj_${Date.now().toString(36)}`,
  name = 'Untitled Frozen Aperture Project',
  isPublicFixture = false,
} = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      id: sanitizeId(id, 'proj_default'),
      name: sanitizeLabel(name, 'Untitled Project'),
      revision: 1,
      createdAt: now,
      modifiedAt: now,
      isPublicFixture: Boolean(isPublicFixture),
      activeSceneId: 'scene_main',
      sourceIllustration: null,
    },
    sourceObjects: [],
    assets: [],
    scenes: [
      {
        id: 'scene_main',
        name: 'Primary Scene',
        coordinateSystem: { units: 'meters', upAxis: 'Y', handedness: 'right' },
        cameras: createDefaultCamera(),
        environment: {
          backgroundColor: '#05070c',
          fogDensity: 0.018,
          floorReflectivity: 0.35,
          vortexId: null,
          backgroundRepresentation: {
            type: 'background_representation',
            mode: 'dark_void_plate',
            coverage: 1.0,
            confidence: 0.5,
            collisionReady: false,
          },
        },
        objects: [],
        simulation: {
          fixedDt: 1 / 60,
          gravity: [0, -9.81, 0],
          linearDamping: 0.04,
          angularDamping: 0.08,
          restitution: 0.42,
          contactActivationImpulseThreshold: 0.15,
          seed: 20261126,
          tick: 0,
          initialState: [],
          tickLog: [],
          contactEvents: [],
        },
      },
    ],
    jobs: [],
    settings: {
      qualityTier: 'high',
      reducedMotion: false,
      audioMuted: false,
      audioVolume: 0.55,
      defaultExperienceMode: 'frozen_second',
    },
  };
}

/**
 * Backward-compatible migration from legacy / 0.9.x project structures to 1.0.0.
 * Preserves unknown top-level and nested properties.
 */
export function migrateProject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Project payload must be a JSON object.');
  }
  const copy = JSON.parse(JSON.stringify(raw));

  // Detect 0.9.x flat scene format
  if (!copy.schemaVersion || String(copy.schemaVersion).startsWith('0.')) {
    const now = new Date().toISOString();
    const migrated = {
      ...copy,
      schemaVersion: SCHEMA_VERSION,
      project: {
        id: sanitizeId(copy.project?.id || copy.id || 'migrated_proj'),
        name: sanitizeLabel(copy.project?.name || copy.name || 'Migrated Project'),
        revision: Number.isInteger(copy.project?.revision) ? copy.project.revision : 1,
        createdAt: copy.project?.createdAt || now,
        modifiedAt: now,
        isPublicFixture: Boolean(copy.project?.isPublicFixture),
        activeSceneId: copy.project?.activeSceneId || 'scene_main',
        sourceIllustration: copy.project?.sourceIllustration || copy.sourceIllustration || null,
      },
      sourceObjects: Array.isArray(copy.sourceObjects) ? copy.sourceObjects : [],
      assets: Array.isArray(copy.assets) ? copy.assets : [],
      scenes: Array.isArray(copy.scenes) && copy.scenes.length > 0
        ? copy.scenes
        : [
            {
              id: 'scene_main',
              name: 'Primary Scene',
              coordinateSystem: { units: 'meters', upAxis: 'Y', handedness: 'right' },
              cameras: copy.cameras || createDefaultCamera(),
              environment: copy.environment || {
                backgroundColor: '#05070c',
                fogDensity: 0.018,
                floorReflectivity: 0.35,
                vortexId: null,
              },
              objects: Array.isArray(copy.objects) ? copy.objects : [],
              simulation: {
                fixedDt: 1 / 60,
                gravity: [0, -9.81, 0],
                linearDamping: 0.04,
                angularDamping: 0.08,
                restitution: 0.42,
                contactActivationImpulseThreshold: 0.15,
                seed: 20261126,
                tick: 0,
                initialState: [],
                tickLog: [],
                contactEvents: [],
                ...(copy.simulation || {}),
              },
            },
          ],
      jobs: Array.isArray(copy.jobs) ? copy.jobs : [],
      settings: {
        qualityTier: 'high',
        reducedMotion: false,
        audioMuted: false,
        audioVolume: 0.55,
        defaultExperienceMode: 'frozen_second',
        ...(copy.settings || {}),
      },
      _migrationHistory: [
        ...(Array.isArray(copy._migrationHistory) ? copy._migrationHistory : []),
        { from: copy.schemaVersion || 'unversioned', to: SCHEMA_VERSION, at: now },
      ],
    };
    return migrated;
  }

  return copy;
}

/**
 * Validates a Frozen Aperture project document.
 * Returns { valid, errors, warnings }.
 */
export function validateProject(doc) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { valid: false, errors: ['Project root must be an object.'], warnings };
  }

  if (typeof doc.schemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.schemaVersion)) {
    errors.push('Missing or invalid schemaVersion (expected semver e.g. 1.0.0).');
  } else {
    const [major] = doc.schemaVersion.split('.').map(Number);
    if (major > 1) {
      errors.push(`Unsupported future schema major version: ${doc.schemaVersion}.`);
    }
  }

  if (!doc.project || typeof doc.project !== 'object') {
    errors.push('Missing project metadata object.');
  } else {
    if (typeof doc.project.id !== 'string' || !doc.project.id.trim()) {
      errors.push('project.id must be a non-empty string.');
    }
    if (typeof doc.project.name !== 'string' || !doc.project.name.trim()) {
      errors.push('project.name must be a non-empty string.');
    }
    if (doc.project.sourceIllustration) {
      const src = doc.project.sourceIllustration;
      if (typeof src.width !== 'number' || src.width <= 0 || src.width > RESOURCE_LIMITS.MAX_IMAGE_DIMENSION) {
        errors.push('project.sourceIllustration.width is out of valid bounds.');
      }
      if (typeof src.height !== 'number' || src.height <= 0 || src.height > RESOURCE_LIMITS.MAX_IMAGE_DIMENSION) {
        errors.push('project.sourceIllustration.height is out of valid bounds.');
      }
    }
  }

  if (!Array.isArray(doc.sourceObjects)) {
    errors.push('sourceObjects must be an array.');
  } else {
    if (doc.sourceObjects.length > RESOURCE_LIMITS.MAX_SOURCE_OBJECTS) {
      errors.push(`sourceObjects exceeds limit (${RESOURCE_LIMITS.MAX_SOURCE_OBJECTS}).`);
    }
    const seenSrcIds = new Set();
    for (const so of doc.sourceObjects) {
      if (!so || typeof so.id !== 'string' || !so.id) {
        errors.push('Every sourceObject must have a non-empty string id.');
        continue;
      }
      if (seenSrcIds.has(so.id)) errors.push(`Duplicate sourceObject id: ${so.id}`);
      seenSrcIds.add(so.id);
      if (so.bbox) {
        const { x, y, w, h } = so.bbox;
        if (![x, y, w, h].every(n => typeof n === 'number' && Number.isFinite(n)) || w <= 0 || h <= 0) {
          errors.push(`sourceObject ${so.id} has invalid bbox.`);
        }
      }
    }
  }

  const assetIds = new Set();
  if (!Array.isArray(doc.assets)) {
    errors.push('assets must be an array.');
  } else {
    for (const a of doc.assets) {
      if (!a || typeof a.id !== 'string' || !a.id) {
        errors.push('Every asset must have a non-empty string id.');
        continue;
      }
      if (assetIds.has(a.id)) errors.push(`Duplicate asset id: ${a.id}`);
      assetIds.add(a.id);
      if (a.lifecycleState && !ASSET_LIFECYCLE_STATES.includes(a.lifecycleState)) {
        warnings.push(`Asset ${a.id} has unrecognized lifecycleState: ${a.lifecycleState}`);
      }
    }
  }

  if (!Array.isArray(doc.scenes) || doc.scenes.length === 0) {
    errors.push('Project must contain at least one scene in scenes[].');
  } else {
    for (const scene of doc.scenes) {
      if (!scene || typeof scene.id !== 'string' || !scene.id) {
        errors.push('Every scene must have a non-empty string id.');
        continue;
      }
      if (!Array.isArray(scene.objects)) {
        errors.push(`Scene ${scene.id} must have an objects array.`);
        continue;
      }
      if (scene.objects.length > RESOURCE_LIMITS.MAX_SCENE_OBJECTS) {
        errors.push(`Scene ${scene.id} exceeds max objects (${RESOURCE_LIMITS.MAX_SCENE_OBJECTS}).`);
      }
      const seenObjIds = new Set();
      for (const obj of scene.objects) {
        if (!obj || typeof obj.id !== 'string' || !obj.id) {
          errors.push(`Scene ${scene.id} contains an object without a valid id.`);
          continue;
        }
        if (seenObjIds.has(obj.id)) errors.push(`Duplicate scene object id: ${obj.id}`);
        seenObjIds.add(obj.id);
        if (!isFiniteVec3(obj.position)) errors.push(`Object ${obj.id} has invalid position.`);
        if (!isFiniteVec3(obj.rotation)) errors.push(`Object ${obj.id} has invalid rotation.`);
        if (!isFiniteVec3(obj.scale) || obj.scale.some(s => s <= 0)) errors.push(`Object ${obj.id} has invalid scale.`);
        if (obj.temporalState && !TEMPORAL_STATES.includes(obj.temporalState)) {
          errors.push(`Object ${obj.id} has invalid temporalState: ${obj.temporalState}`);
        }
        if (obj.representationType && !REPRESENTATION_TYPES.includes(obj.representationType)) {
          warnings.push(`Object ${obj.id} has unrecognized representationType: ${obj.representationType}`);
        }
        if (obj.assetId && !assetIds.has(obj.assetId)) {
          warnings.push(`Object ${obj.id} references missing assetId: ${obj.assetId}`);
        }
      }
      if (scene.simulation) {
        const dt = scene.simulation.fixedDt;
        if (typeof dt !== 'number' || !Number.isFinite(dt) || dt <= 0 || dt > 0.1) {
          errors.push(`Scene ${scene.id} has invalid simulation.fixedDt.`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function getActiveScene(doc) {
  if (!doc || !Array.isArray(doc.scenes) || doc.scenes.length === 0) return null;
  const activeId = doc.project?.activeSceneId;
  return doc.scenes.find(s => s.id === activeId) || doc.scenes[0];
}
