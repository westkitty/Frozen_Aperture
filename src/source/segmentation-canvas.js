/**
 * Frozen Aperture — Interactive 2D Source Workbench & Mask Segmentation Canvas
 * Supports pan, zoom, fit-to-view, 1:1 native resolution, coordinate readout,
 * rectangular selection, polygon mask creation, mask inversion, overlap overlays,
 * padding, undo, and alpha-aware PNG crop export.
 */

import { RESOURCE_LIMITS, sanitizeId, sanitizeLabel } from '../core/security.js';

export class SegmentationWorkbench {
  constructor(canvas, { onSelectionChange = null, onObjectsChange = null, onCoordChange = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelectionChange = onSelectionChange;
    this.onObjectsChange = onObjectsChange;
    this.onCoordChange = onCoordChange;

    this.image = null;
    this.sourceMeta = null;
    this.objects = [];
    this.selectedId = null;

    // View transform
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    // Tool state: 'rect' | 'polygon' | 'pan' | 'select'
    this.tool = 'rect';
    this.padding = 12;
    this.invertMask = false;
    this.showOverlaps = true;
    this.showMaskPreview = true;

    this.isDragging = false;
    this.dragStart = null;
    this.draftRect = null;
    this.draftPolygon = [];
    this.undoStack = [];

    this.bindEvents();
  }

  bindEvents() {
    this.canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', e => this.onPointerUp(e));
    this.canvas.addEventListener('dblclick', e => this.onDoubleClick(e));
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.zoom = Math.max(0.15, Math.min(8, this.zoom * factor));
      this.render();
    }, { passive: false });
  }

  setTool(tool) {
    this.tool = tool;
    this.draftPolygon = [];
    this.draftRect = null;
    this.render();
  }

  setImage(sourceMeta, objects = []) {
    this.sourceMeta = sourceMeta;
    this.objects = objects;
    if (!sourceMeta?.dataUrl) {
      this.image = null;
      this.render();
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.image = img;
      this.fitToView();
    };
    img.src = sourceMeta.dataUrl;
  }

  fitToView() {
    if (!this.image) {
      this.render();
      return;
    }
    const cw = this.canvas.width || 800;
    const ch = this.canvas.height || 500;
    const sx = (cw - 32) / this.image.naturalWidth;
    const sy = (ch - 32) / this.image.naturalHeight;
    this.zoom = Math.max(0.1, Math.min(sx, sy));
    this.panX = (cw - this.image.naturalWidth * this.zoom) * 0.5;
    this.panY = (ch - this.image.naturalHeight * this.zoom) * 0.5;
    this.render();
  }

  setNativeZoom() {
    if (!this.image) return;
    this.zoom = 1;
    this.panX = (this.canvas.width - this.image.naturalWidth) * 0.5;
    this.panY = (this.canvas.height - this.image.naturalHeight) * 0.5;
    this.render();
  }

  screenToImage(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (clientX - rect.left) * (this.canvas.width / rect.width);
    const sy = (clientY - rect.top) * (this.canvas.height / rect.height);
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
      sx,
      sy,
    };
  }

  pushUndo() {
    this.undoStack.push(JSON.parse(JSON.stringify(this.objects)));
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    const prev = this.undoStack.pop();
    this.objects.length = 0;
    for (const item of prev) this.objects.push(item);
    if (this.onObjectsChange) this.onObjectsChange(this.objects);
    this.render();
    return true;
  }

  onPointerDown(e) {
    if (!this.image) return;
    const pt = this.screenToImage(e.clientX, e.clientY);

    if (this.tool === 'pan' || e.button === 1) {
      this.isDragging = true;
      this.dragStart = { sx: pt.sx, sy: pt.sy, panX: this.panX, panY: this.panY };
      return;
    }

    if (this.tool === 'select') {
      const hit = this.objects.find(o => o.bbox && pt.x >= o.bbox.x && pt.x <= o.bbox.x + o.bbox.w && pt.y >= o.bbox.y && pt.y <= o.bbox.y + o.bbox.h);
      this.selectedId = hit ? hit.id : null;
      if (this.onSelectionChange) this.onSelectionChange(hit || null);
      this.render();
      return;
    }

    if (this.tool === 'rect') {
      this.isDragging = true;
      this.dragStart = { x: pt.x, y: pt.y };
      this.draftRect = { x: pt.x, y: pt.y, w: 0, h: 0 };
      return;
    }

    if (this.tool === 'polygon') {
      if (this.draftPolygon.length < RESOURCE_LIMITS.MAX_MASK_POINTS) {
        this.draftPolygon.push([Math.round(pt.x), Math.round(pt.y)]);
        this.render();
      }
    }
  }

  onPointerMove(e) {
    if (!this.image) return;
    const pt = this.screenToImage(e.clientX, e.clientY);
    if (this.onCoordChange) {
      this.onCoordChange({ x: Math.round(pt.x), y: Math.round(pt.y), zoom: this.zoom });
    }
    if (!this.isDragging || !this.dragStart) return;

    if (this.tool === 'pan') {
      this.panX = this.dragStart.panX + (pt.sx - this.dragStart.sx);
      this.panY = this.dragStart.panY + (pt.sy - this.dragStart.sy);
      this.render();
      return;
    }

    if (this.tool === 'rect' && this.draftRect) {
      this.draftRect.w = pt.x - this.dragStart.x;
      this.draftRect.h = pt.y - this.dragStart.y;
      this.render();
    }
  }

  onPointerUp() {
    if (!this.isDragging) return;
    this.isDragging = false;

    if (this.tool === 'rect' && this.draftRect) {
      const x = Math.max(0, Math.round(Math.min(this.draftRect.x, this.draftRect.x + this.draftRect.w)));
      const y = Math.max(0, Math.round(Math.min(this.draftRect.y, this.draftRect.y + this.draftRect.h)));
      const w = Math.round(Math.abs(this.draftRect.w));
      const h = Math.round(Math.abs(this.draftRect.h));
      this.draftRect = null;
      if (w >= 8 && h >= 8) {
        this.createSourceObject({ bbox: { x, y, w, h }, polygon: null });
      }
      this.render();
    }
  }

  onDoubleClick() {
    if (this.tool === 'polygon' && this.draftPolygon.length >= 3) {
      this.commitPolygon();
    }
  }

  commitPolygon() {
    if (this.draftPolygon.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of this.draftPolygon) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    const w = Math.round(maxX - minX);
    const h = Math.round(maxY - minY);
    const poly = [...this.draftPolygon];
    this.draftPolygon = [];
    if (w < 4 || h < 4) {
      this.render();
      return null;
    }
    const obj = this.createSourceObject({
      bbox: { x: Math.max(0, Math.round(minX)), y: Math.max(0, Math.round(minY)), w, h },
      polygon: poly,
    });
    this.render();
    return obj;
  }

  createSourceObject({ bbox, polygon = null, label = null }) {
    this.pushUndo();
    const index = this.objects.length + 1;
    const id = sanitizeId(`src_obj_${String(index).padStart(2, '0')}_${Date.now().toString(36).slice(-3)}`);
    const obj = {
      id,
      label: sanitizeLabel(label || `Extracted Object ${String(index).padStart(2, '0')}`),
      category: 'figure',
      bbox,
      mask: polygon ? { type: 'polygon', points: polygon, inverted: this.invertMask } : { type: 'rect', inverted: this.invertMask },
      padding: this.padding,
      depthOrder: index,
      reconstructionStatus: 'extracted',
      confidence: 1.0,
    };
    this.objects.push(obj);
    this.selectedId = obj.id;
    if (this.onObjectsChange) this.onObjectsChange(this.objects);
    if (this.onSelectionChange) this.onSelectionChange(obj);
    return obj;
  }

  /**
   * Produces an alpha-aware cropped PNG Data URL for the given source object,
   * respecting polygon masks, mask inversion, and crop padding.
   */
  exportAlphaCrop(sourceObject) {
    if (!this.image || !sourceObject?.bbox) return null;
    const pad = sourceObject.padding ?? this.padding ?? 0;
    const sx = Math.max(0, sourceObject.bbox.x - pad);
    const sy = Math.max(0, sourceObject.bbox.y - pad);
    const sw = Math.min(this.image.naturalWidth - sx, sourceObject.bbox.w + pad * 2);
    const sh = Math.min(this.image.naturalHeight - sy, sourceObject.bbox.h + pad * 2);
    if (sw <= 0 || sh <= 0) return null;

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw));
    out.height = Math.max(1, Math.round(sh));
    const ctx = out.getContext('2d');

    if (sourceObject.mask?.type === 'polygon' && Array.isArray(sourceObject.mask.points) && sourceObject.mask.points.length >= 3) {
      ctx.save();
      ctx.beginPath();
      const pts = sourceObject.mask.points;
      ctx.moveTo(pts[0][0] - sx, pts[0][1] - sy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] - sx, pts[i][1] - sy);
      ctx.closePath();
      if (sourceObject.mask.inverted) {
        ctx.rect(0, 0, out.width, out.height);
        ctx.clip('evenodd');
      } else {
        ctx.clip();
      }
      ctx.drawImage(this.image, sx, sy, sw, sh, 0, 0, out.width, out.height);
      ctx.restore();
    } else {
      ctx.drawImage(this.image, sx, sy, sw, sh, 0, 0, out.width, out.height);
    }

    return {
      dataUrl: out.toDataURL('image/png'),
      cropRect: { x: sx, y: sy, w: sw, h: sh },
      sourceWidth: this.image.naturalWidth,
      sourceHeight: this.image.naturalHeight,
    };
  }

  render() {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#070a12';
    ctx.fillRect(0, 0, cw, ch);

    if (!this.image) {
      ctx.fillStyle = '#64748b';
      ctx.font = '500 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Import a source illustration or load the Synthetic Calibration Plate to begin segmentation.', cw * 0.5, ch * 0.5);
      ctx.textAlign = 'left';
      return;
    }

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    ctx.drawImage(this.image, 0, 0);

    // Draw existing source objects & overlap detection
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (!o.bbox) continue;
      const isSelected = o.id === this.selectedId;

      ctx.save();
      if (this.showMaskPreview) {
        ctx.fillStyle = isSelected ? 'rgba(56, 189, 248, 0.22)' : 'rgba(148, 163, 184, 0.10)';
        if (o.mask?.type === 'polygon' && o.mask.points?.length >= 3) {
          ctx.beginPath();
          ctx.moveTo(o.mask.points[0][0], o.mask.points[0][1]);
          for (let p = 1; p < o.mask.points.length; p++) ctx.lineTo(o.mask.points[p][0], o.mask.points[p][1]);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = isSelected ? '#38bdf8' : '#94a3b8';
          ctx.lineWidth = 2 / this.zoom;
          ctx.stroke();
        } else {
          ctx.fillRect(o.bbox.x, o.bbox.y, o.bbox.w, o.bbox.h);
          ctx.strokeStyle = isSelected ? '#38bdf8' : '#94a3b8';
          ctx.lineWidth = 2 / this.zoom;
          ctx.strokeRect(o.bbox.x, o.bbox.y, o.bbox.w, o.bbox.h);
        }
      }

      // Label tag
      ctx.fillStyle = isSelected ? '#0284c7' : 'rgba(15, 23, 42, 0.88)';
      const fontSize = Math.max(10, 11 / this.zoom);
      ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
      const shortLabel = o.label.length > 12 ? o.label.slice(0, 11) + '…' : o.label;
      const tag = shortLabel;
      const tw = Math.min(o.bbox.w, ctx.measureText(tag).width + 8 / this.zoom);
      ctx.fillRect(o.bbox.x, Math.max(0, o.bbox.y - fontSize * 1.5), tw, fontSize * 1.45);
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(tag, o.bbox.x + 4 / this.zoom, Math.max(fontSize, o.bbox.y - fontSize * 0.35), o.bbox.w - 6 / this.zoom);
      ctx.restore();
    }

    // Overlap highlights
    if (this.showOverlaps) {
      for (let i = 0; i < this.objects.length; i++) {
        for (let j = i + 1; j < this.objects.length; j++) {
          const a = this.objects[i].bbox;
          const b = this.objects[j].bbox;
          if (!a || !b) continue;
          const ox = Math.max(a.x, b.x);
          const oy = Math.max(a.y, b.y);
          const ox2 = Math.min(a.x + a.w, b.x + b.w);
          const oy2 = Math.min(a.y + a.h, b.y + b.h);
          if (ox2 > ox && oy2 > oy) {
            ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
            ctx.fillRect(ox, oy, ox2 - ox, oy2 - oy);
            ctx.strokeStyle = '#f59e0b';
            ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
            ctx.lineWidth = 1.5 / this.zoom;
            ctx.strokeRect(ox, oy, ox2 - ox, oy2 - oy);
            ctx.setLineDash([]);
          }
        }
      }
    }

    // Draft rect
    if (this.draftRect) {
      ctx.strokeStyle = '#38bdf8';
      ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
      ctx.lineWidth = 2 / this.zoom;
      ctx.fillRect(this.draftRect.x, this.draftRect.y, this.draftRect.w, this.draftRect.h);
      ctx.strokeRect(this.draftRect.x, this.draftRect.y, this.draftRect.w, this.draftRect.h);
    }

    // Draft polygon
    if (this.draftPolygon.length > 0) {
      ctx.beginPath();
      ctx.moveTo(this.draftPolygon[0][0], this.draftPolygon[0][1]);
      for (let i = 1; i < this.draftPolygon.length; i++) {
        ctx.lineTo(this.draftPolygon[i][0], this.draftPolygon[i][1]);
      }
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2 / this.zoom;
      ctx.stroke();
      for (const [px, py] of this.draftPolygon) {
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(px, py, 4 / this.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }
}
