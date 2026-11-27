/**
 * Frozen Aperture — Project Persistence Store
 * Handles save, open, revisions, validation, migration, and transparent storage reporting.
 * Never claims a file was written to local disk when persisted only in browser storage.
 */

import { migrateProject, validateProject, SCHEMA_VERSION } from './schema.js';
import { RESOURCE_LIMITS } from './security.js';
import { IndexedDbAssetStore } from './idb-store.js';

const STORAGE_PREFIX = 'frozen_aperture_project_v1:';
const INDEX_KEY = 'frozen_aperture_index_v1';

export class ProjectStore {
  constructor(storage = null, idbStore = null) {
    this.storage = storage || (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
    this.idb = idbStore || new IndexedDbAssetStore();
  }

  async saveProjectAsync(doc, assetManager = null, { bumpRevision = true } = {}) {
    const check = validateProject(doc);
    if (!check.valid) throw new Error(`Cannot save invalid project: ${check.errors.join('; ')}`);
    if (bumpRevision) doc.project.revision = (doc.project.revision || 0) + 1;
    doc.project.modifiedAt = new Date().toISOString();

    // Persist large binary assets content-addressed by SHA-256 in IndexedDB
    let blobsStored = 0;
    const strippedDoc = JSON.parse(JSON.stringify(doc));
    if (assetManager) {
      for (const a of strippedDoc.assets || []) {
        const bytes = assetManager.getBytes(doc, a.id);
        if (bytes && a.sha256) {
          await this.idb.putBlob(a.sha256, bytes, 'model/gltf-binary');
          a.storedInIdb = true;
          if (bytes.byteLength > 256 * 1024) a.embeddedBase64 = null;
          blobsStored++;
        }
      }
    }

    const idbRes = await this.idb.putProject(strippedDoc);
    // Also mirror lightweight metadata in localStorage if small enough
    if (this.storage) {
      try {
        this.saveProject(strippedDoc, { bumpRevision: false });
      } catch (_) {
        // Ignore localStorage quota exceeded when IndexedDB succeeded
      }
    }

    return {
      saved: idbRes.persisted || Boolean(this.storage),
      storageMode: idbRes.persisted ? 'indexeddb' : (this.storage ? 'browser_local_storage' : 'memory_only'),
      revision: doc.project.revision,
      blobsStored,
      message: idbRes.persisted
        ? `Saved revision ${doc.project.revision} to IndexedDB (${blobsStored} binary assets content-addressed).`
        : `Saved revision ${doc.project.revision} (${idbRes.backend}).`,
    };
  }

  async loadProjectAsync(projectId, assetManager = null) {
    let rawDoc = await this.idb.getProject(projectId);
    if (!rawDoc && this.storage) {
      const res = this.loadProjectById(projectId);
      rawDoc = res.project;
    }
    if (!rawDoc) throw new Error(`Saved project not found: ${projectId}`);
    const migrated = migrateProject(rawDoc);
    const check = validateProject(migrated);
    if (!check.valid) throw new Error(`Project validation failed: ${check.errors.join('; ')}`);

    // Hydrate binary GLBs from IndexedDB into AssetManager
    if (assetManager) {
      for (const a of migrated.assets || []) {
        if (a.sha256 && !assetManager.binaryStore.has(a.id)) {
          const bytes = await this.idb.getBlob(a.sha256);
          if (bytes) assetManager.binaryStore.set(a.id, bytes);
        }
      }
    }
    return { project: migrated, warnings: check.warnings };
  }

  async listSavedAsync() {
    const idbList = await this.idb.listProjects();
    const lsList = this.listSaved();
    const byId = new Map();
    for (const item of [...lsList, ...idbList]) byId.set(item.id, item);
    return Array.from(byId.values()).sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
  }

  async deleteProjectAsync(projectId) {
    await this.idb.deleteProject(projectId);
    if (this.storage) {
      try {
        this.storage.removeItem(STORAGE_PREFIX + projectId);
        const idx = this.listSaved().filter(item => item.id !== projectId);
        this.storage.setItem(INDEX_KEY, JSON.stringify(idx));
      } catch (_) {}
    }
    return true;
  }

  async getStorageEstimate() {
    if (typeof globalThis.navigator !== 'undefined' && globalThis.navigator.storage?.estimate) {
      try {
        const est = await globalThis.navigator.storage.estimate();
        return { usageBytes: est.usage || 0, quotaBytes: est.quota || 0 };
      } catch (_) {}
    }
    return null;
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
