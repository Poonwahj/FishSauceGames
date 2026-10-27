// Data model + hex geometry for the MineAware-NTS map editor.
//
// Layout matches the Command Room diorama grid in MineAwareVR-NTS (Terrain Grid System,
// flat-topped hexagons, _evenLayout = false): cellIndex = row * columns + column, row 0 is the
// bottom row, and odd columns sit half a hex lower than even ones. Keeping that identical means
// cellIndex here lines up 1:1 with HexScoreMapData.hexScores keys in Unity.

export const MAPS_COLLECTION = 'MineAwareNTS_Maps';
export const EDITORS_COLLECTION = 'MineAwareNTS_Editors';
export const MAX_DIMENSION = 100;
export const UNASSIGNED = -1;
export const UNASSIGNED_COLOR = '#2a3142';

export interface TerrainType {
  name: string;
  color: string;
}

export interface Stroke {
  color: string;
  width: number;
  points: number[]; // flat [x0, y0, x1, y1, ...] in map units
}

export interface Note {
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface HexMap {
  name: string;
  columns: number;
  rows: number;
  palette: TerrainType[];
  terrain: number[]; // palette index per cellIndex, or UNASSIGNED
  walkScores: number[];
  polygonScores: number[];
  strokes: Stroke[];
  notes: Note[];
}

export const DEFAULT_PALETTE: TerrainType[] = [
  { name: 'Grass', color: '#e6f59b' },
  { name: 'Bush', color: '#7aa63a' },
  { name: 'Dirt', color: '#f4b57a' },
  { name: 'Path', color: '#7a4100' },
  { name: 'Road', color: '#9aa0a6' },
  { name: 'Sand', color: '#f5ef7f' },
  { name: 'Hazard', color: '#d63031' },
  { name: 'Forest', color: '#26a65b' },
  { name: 'Water', color: '#3b82c4' },
];

export function clampDimension(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_DIMENSION, Math.max(1, Math.round(n)));
}

export function createMap(name: string, columns: number, rows: number): HexMap {
  columns = clampDimension(columns);
  rows = clampDimension(rows);
  const count = columns * rows;
  return {
    name,
    columns,
    rows,
    palette: DEFAULT_PALETTE.map((t) => ({ ...t })),
    terrain: new Array(count).fill(UNASSIGNED),
    walkScores: new Array(count).fill(0),
    polygonScores: new Array(count).fill(0),
    strokes: [],
    notes: [],
  };
}

/** Builds a HexMap from Firestore data, filling anything missing or malformed with defaults. */
export function sanitizeMap(data: any): HexMap {
  const columns = clampDimension(Number(data?.columns));
  const rows = clampDimension(Number(data?.rows));
  const count = columns * rows;
  const numArray = (arr: unknown, fallback: number) => {
    const out = new Array(count).fill(fallback);
    if (Array.isArray(arr)) {
      for (let i = 0; i < count && i < arr.length; i++) {
        const v = Number(arr[i]);
        if (Number.isFinite(v)) out[i] = v;
      }
    }
    return out;
  };
  const palette: TerrainType[] = Array.isArray(data?.palette)
    ? data.palette.map((t: any) => ({ name: String(t?.name ?? 'Terrain'), color: String(t?.color ?? '#888888') }))
    : DEFAULT_PALETTE.map((t) => ({ ...t }));
  const terrain = numArray(data?.terrain, UNASSIGNED).map((v) => (v >= 0 && v < palette.length ? Math.floor(v) : UNASSIGNED));
  return {
    name: String(data?.name ?? 'Untitled map'),
    columns,
    rows,
    palette,
    terrain,
    walkScores: numArray(data?.walkScores, 0),
    polygonScores: numArray(data?.polygonScores, 0),
    strokes: Array.isArray(data?.strokes)
      ? data.strokes
          .filter((s: any) => Array.isArray(s?.points))
          .map((s: any) => ({ color: String(s.color ?? '#ffffff'), width: Number(s.width) || 0.1, points: s.points.map(Number) }))
      : [],
    notes: Array.isArray(data?.notes)
      ? data.notes.map((n: any) => ({ x: Number(n?.x) || 0, y: Number(n?.y) || 0, text: String(n?.text ?? ''), color: String(n?.color ?? '#ffe066') }))
      : [],
  };
}

export function cloneMap(map: HexMap): HexMap {
  return structuredClone(map);
}

// ---------- Geometry (map units: hex radius = 1, y grows downward on screen) ----------

export const HEX_RADIUS = 1;
export const HEX_HEIGHT = Math.sqrt(3) * HEX_RADIUS;
export const COLUMN_STEP = 1.5 * HEX_RADIUS;

export function cellIndex(column: number, row: number, columns: number): number {
  return row * columns + column;
}

export function cellColumn(index: number, columns: number): number {
  return index % columns;
}

export function cellRow(index: number, columns: number): number {
  return Math.floor(index / columns);
}

export function mapSize(columns: number, rows: number): { width: number; height: number } {
  return {
    width: COLUMN_STEP * (columns - 1) + 2 * HEX_RADIUS,
    height: HEX_HEIGHT * rows + (columns > 1 ? HEX_HEIGHT / 2 : 0),
  };
}

export function hexCenter(column: number, row: number, rows: number): { x: number; y: number } {
  const screenRow = rows - 1 - row; // row 0 drawn at the bottom, like Unity
  return {
    x: HEX_RADIUS + column * COLUMN_STEP,
    y: HEX_HEIGHT / 2 + screenRow * HEX_HEIGHT + (column % 2 === 1 ? HEX_HEIGHT / 2 : 0),
  };
}

