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

  /**
   * Uploads a cropped character PNG into Big Mac's canonical DexDiffusion Library
   * via POST /api/library/images/import?name=... (verified against westkitty/Image_Gen).
   * Returns { id, url, width, height, runId }.
   */
  async importImageToLibrary(pngBytes, filename = 'cutout.png') {
    if (!this.baseUrl || !this.fetchImpl) throw new Error('DexDiffusion endpoint not configured.');
    const safeName = encodeURIComponent(String(filename || 'cutout.png').slice(0, 120));
    const res = await this.fetchImpl(`${this.baseUrl}/api/library/images/import?name=${safeName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        Accept: 'application/json',
      },
      body: pngBytes,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DexDiffusion image import failed (HTTP ${res.status}): ${text.slice(0, 160)}`);
    }
    const data = await res.json();
    if (!data?.id) throw new Error('DexDiffusion image import returned no artifact id.');
    return data;
  }

  /**
   * Decodes a data:image/png;base64,... URL into a Uint8Array without external dependencies.
   */
  static dataUrlToBytes(dataUrl) {
    const idx = String(dataUrl || '').indexOf(',');
    if (idx === -1) throw new Error('Invalid image data URL.');
    const b64 = dataUrl.slice(idx + 1);
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  /**
   * Extracts the output GLB mediaId from any verified westkitty/Image_Gen job response shape.
   */
  static extractOutputMediaId(job) {
    if (!job) return null;
    if (job.outputMediaId) return job.outputMediaId;
    if (job.artifactId) return job.artifactId;
    if (job.mediaId) return job.mediaId;
    if (Array.isArray(job.results)) {
      const first = job.results.find(r => r && (r.imageId || r.artifactId || r.mediaId));
      if (first) return first.imageId || first.artifactId || first.mediaId;
    }
    if (Array.isArray(job.generic?.artifacts) && job.generic.artifacts.length > 0) {
      return job.generic.artifacts[0];
    }
    if (Array.isArray(job.artifacts) && job.artifacts.length > 0) {
      return job.artifacts[0];
    }
    return null;
  }

  /**
   * Full 1-click end-to-end pipeline:
   * 1. Uploads character cutout PNG -> POST /api/library/images/import
   * 2. Starts Hunyuan3D Swift job   -> POST /api/3d/jobs ({ mode, sourceArtifactId })
   * 3. Polls until completion       -> GET  /api/jobs/:jobId
   * 4. Downloads & validates GLB    -> GET  /api/media/:id/download
   */
  async reconstructCutoutToGlb({
    pngBytes = null,
    dataUrl = null,
    filename = 'character.png',
    mode = 'textured',
    project,
    assetManager,
    sourceObjectId = null,
    label = 'Hunyuan3D Character',
    onProgress = null,
    signal = null,
    pollIntervalMs = 1800,
    pollTimeoutMs = 420000,
  }) {
    if (!this.baseUrl) throw new Error('Big Mac DexDiffusion endpoint not configured.');
    const bytes = pngBytes || DexDiffusionAdapter.dataUrlToBytes(dataUrl);

    if (onProgress) onProgress({ stage: 'uploading', progress: 10, label: `Uploading ${label} to Big Mac…` });
    const imported = await this.importImageToLibrary(bytes, filename);

    if (signal?.aborted) throw new Error('Reconstruction cancelled.');
    if (onProgress) onProgress({ stage: 'starting', progress: 20, label: `Starting Hunyuan3D (${mode}) for ${label}…` });

    const startRes = await this.fetchImpl(`${this.baseUrl}/api/3d/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ mode, sourceArtifactId: imported.id }),
    });
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => '');
      throw new Error(`DexDiffusion 3D job start failed (HTTP ${startRes.status}): ${text.slice(0, 160)}`);
    }
    const created = await startRes.json();
    const remoteJobId = created.jobId || created.id;
    if (!remoteJobId) throw new Error('DexDiffusion /api/3d/jobs returned no jobId.');

    const finalJob = await this.pollJob(remoteJobId, {
      intervalMs: pollIntervalMs,
      timeoutMs: pollTimeoutMs,
      signal,
      onProgress: (p) => {
        if (onProgress) {
          onProgress({
            stage: 'running',
            progress: typeof p?.progress === 'number' ? Math.max(25, Math.min(90, p.progress)) : 55,
            label: p?.label || `Hunyuan3D reconstructing ${label}…`,
            remoteJobId,
          });
        }
      },
    });

    if (['FAIL', 'FAILED', 'ERROR', 'INTERRUPTED', 'CANCELLED', 'CANCELED'].includes(finalJob.status)) {
      throw new Error(`Hunyuan3D job ${finalJob.status}: ${finalJob.error || finalJob.firstFailedGate || 'see Big Mac console log'}`);
    }

    const mediaId = DexDiffusionAdapter.extractOutputMediaId(finalJob);
    if (!mediaId) {
      throw new Error(`Hunyuan3D job ${remoteJobId} finished (${finalJob.status}) but returned no output GLB media ID.`);
    }

    if (onProgress) onProgress({ stage: 'downloading', progress: 92, label: `Downloading validated 3D GLB for ${label}…`, remoteJobId });
    const reg = await this.downloadAndRegisterGlb(mediaId, {
      project,
      assetManager,
      sourceObjectId,
      label: `${label} (Hunyuan3D ${mode})`,
    });

    if (onProgress) onProgress({ stage: 'done', progress: 100, label: `3D GLB ready for ${label}.`, remoteJobId });
    return {
      asset: reg.asset,
      validation: reg.validation,
      sourceArtifactId: imported.id,
      remoteJobId,
      mediaId,
    };
  }

  async runJob({ mode = 'mesh', input = {}, receipt }) {
    if (!this.baseUrl) throw new Error('DexDiffusion endpoint not configured.');
    if (!['mesh', 'textured'].includes(mode)) {
      throw new Error(`Unsupported DexDiffusion 3D mode: ${mode} (expected 'mesh' or 'textured').`);
    }
    let sourceArtifactId = input.sourceArtifactId;
    if (!sourceArtifactId && (input.pngBytes || input.dataUrl)) {
      const bytes = input.pngBytes || DexDiffusionAdapter.dataUrlToBytes(input.dataUrl);
      const imported = await this.importImageToLibrary(bytes, input.filename || 'cutout.png');
      sourceArtifactId = imported.id;
    }
    if (!sourceArtifactId) {
      throw new Error('DexDiffusion /api/3d/jobs requires a sourceArtifactId or cutout image.');
    }

    const res = await this.fetchImpl(`${this.baseUrl}/api/3d/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ mode, sourceArtifactId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DexDiffusion job submission failed (HTTP ${res.status}): ${text.slice(0, 160)}`);
    }
    const created = await res.json();
    receipt.remoteJobId = created.jobId || created.id || null;
    receipt.message = `Submitted to DexDiffusion (remote job ${receipt.remoteJobId || 'pending'}).`;

    // Optional live polling + auto-download & validation (#6)
    if (input.pollUntilComplete && receipt.remoteJobId) {
      const finalJob = await this.pollJob(receipt.remoteJobId, {
        intervalMs: input.pollIntervalMs ?? 1500,
        timeoutMs: input.pollTimeoutMs ?? 300000,
        onProgress: (p) => {
          if (typeof p?.progress === 'number') receipt.progress = p.progress;
          if (p?.label) receipt.message = p.label;
        },
      });
      if (['FAIL', 'FAILED', 'ERROR', 'INTERRUPTED', 'CANCELLED', 'CANCELED'].includes(finalJob.status)) {
        throw new Error(`DexDiffusion remote job ${finalJob.status}: ${finalJob.error || 'see remote log'}`);
      }
      const mediaId = DexDiffusionAdapter.extractOutputMediaId(finalJob);
      if (mediaId && input.assetManager && input.project) {
        const reg = await this.downloadAndRegisterGlb(mediaId, {
          project: input.project,
          assetManager: input.assetManager,
          sourceObjectId: input.sourceObjectId || null,
          label: input.label || `DexDiffusion ${mode} (${mediaId})`,
        });
        return {
          assetId: reg.asset.id,
          message: `Downloaded & validated DexDiffusion GLB (${reg.asset.id}).`,
          reproducibility: { remoteJobId: receipt.remoteJobId, mediaId, sha256: reg.asset.sha256, mode, endpoint: this.baseUrl },
        };
      }
    }

    return {
      assetId: null,
      message: receipt.message,
      reproducibility: { remoteJobId: receipt.remoteJobId, mode, endpoint: this.baseUrl },
    };
  }

  /**
   * Polls GET /api/jobs/:jobId until terminal state (PASS/COMPLETE/DONE/FAIL/CANCELLED) (#6).
   */
  async pollJob(remoteJobId, { intervalMs = 1500, timeoutMs = 300000, onProgress = null, signal = null } = {}) {
    if (!this.baseUrl || !this.fetchImpl) throw new Error('DexDiffusion endpoint not configured.');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancelJob(null, { remoteJobId });
        throw new Error('DexDiffusion job cancelled by user.');
      }
      const res = await this.fetchImpl(`${this.baseUrl}/api/jobs/${encodeURIComponent(remoteJobId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Job poll HTTP ${res.status}`);
      const job = await res.json();
      if (onProgress && job.progress) onProgress(job.progress);
      const st = String(job.status || job.state || '').toUpperCase();
      if (['PASS', 'COMPLETE', 'DONE', 'COMPLETED', 'SUCCEEDED', 'FAIL', 'FAILED', 'ERROR', 'INTERRUPTED', 'CANCELLED', 'CANCELED'].includes(st)) {
        return { ...job, status: st };
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`DexDiffusion job ${remoteJobId} polling timed out after ${timeoutMs}ms.`);
  }

  /**
   * Downloads a completed GLB via GET /api/media/:id/download and runs full structural validation (#6).
   */
  async downloadAndRegisterGlb(mediaId, { project, assetManager, sourceObjectId = null, label = 'DexDiffusion GLB' }) {
    if (!this.baseUrl || !this.fetchImpl) throw new Error('DexDiffusion endpoint not configured.');
    const res = await this.fetchImpl(`${this.baseUrl}/api/media/${encodeURIComponent(mediaId)}/download`);
    if (!res.ok) throw new Error(`Media download failed (HTTP ${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const result = await assetManager.registerGlbAsset(project, {
      bytes,
      label,
      sourceObjectId,
      provider: this.id,
      model: 'hunyuan3d-swift',
      rights: 'private_generated',
      surfaceClassification: 'inferred',
      notes: `Auto-downloaded from DexDiffusion media ${mediaId}.`,
    });
    if (!result.validation.valid) {
      throw new Error(`Downloaded DexDiffusion GLB failed validation: ${result.validation.errors.join('; ')}`);
    }
    return result;
  }

  /**
   * Probes GET /api/world/workers (Apple SHARP / panorama / spatial world compilation) (#7).
   */
  async probeWorldWorkers() {
    if (!this.baseUrl || !this.fetchImpl) {
      return { available: false, state: 'unconfigured', reason: 'DexDiffusion endpoint not configured.' };
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/world/workers`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return { available: false, state: 'unavailable', reason: `HTTP ${res.status}` };
      const data = await res.json();
      return { available: true, state: 'ready', collisionReady: false, representationType: 'background_representation', workers: data };
    } catch (err) {
      return { available: false, state: 'unreachable', reason: err.message };
    }
  }

  /**
   * Submits a World/SHARP background reconstruction project via POST /api/world/projects (#7).
   * Explicitly tags output as non-collision background_representation.
   */
  async submitWorldProject({ sourceArtifactId, mode = 'quick3d', parameters = {} }) {
    if (!this.baseUrl || !this.fetchImpl) throw new Error('DexDiffusion endpoint not configured.');
    if (!sourceArtifactId) throw new Error('sourceArtifactId is required for /api/world/projects.');
    const res = await this.fetchImpl(`${this.baseUrl}/api/world/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ mode, sourceArtifactId, parameters, save_prompts: false }),
    });
    if (!res.ok) throw new Error(`World project submission failed (HTTP ${res.status}).`);
    const data = await res.json();
    return { ...data, representationType: 'background_representation', collisionReady: false };
  }

  async cancelJob(_jobId, receipt) {
    if (!this.baseUrl || !receipt?.remoteJobId || !this.fetchImpl) return;
    await this.fetchImpl(`${this.baseUrl}/api/jobs/${encodeURIComponent(receipt.remoteJobId)}/cancel`, {
      method: 'POST',
    }).catch(() => {});
  }
}
