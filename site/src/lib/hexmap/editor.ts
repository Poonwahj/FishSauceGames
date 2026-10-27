// Canvas-based hex map editor. Knows nothing about Firestore or the page's sidebar — the page
// wires it up through the callbacks in EditorCallbacks.
import {
  HEX_CORNERS,
  HEX_RADIUS,
  UNASSIGNED,
  UNASSIGNED_COLOR,
  cellColumn,
  cellRow,
  cellsInRadius,
  hexAt,
  hexCenter,
  mapSize,
  neighbours,
  type HexMap,
  type Note,
} from './model';

export type Tool = 'select' | 'paint' | 'fill' | 'score' | 'pen' | 'erase' | 'note' | 'pan';
export type FillMode = 'terrain' | 'walk' | 'polygon';
export type LabelMode = 'none' | 'walk' | 'polygon' | 'both';
export type ScoreChannel = 'walk' | 'polygon';

export interface ViewOptions {
  fill: FillMode;
  labels: LabelMode;
  showMarkup: boolean;
  showGrid: boolean;
  showIndices: boolean;
}

export interface EditorCallbacks {
  /** An edit was committed (also fires after undo/redo). */
  onChange?: () => void;
  onSelect?: (cellIndex: number) => void;
  onHover?: (cellIndex: number) => void;
  /** Note tool clicked: an existing note (index) or empty space (index null, map coords). */
  onNoteRequest?: (noteIndex: number | null, x: number, y: number) => void;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
}

const UNDO_LIMIT = 100;
const NOTE_FONT_PX = 13;

export class HexMapEditor {
  map: HexMap;
  readOnly = false;

  tool: Tool = 'paint';
  terrainIndex = 0;
  brushRadius = 0;
  scoreChannel: ScoreChannel = 'walk';
  scoreValue = 1;
  penColor = '#ff3b6b';
  penWidth = 0.15;
  view: ViewOptions = { fill: 'terrain', labels: 'both', showMarkup: true, showGrid: true, showIndices: false };

  selected = -1;
  private hovered = -1;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private callbacks: EditorCallbacks;
  private camera = { x: 0, y: 0, zoom: 30 }; // screen = (map - camera) * zoom
  private dpr = 1;
  private renderQueued = false;
  private cameraTouched = false;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private opSnapshot: string | null = null;
  private opChanged = false;

  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: { kind: 'pan'; lastX: number; lastY: number } | { kind: 'pinch'; dist: number; midX: number; midY: number } | null = null;
  private drawing:
    | { kind: 'paint' | 'score'; last: number; lastX: number; lastY: number }
    | { kind: 'erase' }
    | { kind: 'pen'; points: number[] }
    | null = null;
  private spaceHeld = false;
  private noteBoxes: { index: number; x: number; y: number; w: number; h: number }[] = [];

