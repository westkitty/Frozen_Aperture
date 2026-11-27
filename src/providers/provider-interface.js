/**
 * Frozen Aperture — Reconstruction Provider Interface & Bounded Job Queue
 * Enforces explicit operator initiation, concurrency=1 admission control,
 * job receipts, failure localization, and honest availability reporting.
 */

import { RESOURCE_LIMITS } from '../core/security.js';

export class ProviderRegistry {
  constructor({ maxConcurrency = RESOURCE_LIMITS.MAX_PROVIDER_CONCURRENCY } = {}) {
    this.providers = new Map();
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.activeJobs = new Map();
  }

  register(provider) {
    if (!provider || typeof provider.id !== 'string') {
      throw new Error('Provider must define a string id.');
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  list() {
    return Array.from(this.providers.values());
  }

  get(id) {
    return this.providers.get(id) || null;
  }

  async discoverAll() {
    const results = [];
    for (const provider of this.providers.values()) {
      try {
        const status = await provider.probe();
        results.push({ id: provider.id, name: provider.name, contract: provider.contract, status });
      } catch (err) {
        results.push({
          id: provider.id,
          name: provider.name,
          contract: provider.contract,
          status: { available: false, state: 'unavailable', reason: String(err.message || err) },
        });
      }
    }
    return results;
  }

  /**
   * Submits an operator-initiated reconstruction job with bounded queue & admission checks.
   * Failed or blocked jobs never corrupt or discard existing project state.
   */
  async submitJob(project, { providerId, sourceObjectId, mode = 'mesh', input = {}, operatorInitiated = false }) {
    if (!operatorInitiated) {
      throw new Error('Reconstruction jobs require explicit operator initiation.');
    }

    const provider = this.get(providerId);
    if (!provider) {
      throw new Error(`Unknown reconstruction provider: ${providerId}`);
    }

    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    const receipt = {
      id: jobId,
      providerId,
      sourceObjectId,
      mode,
      state: 'queued',
      progress: 0,
      message: 'Checking resource admission...',
      createdAt: now,
      updatedAt: now,
      outputAssetId: null,
      error: null,
      reproducibility: {
        provider: provider.id,
        mode,
        submittedAt: now,
      },
    };

    if (!Array.isArray(project.jobs)) project.jobs = [];
    project.jobs.push(receipt);

    // Bounded concurrency admission check
    if (this.activeJobs.size >= this.maxConcurrency) {
      receipt.state = 'blocked';
      receipt.message = `Blocked by bounded queue capacity (${this.maxConcurrency}). Existing project state preserved.`;
      receipt.updatedAt = new Date().toISOString();
      return receipt;
    }

    const probe = await provider.probe();
    if (!probe.available) {
      receipt.state = 'blocked';
      receipt.message = probe.reason || 'Provider is unavailable.';
      receipt.error = receipt.message;
      receipt.updatedAt = new Date().toISOString();
      return receipt;
    }

    // Validate input mask / region is non-empty before expensive work
    if (input.bbox && (input.bbox.w <= 0 || input.bbox.h <= 0)) {
      receipt.state = 'failed';
      receipt.error = 'Empty or invalid source region rejected before reconstruction.';
      receipt.message = receipt.error;
      receipt.updatedAt = new Date().toISOString();
      return receipt;
    }

    this.activeJobs.set(jobId, { provider, receipt });
    receipt.state = 'running';
    receipt.message = 'Job admitted and running.';
    receipt.updatedAt = new Date().toISOString();

    try {
      const result = await provider.runJob({ jobId, sourceObjectId, mode, input, receipt });
      receipt.state = result.cancelled ? 'cancelled' : 'completed';
      receipt.progress = result.cancelled ? receipt.progress : 100;
      receipt.outputAssetId = result.assetId || null;
      receipt.message = result.message || 'Completed.';
      receipt.reproducibility = { ...receipt.reproducibility, ...(result.reproducibility || {}) };
      receipt.updatedAt = new Date().toISOString();
    } catch (err) {
      receipt.state = 'failed';
      receipt.error = String(err.message || err);
      receipt.message = `Failed: ${receipt.error}. Prior project state preserved.`;
      receipt.updatedAt = new Date().toISOString();
    } finally {
      this.activeJobs.delete(jobId);
    }

    return receipt;
  }

  async cancelJob(project, jobId) {
    const active = this.activeJobs.get(jobId);
    const receipt = project.jobs?.find(j => j.id === jobId);
    if (!receipt) throw new Error(`Job not found: ${jobId}`);
    if (active && typeof active.provider.cancelJob === 'function') {
      await active.provider.cancelJob(jobId, receipt);
    }
    receipt.state = 'cancelled';
    receipt.message = 'Cancelled by operator.';
    receipt.updatedAt = new Date().toISOString();
    this.activeJobs.delete(jobId);
    return receipt;
  }
}
