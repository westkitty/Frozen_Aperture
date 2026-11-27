/**
 * Frozen Aperture — Project Persistence Store
 * Handles save, open, revisions, validation, migration, and transparent storage reporting.
 * Never claims a file was written to local disk when persisted only in browser storage.
 */

import { migrateProject, validateProject, SCHEMA_VERSION } from './schema.js';
import { RESOURCE_LIMITS } from './security.js';

const STORAGE_PREFIX = 'frozen_aperture_project_v1:';
const INDEX_KEY = 'frozen_aperture_index_v1';

export class ProjectStore {
  constructor(storage = null) {
    this.storage = storage || (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
  }

  hasPersistentBrowserStorage() {
    return Boolean(this.storage);
  }

  listSaved() {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(INDEX_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  saveProject(doc, { bumpRevision = true } = {}) {
    const check = validateProject(doc);
    if (!check.valid) {
      throw new Error(`Cannot save invalid project: ${check.errors.join('; ')}`);
    }
    if (bumpRevision) {
      doc.project.revision = (doc.project.revision || 0) + 1;
    }
    doc.project.modifiedAt = new Date().toISOString();

    const json = JSON.stringify(doc);
    if (json.length > RESOURCE_LIMITS.MAX_PROJECT_JSON_BYTES) {
      throw new Error('Project exceeds maximum serialized JSON budget.');
    }

    if (!this.storage) {
      return {
        saved: false,
        storageMode: 'memory_only',
        revision: doc.project.revision,
        message: 'Browser storage unavailable; export JSON file to persist externally.',
      };
    }

    const key = STORAGE_PREFIX + doc.project.id;
    this.storage.setItem(key, json);

    const idx = this.listSaved().filter(item => item.id !== doc.project.id);
    idx.unshift({
      id: doc.project.id,
      name: doc.project.name,
      revision: doc.project.revision,
      modifiedAt: doc.project.modifiedAt,
      schemaVersion: doc.schemaVersion || SCHEMA_VERSION,
      isPublicFixture: Boolean(doc.project.isPublicFixture),
    });
    this.storage.setItem(INDEX_KEY, JSON.stringify(idx.slice(0, 30)));

    return {
      saved: true,
      storageMode: 'browser_local_storage',
      revision: doc.project.revision,
      message: `Saved revision ${doc.project.revision} to browser localStorage (use Export Project JSON for a portable file).`,
    };
  }

  loadProjectById(projectId) {
    if (!this.storage) throw new Error('Browser storage is unavailable.');
    const raw = this.storage.getItem(STORAGE_PREFIX + projectId);
    if (!raw) throw new Error(`Saved project not found: ${projectId}`);
    return this.parseAndValidateProjectJson(raw);
  }

  parseAndValidateProjectJson(jsonText) {
    if (typeof jsonText !== 'string' || jsonText.length > RESOURCE_LIMITS.MAX_PROJECT_JSON_BYTES) {
      throw new Error('Invalid or oversized project JSON payload.');
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`Malformed project JSON: ${err.message}`);
    }
    const migrated = migrateProject(parsed);
    const check = validateProject(migrated);
    if (!check.valid) {
      throw new Error(`Project validation failed: ${check.errors.join('; ')}`);
    }
    return { project: migrated, warnings: check.warnings };
  }

  serializeProject(doc) {
    const check = validateProject(doc);
    if (!check.valid) {
      throw new Error(`Cannot serialize invalid project: ${check.errors.join('; ')}`);
    }
    return JSON.stringify(doc, null, 2);
  }
}