  constructor(canvas: HTMLCanvasElement, map: HexMap, callbacks: EditorCallbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.map = map;
    this.callbacks = callbacks;

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('lostpointercapture', (e) => {
      if (this.pointers.has(e.pointerId)) this.onPointerUp(e);
    });
    canvas.addEventListener('pointerleave', () => this.setHovered(-1));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) {
        this.spaceHeld = true;
        this.updateCursor();
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceHeld = false;
        this.updateCursor();
      }
    });
    this.resize();
  }

  // ---------- Public API ----------

  setMap(map: HexMap, resetHistory: boolean) {
    this.map = map;
    if (this.selected >= map.columns * map.rows) this.select(-1);
    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
      this.emitHistory();
    }
    this.requestRender();
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.updateCursor();
  }

  setReadOnly(readOnly: boolean) {
    this.readOnly = readOnly;
    this.updateCursor();
  }

  setView(patch: Partial<ViewOptions>) {
    Object.assign(this.view, patch);
    this.requestRender();
  }

  select(index: number) {
    this.selected = index;
    this.callbacks.onSelect?.(index);
    this.requestRender();
  }

  fitView() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const { width, height } = mapSize(this.map.columns, this.map.rows);
    const pad = 24;
    this.camera.zoom = Math.max(1, Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height));
    this.camera.x = width / 2 - rect.width / 2 / this.camera.zoom;
    this.camera.y = height / 2 - rect.height / 2 / this.camera.zoom;
    this.requestRender();
  }

  zoomBy(factor: number) {
    const rect = this.canvas.getBoundingClientRect();
    this.zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  /**
   * Wraps a programmatic edit (inspector field, palette change, resize…) so it lands on the undo
   * stack and triggers onChange. `fn` returns false to signal nothing changed.
   */
  edit(fn: (map: HexMap) => HexMap | boolean | void) {
    if (this.readOnly) return;
    const before = JSON.stringify(this.map);
    const result = fn(this.map);
    if (result === false) return;
    if (result && typeof result === 'object') this.map = result;
    this.pushUndo(before);
    this.callbacks.onChange?.();
    this.requestRender();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev || this.readOnly) return;
    this.redoStack.push(JSON.stringify(this.map));
    this.map = JSON.parse(prev);
    this.afterHistoryJump();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next || this.readOnly) return;
    this.undoStack.push(JSON.stringify(this.map));
    this.map = JSON.parse(next);
    this.afterHistoryJump();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  // ---------- History ----------

  private pushUndo(snapshot: string) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.emitHistory();
  }

  private afterHistoryJump() {
    if (this.selected >= this.map.columns * this.map.rows) this.selected = -1;
    this.emitHistory();
    this.callbacks.onChange?.();
    this.callbacks.onSelect?.(this.selected);
    this.requestRender();
  }

  private emitHistory() {
    this.callbacks.onHistoryChange?.(this.canUndo, this.canRedo);
  }

  private beginOp() {
    this.opSnapshot = JSON.stringify(this.map);
    this.opChanged = false;
  }

  private commitOp() {
    if (this.opSnapshot && this.opChanged) {
      this.pushUndo(this.opSnapshot);
      this.callbacks.onChange?.();
    }
    this.opSnapshot = null;
    this.opChanged = false;
  }

  // ---------- Coordinates ----------

  private toMap(sx: number, sy: number) {
    return { x: sx / this.camera.zoom + this.camera.x, y: sy / this.camera.zoom + this.camera.y };
  }

  private toScreen(x: number, y: number) {
    return { x: (x - this.camera.x) * this.camera.zoom, y: (y - this.camera.y) * this.camera.zoom };
  }

  private localPoint(e: PointerEvent | WheelEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    this.cameraTouched = true;
    const before = this.toMap(sx, sy);
    this.camera.zoom = Math.min(400, Math.max(1, this.camera.zoom * factor));
    this.camera.x = before.x - sx / this.camera.zoom;
    this.camera.y = before.y - sy / this.camera.zoom;
    this.requestRender();
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    // Keep the whole map in view as the layout settles (banner appearing, window resizing)
    // until the user pans or zooms themselves.
    if (!this.cameraTouched && rect.width > 0 && rect.height > 0) this.fitView();
    this.render();
  }

  // ---------- Input ----------

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.localPoint(e);
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    } else {
      this.cameraTouched = true;
      this.camera.x += e.deltaX / this.camera.zoom;
      this.requestRender();
    }
  }

  private onPointerDown(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.localPoint(e);
    // A mouse is only ever one pointer; clearing guards against a missed pointerup turning the
    // next click into a phantom pinch.
    if (e.pointerType === 'mouse') this.pointers.clear();
    this.pointers.set(e.pointerId, p);

    // Second finger: abandon whatever the first finger started and pinch instead.
    if (this.pointers.size === 2) {
      this.cancelDrawing();
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
      return;
    }
    if (this.pointers.size > 2) return;

    const panning = e.button === 1 || e.button === 2 || this.tool === 'pan' || this.spaceHeld;
    if (panning) {
      this.gesture = { kind: 'pan', lastX: p.x, lastY: p.y };
      this.updateCursor(true);
      return;
    }
    if (e.button !== 0) return;

    const m = this.toMap(p.x, p.y);
    const cell = hexAt(m.x, m.y, this.map.columns, this.map.rows);

    if (this.tool === 'select' || this.readOnly) {
      this.select(cell);
      return;
    }

    switch (this.tool) {
      case 'paint':
      case 'score':
        this.beginOp();
        this.drawing = { kind: this.tool, last: -1, lastX: m.x, lastY: m.y };
        this.applyBrush(cell);
        break;
      case 'fill':
        this.beginOp();
        this.floodFill(cell);
        this.commitOp();
        break;
      case 'pen':
        this.beginOp();
        this.drawing = { kind: 'pen', points: [round2(m.x), round2(m.y)] };
        break;
      case 'erase':
        this.beginOp();
        this.drawing = { kind: 'erase' };
        this.eraseAt(p.x, p.y);
        break;
      case 'note': {
        const hit = this.noteAt(p.x, p.y);
        this.callbacks.onNoteRequest?.(hit, round2(m.x), round2(m.y));
        break;
      }
    }
    this.requestRender();
  }

  private onPointerMove(e: PointerEvent) {
    const p = this.localPoint(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);

    if (this.gesture?.kind === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      this.camera.x -= (midX - this.gesture.midX) / this.camera.zoom;
      this.camera.y -= (midY - this.gesture.midY) / this.camera.zoom;
      if (this.gesture.dist > 0) this.zoomAt(midX, midY, dist / this.gesture.dist);
      this.gesture = { kind: 'pinch', dist, midX, midY };
      this.requestRender();
      return;
    }
    if (this.gesture?.kind === 'pan') {
      this.cameraTouched = true;
      this.camera.x -= (p.x - this.gesture.lastX) / this.camera.zoom;
      this.camera.y -= (p.y - this.gesture.lastY) / this.camera.zoom;
      this.gesture.lastX = p.x;
      this.gesture.lastY = p.y;
      this.requestRender();
      return;
    }

    const m = this.toMap(p.x, p.y);
    const cell = hexAt(m.x, m.y, this.map.columns, this.map.rows);
    this.setHovered(cell);

    if (!this.drawing) return;
    if (this.drawing.kind === 'pen') {
      const pts = this.drawing.points;
      const lx = pts[pts.length - 2];
      const ly = pts[pts.length - 1];
      // Skip points closer than ~2 screen pixels to keep stored strokes small.
      if (Math.hypot(m.x - lx, m.y - ly) * this.camera.zoom >= 2) pts.push(round2(m.x), round2(m.y));
      this.requestRender();
    } else if (this.drawing.kind === 'erase') {
      this.eraseAt(p.x, p.y);
    } else {
      // Walk the segment since the last event so fast drags don't skip hexes.
      const d = this.drawing;
      const steps = Math.ceil(Math.hypot(m.x - d.lastX, m.y - d.lastY) / (HEX_RADIUS * 0.4));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const c = hexAt(d.lastX + (m.x - d.lastX) * t, d.lastY + (m.y - d.lastY) * t, this.map.columns, this.map.rows);
        if (c !== d.last) this.applyBrush(c);
      }
      d.lastX = m.x;
      d.lastY = m.y;
    }
  }

  private onPointerUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.gesture) {
      if (this.pointers.size === 0) {
        this.gesture = null;
        this.updateCursor();
      }
      return;
    }
    if (!this.drawing) return;
    if (this.drawing.kind === 'pen' && this.drawing.points.length >= 2) {
      const pts = this.drawing.points;
      if (pts.length === 2) pts.push(pts[0] + 0.01, pts[1]); // a click leaves a dot
      this.map.strokes.push({ color: this.penColor, width: this.penWidth, points: pts });
      this.opChanged = true;
    }
    this.drawing = null;
    this.commitOp();
    this.requestRender();
  }

  private cancelDrawing() {
    if (!this.drawing) return;
    // Roll back anything the first finger already did before the second finger landed.
    if (this.opSnapshot && this.opChanged) this.map = JSON.parse(this.opSnapshot);
    this.opSnapshot = null;
    this.opChanged = false;
    this.drawing = null;
  }

  private setHovered(cell: number) {
    if (cell === this.hovered) return;
    this.hovered = cell;
    this.callbacks.onHover?.(cell);
    this.requestRender();
  }

  private updateCursor(grabbing = false) {
    let cursor = 'crosshair';
    if (grabbing) cursor = 'grabbing';
    else if (this.tool === 'pan' || this.spaceHeld) cursor = 'grab';
    else if (this.tool === 'select' || this.readOnly) cursor = 'default';
    else if (this.tool === 'note') cursor = 'text';
    this.canvas.style.cursor = cursor;
  }

  // ---------- Edit operations ----------

  private applyBrush(cell: number) {
    if (cell < 0 || (this.drawing?.kind !== 'paint' && this.drawing?.kind !== 'score')) return;
    this.drawing.last = cell;
    const { columns, rows } = this.map;
    for (const i of cellsInRadius(cell, this.brushRadius, columns, rows)) {
      if (this.tool === 'paint') {
        if (this.map.terrain[i] !== this.terrainIndex) {
          this.map.terrain[i] = this.terrainIndex;
          this.opChanged = true;
        }
      } else {
        const arr = this.scoreChannel === 'walk' ? this.map.walkScores : this.map.polygonScores;
        if (arr[i] !== this.scoreValue) {
          arr[i] = this.scoreValue;
          this.opChanged = true;
        }
      }
    }
    this.requestRender();
  }

  /** Paint-bucket on terrain: recolours the contiguous region sharing the clicked hex's terrain. */
  private floodFill(start: number) {
    if (start < 0) return;
    const { columns, rows, terrain } = this.map;
    const target = terrain[start];
    if (target === this.terrainIndex) return;
    const stack = [start];
    const seen = new Set<number>([start]);
    while (stack.length) {
      const i = stack.pop()!;
      terrain[i] = this.terrainIndex;
      for (const n of neighbours(i, columns, rows)) {
        if (!seen.has(n) && terrain[n] === target) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    this.opChanged = true;
  }

  private eraseAt(sx: number, sy: number) {
    const m = this.toMap(sx, sy);
    const threshold = 8 / this.camera.zoom;
    const before = this.map.strokes.length;
    this.map.strokes = this.map.strokes.filter((s) => !strokeNear(s.points, m.x, m.y, threshold + s.width / 2));
    const note = this.noteAt(sx, sy);
    if (note !== null) this.map.notes.splice(note, 1);
    if (this.map.strokes.length !== before || note !== null) {
      this.opChanged = true;
      this.requestRender();
    }
  }

  private noteAt(sx: number, sy: number): number | null {
    if (!this.view.showMarkup) return null;
    for (let i = this.noteBoxes.length - 1; i >= 0; i--) {
      const b = this.noteBoxes[i];
      if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return b.index;
    }
    return null;
  }

  // ---------- Rendering ----------

  private render() {
    const ctx = this.ctx;
    const { columns, rows, terrain, palette } = this.map;
    const z = this.camera.zoom;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, w, h);

    const values = this.view.fill === 'walk' ? this.map.walkScores : this.view.fill === 'polygon' ? this.map.polygonScores : null;
    let maxAbs = 0;
    if (values) for (const v of values) maxAbs = Math.max(maxAbs, Math.abs(v));

    const visible = (cx: number, cy: number) => {
      const s = this.toScreen(cx, cy);
      return s.x > -z * 2 && s.y > -z * 2 && s.x < w + z * 2 && s.y < h + z * 2;
    };

    // Hex fills + grid lines, drawn in map space.
    ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, -this.camera.x * z * this.dpr, -this.camera.y * z * this.dpr);
    ctx.lineJoin = 'round';
    const fills: string[] = new Array(columns * rows);
    for (let i = 0; i < columns * rows; i++) {
      const c = hexCenter(cellColumn(i, columns), cellRow(i, columns), rows);
      let color: string;
      if (values) color = heatColor(values[i], maxAbs);
      else color = terrain[i] === UNASSIGNED ? UNASSIGNED_COLOR : palette[terrain[i]]?.color ?? UNASSIGNED_COLOR;
      fills[i] = color;
      if (!visible(c.x, c.y)) continue;
      hexPath(ctx, c.x, c.y, 1);
      ctx.fillStyle = color;
      ctx.fill();
      if (this.view.showGrid) {
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = Math.min(0.06, 1 / z);
        ctx.stroke();
      }
    }

    // Brush preview, hover and selection outlines.
    const brushing = !this.readOnly && (this.tool === 'paint' || this.tool === 'score') && this.hovered >= 0;
    if (brushing) {
      for (const i of cellsInRadius(this.hovered, this.brushRadius, columns, rows)) {
        const c = hexCenter(cellColumn(i, columns), cellRow(i, columns), rows);
        hexPath(ctx, c.x, c.y, 0.92);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2 / z;
        ctx.stroke();
      }
    } else if (this.hovered >= 0) {
      const c = hexCenter(cellColumn(this.hovered, columns), cellRow(this.hovered, columns), rows);
      hexPath(ctx, c.x, c.y, 0.95);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5 / z;
      ctx.stroke();
    }
    if (this.selected >= 0) {
      const c = hexCenter(cellColumn(this.selected, columns), cellRow(this.selected, columns), rows);
      hexPath(ctx, c.x, c.y, 0.9);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3 / z;
      ctx.stroke();
    }

    // Markup strokes (map space so they stick to the hexes).
    if (this.view.showMarkup) {
      ctx.lineCap = 'round';
      for (const s of this.map.strokes) drawStroke(ctx, s.points, s.color, s.width);
      if (this.drawing?.kind === 'pen') drawStroke(ctx, this.drawing.points, this.penColor, this.penWidth);
    }

    // Text is drawn in screen space so it stays crisp and readable.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const radiusPx = HEX_RADIUS * z;
    const showLabels = this.view.labels !== 'none' && radiusPx >= 11;
    const showIndices = this.view.showIndices && radiusPx >= 14;
    if (showLabels || showIndices) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < columns * rows; i++) {
        const c = hexCenter(cellColumn(i, columns), cellRow(i, columns), rows);
        if (!visible(c.x, c.y)) continue;
        const s = this.toScreen(c.x, c.y);
        const ink = isLight(fills[i]) ? '#111' : '#f5f5f5';
        if (showIndices) {
          ctx.font = `500 ${Math.min(11, radiusPx * 0.28)}px Inter, sans-serif`;
          ctx.fillStyle = isLight(fills[i]) ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
          ctx.fillText(String(i), s.x, s.y - radiusPx * 0.58);
        }
        if (showLabels) {
          ctx.fillStyle = ink;
          const walk = this.map.walkScores[i];
          const poly = this.map.polygonScores[i];
          if (this.view.labels === 'both') {
            ctx.font = `700 ${Math.min(14, radiusPx * 0.34)}px Inter, sans-serif`;
            ctx.fillText(fmtScore(walk), s.x, s.y - radiusPx * 0.16);
            ctx.font = `500 ${Math.min(12, radiusPx * 0.28)}px Inter, sans-serif`;
            ctx.fillText(`P ${fmtScore(poly)}`, s.x, s.y + radiusPx * 0.3);
          } else {
            ctx.font = `700 ${Math.min(16, radiusPx * 0.42)}px Inter, sans-serif`;
            ctx.fillText(fmtScore(this.view.labels === 'walk' ? walk : poly), s.x, s.y + (showIndices ? radiusPx * 0.08 : 0));
          }
        }
      }
    }

    this.noteBoxes = [];
    if (this.view.showMarkup) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `500 ${NOTE_FONT_PX}px Inter, sans-serif`;
      this.map.notes.forEach((note, index) => this.drawNote(note, index));
    }
  }

  private drawNote(note: Note, index: number) {
    const ctx = this.ctx;
    const s = this.toScreen(note.x, note.y);
    const lines = (note.text || ' ').split('\n');
    const lineH = NOTE_FONT_PX + 3;
    const padX = 7;
    const padY = 5;
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxW = Math.min(280, textW) + padX * 2;
    const boxH = lines.length * lineH + padY * 2 - 3;
    const bx = s.x + 6;
    const by = s.y - boxH - 6;

    ctx.fillStyle = note.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(bx + 4, by + boxH);
    ctx.strokeStyle = note.color;
    ctx.stroke();

    ctx.fillStyle = 'rgba(13,17,23,0.92)';
    roundRect(ctx, bx, by, boxW, boxH, 5);
    ctx.fill();
    ctx.strokeStyle = note.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#f5f5f5';
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, boxW, boxH);
    ctx.clip();
    lines.forEach((line, i) => ctx.fillText(line, bx + padX, by + padY + i * lineH));
    ctx.restore();

    this.noteBoxes.push({ index, x: s.x - 6, y: by, w: bx + boxW - (s.x - 6), h: s.y + 6 - by });
  }
}

// ---------- Helpers ----------

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

function fmtScore(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '');
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number) {
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const x = cx + HEX_CORNERS[k].x * scale;
    const y = cy + HEX_CORNERS[k].y * scale;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawStroke(ctx: CanvasRenderingContext2D, pts: number[], color: string, width: number) {
  if (pts.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function strokeNear(pts: number[], x: number, y: number, threshold: number) {
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (distToSegment(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= threshold) return true;
  }
  return false;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Diverging colour for score heatmaps: red for negative, grey for zero, green for positive. */
function heatColor(v: number, maxAbs: number) {
  if (v === 0 || maxAbs === 0) return '#3a4150';
  const t = Math.min(1, Math.abs(v) / maxAbs);
  const [r, g, b] = v > 0 ? [34, 197, 94] : [239, 68, 68];
  const mix = (a: number, base: number) => Math.round(base + (a - base) * (0.35 + 0.65 * t));
  return `rgb(${mix(r, 58)},${mix(g, 65)},${mix(b, 80)})`;
}

function isLight(color: string) {
  let r = 0, g = 0, b = 0;
  if (color.startsWith('#') && color.length === 7) {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
  } else {
    const m = color.match(/\d+/g);
    if (m) [r, g, b] = m.map(Number);
  }
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}
