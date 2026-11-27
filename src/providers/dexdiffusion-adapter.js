/**
 * Frozen Aperture — Manual GLB Import & Validated GLB Reuse Provider
 * Always available offline without external services.
 */

export class ManualGlbProvider {
  constructor(assetManager) {
    this.id = 'manual_glb';
    this.name = 'Manual GLB Import & Local Reuse';
    this.assetManager = assetManager;
    this.contract = {
      acceptedInputs: ['model/gltf-binary', '.glb'],
      requiresMask: false,
      requiresSourceContext: false,
      outputFormats: ['glb'],
      shapeOnly: false,
      textureOnly: false,
      combinedGeneration: false,
      supportsCancellation: false,
      offlineCapable: true,
      resourceRequirements: { gpu: false, minRamMb: 64 },
    };
  }

  async probe() {
    return {
      available: true,
      state: 'ready',
      reason: 'Always available offline for manual GLB import and validated asset reuse.',
      modes: ['import', 'reuse'],
    };
  }

  async runJob({ sourceObjectId, input, receipt }) {
    if (!input || !input.bytes || !input.project) {
      throw new Error('Manual GLB provider requires { project, bytes } input.');
    }
    receipt.progress = 50;
    const { asset, validation, reused } = await this.assetManager.registerGlbAsset(input.project, {
      bytes: input.bytes,
      label: input.label || 'Imported GLB',
      sourceObjectId,
      componentSlot: input.componentSlot || 'body',
      provider: this.id,
      rights: input.rights || 'private_unverified',
      surfaceClassification: input.surfaceClassification || 'manually_authored',
    });
    if (!validation.valid) {
      throw new Error(`GLB validation failed: ${validation.errors.join('; ')}`);
    }
    return {
      assetId: asset.id,
      message: reused ? 'Reused existing validated GLB asset.' : 'Imported and validated GLB asset.',
      reproducibility: { sha256: asset.sha256, byteLength: asset.byteLength },
    };
  }
}

/**
 * Frozen Aperture — DexDiffusion Read-Only-Verified Local Adapter
 *
 * Endpoints verified directly against westkitty/Image_Gen/operator-console/server.js
 * and asset3d-bridge.js:
 *   GET  /api/3d/workers        -> worker & mode capability probe (mesh, textured via hunyuan3d-swift)
 *   GET  /api/world/workers     -> world worker probe (SHARP / world compilation)
 *   POST /api/3d/jobs           -> { mode: 'mesh' | 'textured', sourceArtifactId }
 *   GET  /api/jobs/:jobId       -> job status & progress
 *   POST /api/jobs/:id/cancel   -> job cancellation
 *   GET  /api/media/:id/download -> download validated output GLB
 *
 * Never modifies DexDiffusion. Reports honest unavailable state when unreachable.
 */
export class DexDiffusionAdapter {
  constructor({ baseUrl = '', fetchImpl = null } = {}) {
    this.id = 'dexdiffusion_local';
    this.name = 'DexDiffusion Local 3D (Hunyuan3D Swift)';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.contract = {
      acceptedInputs: ['image/png', 'image/jpeg', 'sourceArtifactId'],
      requiresMask: true,
      requiresSourceContext: true,
      outputFormats: ['glb'],
      shapeOnly: true,           // mode: 'mesh'
      textureOnly: false,
      combinedGeneration: true,  // mode: 'textured'
      supportsCancellation: true,
      offlineCapable: false,
      resourceRequirements: { computeNode: 'Big Mac (Apple Silicon MLX)', maxConcurrency: 1 },
      verifiedEndpoints: [
        'GET /api/3d/workers',
        'GET /api/world/workers',
        'POST /api/3d/jobs',
        'GET /api/jobs/:jobId',
        'POST /api/jobs/:id/cancel',
        'GET /api/media/:id/download',
      ],
    };
  }

  setBaseUrl(url) {
    this.baseUrl = String(url || '').trim().replace(/\/+$/, '');
  }

  async probe() {
    if (!this.baseUrl) {
      return {
        available: false,
        state: 'unconfigured',
        reason: 'No local DexDiffusion endpoint configured. Manual GLB import remains available.',
        modes: {},
      };
    }
    if (!this.fetchImpl) {
      return {
        available: false,
        state: 'unavailable',
        reason: 'Fetch API unavailable in this runtime.',
        modes: {},
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/3d/workers`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          available: false,
          state: 'unavailable',
          reason: `DexDiffusion worker probe returned HTTP ${res.status}.`,
          modes: {},
        };
      }
      const data = await res.json();
      const modes = data.modes || {};
      const anyInstalled = Object.values(modes).some(m => m && m.installed);
      return {
        available: anyInstalled,
        state: anyInstalled ? 'ready' : 'disabled',
        reason: anyInstalled
          ? 'DexDiffusion 3D worker reachable and installed.'
          : 'DexDiffusion reachable, but Hunyuan3D Swift weights/binary are not installed.',
        modes,
        raw: data,
      };
    } catch (err) {
      clearTimeout(timer);
      return {
        available: false,
        state: 'unreachable',
        reason: `DexDiffusion endpoint unreachable (${err.name === 'AbortError' ? 'timeout' : err.message}). Manual workflows unaffected.`,
        modes: {},
      };
    }
  }

  async runJob({ mode = 'mesh', input = {}, receipt }) {
    if (!this.baseUrl) throw new Error('DexDiffusion endpoint not configured.');
    if (!['mesh', 'textured'].includes(mode)) {
      throw new Error(`Unsupported DexDiffusion 3D mode: ${mode} (expected 'mesh' or 'textured').`);
    }
    if (!input.sourceArtifactId) {
      throw new Error('DexDiffusion /api/3d/jobs requires a registered sourceArtifactId.');
    }

    const res = await this.fetchImpl(`${this.baseUrl}/api/3d/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ mode, sourceArtifactId: input.sourceArtifactId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DexDiffusion job submission failed (HTTP ${res.status}): ${text.slice(0, 160)}`);
    }
    const created = await res.json();
    receipt.remoteJobId = created.jobId || created.id || null;
    receipt.message = `Submitted to DexDiffusion (remote job ${receipt.remoteJobId || 'pending'}).`;
    return {
      assetId: null,
      message: receipt.message,
      reproducibility: { remoteJobId: receipt.remoteJobId, mode, endpoint: this.baseUrl },
    };
  }

  async cancelJob(_jobId, receipt) {
    if (!this.baseUrl || !receipt?.remoteJobId || !this.fetchImpl) return;
    await this.fetchImpl(`${this.baseUrl}/api/jobs/${encodeURIComponent(receipt.remoteJobId)}/cancel`, {
      method: 'POST',
    }).catch(() => {});
  }
}