/** Corner offsets of a flat-topped hex, starting at the right-hand corner. */
export const HEX_CORNERS: { x: number; y: number }[] = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i;
  return { x: Math.cos(a) * HEX_RADIUS, y: Math.sin(a) * HEX_RADIUS };
});

function insideHex(dx: number, dy: number): boolean {
  dx = Math.abs(dx);
  dy = Math.abs(dy);
  return dx <= HEX_RADIUS && dy <= HEX_HEIGHT / 2 && Math.sqrt(3) * dx + dy <= Math.sqrt(3) * HEX_RADIUS;
}

/** Returns the cellIndex under a map-space point, or -1. */
export function hexAt(x: number, y: number, columns: number, rows: number): number {
  const approxCol = Math.round((x - HEX_RADIUS) / COLUMN_STEP);
  let best = -1;
  let bestDist = Infinity;
  for (let c = approxCol - 1; c <= approxCol + 1; c++) {
    if (c < 0 || c >= columns) continue;
    const offset = c % 2 === 1 ? HEX_HEIGHT / 2 : 0;
    const approxScreenRow = Math.round((y - HEX_HEIGHT / 2 - offset) / HEX_HEIGHT);
    for (let sr = approxScreenRow - 1; sr <= approxScreenRow + 1; sr++) {
      const r = rows - 1 - sr;
      if (r < 0 || r >= rows) continue;
      const center = hexCenter(c, r, rows);
      const d = (center.x - x) ** 2 + (center.y - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = cellIndex(c, r, columns);
      }
    }
  }
  if (best < 0) return -1;
  const center = hexCenter(cellColumn(best, columns), cellRow(best, columns), rows);
  return insideHex(x - center.x, y - center.y) ? best : -1;
}

// Cube coordinates for distance / neighbour maths. Uses the on-screen row (top = 0) so the
// "odd columns shoved down" layout is redblobgames' odd-q offset.
function toCube(column: number, row: number, rows: number): { q: number; r: number } {
  const screenRow = rows - 1 - row;
  return { q: column, r: screenRow - (column - (column & 1)) / 2 };
}

export function hexDistance(a: number, b: number, columns: number, rows: number): number {
  const ca = toCube(cellColumn(a, columns), cellRow(a, columns), rows);
  const cb = toCube(cellColumn(b, columns), cellRow(b, columns), rows);
  const dq = ca.q - cb.q;
  const dr = ca.r - cb.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** All cells within `radius` hex steps of `center` (radius 0 = just the centre). */
export function cellsInRadius(center: number, radius: number, columns: number, rows: number): number[] {
  const col = cellColumn(center, columns);
  const row = cellRow(center, columns);
  const out: number[] = [];
  for (let c = col - radius; c <= col + radius; c++) {
    if (c < 0 || c >= columns) continue;
    for (let r = row - radius - 1; r <= row + radius + 1; r++) {
      if (r < 0 || r >= rows) continue;
      const idx = cellIndex(c, r, columns);
      if (hexDistance(center, idx, columns, rows) <= radius) out.push(idx);
    }
  }
  return out;
}

export function neighbours(index: number, columns: number, rows: number): number[] {
  return cellsInRadius(index, 1, columns, rows).filter((i) => i !== index);
}

// ---------- Edits that touch more than one field ----------

/** Resizes the grid, keeping each hex's data at the same (column, row) and markup over the same hexes. */
export function resizeMap(map: HexMap, columns: number, rows: number): HexMap {
  columns = clampDimension(columns);
  rows = clampDimension(rows);
  const next = createMap(map.name, columns, rows);
  next.palette = map.palette.map((t) => ({ ...t }));
  for (let r = 0; r < Math.min(rows, map.rows); r++) {
    for (let c = 0; c < Math.min(columns, map.columns); c++) {
      const from = cellIndex(c, r, map.columns);
      const to = cellIndex(c, r, columns);
      next.terrain[to] = map.terrain[from];
      next.walkScores[to] = map.walkScores[from];
      next.polygonScores[to] = map.polygonScores[from];
    }
  }
  // Row 0 is at the bottom, so adding rows pushes existing hexes down the screen.
  const dy = (rows - map.rows) * HEX_HEIGHT;
  next.strokes = map.strokes.map((s) => ({ ...s, points: s.points.map((v, i) => (i % 2 === 1 ? v + dy : v)) }));
  next.notes = map.notes.map((n) => ({ ...n, y: n.y + dy }));
  return next;
}

/** Removes a terrain type; hexes using it become unassigned and later indices shift down. */
export function removeTerrain(map: HexMap, paletteIndex: number): void {
  map.palette.splice(paletteIndex, 1);
  for (let i = 0; i < map.terrain.length; i++) {
    const t = map.terrain[i];
    if (t === paletteIndex) map.terrain[i] = UNASSIGNED;
    else if (t > paletteIndex) map.terrain[i] = t - 1;
  }
}

/** Fields written to Firestore (everything except metadata like revision/timestamps). */
export function toFirestoreFields(map: HexMap) {
  return {
    name: map.name,
    columns: map.columns,
    rows: map.rows,
    palette: map.palette,
    terrain: map.terrain,
    walkScores: map.walkScores,
    polygonScores: map.polygonScores,
    strokes: map.strokes,
    notes: map.notes,
  };
}
