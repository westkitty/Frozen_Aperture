/**
 * Frozen Aperture — Content-Addressed IndexedDB Binary Store (#21)
 * Persists multi-megabyte GLB assets and high-resolution source illustrations
 * keyed by SHA-256 without hitting localStorage's ~5-10 MB quota.
 * Gracefully degrades to an in-memory map when IndexedDB is unavailable (e.g. Node tests).
 */

const DB_NAME = 'frozen_aperture_idb_v1';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';
const STORE_PROJECTS = 'projects';

export class IndexedDbAssetStore {
  constructor() {
    this.dbPromise = null;
    this.memoryBlobs = new Map();
    this.memoryProjects = new Map();
  }

  isSupported() {
    return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
  }

  open() {
    if (!this.isSupported()) return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_BLOBS)) {
            db.createObjectStore(STORE_BLOBS, { keyPath: 'sha256' });
          }
          if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
            db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async putBlob(sha256, bytes, mimeType = 'application/octet-stream') {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.memoryBlobs.set(sha256, u8);
    const db = await this.open();
    if (!db) return { persisted: false, backend: 'memory' };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      tx.objectStore(STORE_BLOBS).put({
        sha256,
        bytes: u8,
        mimeType,
        byteLength: u8.byteLength,
        storedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve({ persisted: true, backend: 'indexeddb' });
      tx.onerror = () => reject(tx.error || new Error('IndexedDB putBlob failed'));
    });
  }

  async getBlob(sha256) {
    if (this.memoryBlobs.has(sha256)) return this.memoryBlobs.get(sha256);
    const db = await this.open();
    if (!db) return null;

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_BLOBS, 'readonly');
      const req = tx.objectStore(STORE_BLOBS).get(sha256);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec && rec.bytes) {
          const u8 = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
          this.memoryBlobs.set(sha256, u8);
          resolve(u8);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  }

  async putProject(projectDoc) {
    const id = projectDoc?.project?.id;
    if (!id) throw new Error('Project must have project.id');
    const clone = JSON.parse(JSON.stringify(projectDoc));
    this.memoryProjects.set(id, clone);
    const db = await this.open();
    if (!db) return { persisted: false, backend: 'memory' };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readwrite');
      tx.objectStore(STORE_PROJECTS).put({
        id,
        name: clone.project.name,
        revision: clone.project.revision,
        modifiedAt: clone.project.modifiedAt,
        schemaVersion: clone.schemaVersion,
        doc: clone,
      });
      tx.oncomplete = () => resolve({ persisted: true, backend: 'indexeddb' });
      tx.onerror = () => reject(tx.error || new Error('IndexedDB putProject failed'));
    });
  }

  async getProject(id) {
    const db = await this.open();
    if (!db) return this.memoryProjects.get(id) || null;

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const req = tx.objectStore(STORE_PROJECTS).get(id);
      req.onsuccess = () => resolve(req.result?.doc || this.memoryProjects.get(id) || null);
      req.onerror = () => resolve(this.memoryProjects.get(id) || null);
    });
  }

  async listProjects() {
    const db = await this.open();
    if (!db) {
      return Array.from(this.memoryProjects.values()).map(p => ({
        id: p.project.id,
        name: p.project.name,
        revision: p.project.revision,
        modifiedAt: p.project.modifiedAt,
        schemaVersion: p.schemaVersion,
      }));
    }

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const req = tx.objectStore(STORE_PROJECTS).getAll();
      req.onsuccess = () => {
        const items = (req.result || []).map(r => ({
          id: r.id,
          name: r.name,
          revision: r.revision,
          modifiedAt: r.modifiedAt,
          schemaVersion: r.schemaVersion,
        }));
        items.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
        resolve(items);
      };
      req.onerror = () => resolve([]);
    });
  }
}
