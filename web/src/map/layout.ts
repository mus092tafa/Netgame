// Geometry for the map: automatic layout, zone rectangles, and line clipping.
import type { MapNode, Zone } from '../../../shared/protocol.ts';

export interface Pt {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CARD_W = 210;
export const DEFAULT_H = 150;
const COL = 430; // distance between a zone's column and the border column
const ROW = 210;
const KIND_ORDER = { laptop: 0, router: 1, dns: 2, server: 3, database: 4 } as const;

/**
 * Zones are laid out left→right. A machine in one zone goes in that zone's column;
 * a machine in two zones goes in the column between them (on the shared border).
 */
export function autoLayout(zones: Zone[], nodes: MapNode[]): Record<string, Pt> {
  const zIndex = new Map(zones.map((z, i) => [z.id, i]));
  const cols = new Map<number, MapNode[]>();
  for (const n of nodes) {
    const idx = n.ifaces.map((i) => zIndex.get(i.network) ?? 0).sort((a, b) => a - b);
    const col = idx.length === 0 ? 0 : idx.length === 1 ? idx[0] * 2 : idx[0] + idx[idx.length - 1];
    cols.set(col, [...(cols.get(col) ?? []), n]);
  }
  const pos: Record<string, Pt> = {};
  for (const [col, list] of cols) {
    list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));
    // Border machines are centered; zone columns are nudged so lines don't run perfectly flat.
    const nudge = col % 2 === 1 ? 0 : -ROW * 0.25;
    list.forEach((n, i) => {
      pos[n.id] = { x: col * COL, y: (i - (list.length - 1) / 2) * ROW + (list.length > 1 ? 0 : nudge) };
    });
  }
  return pos;
}

/** Rectangle of a zone: its own machines (padded), stretched to reach the centers of border machines. */
export function zoneRects(zones: Zone[], nodes: MapNode[], pos: Record<string, Pt>, sizes: Record<string, Size>): Record<string, Rect> {
  const PAD = 44;
  const out: Record<string, Rect> = {};
  for (const z of zones) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const members = nodes.filter((n) => n.ifaces.some((i) => i.network === z.id) && pos[n.id]);
    const own = members.filter((n) => n.ifaces.length === 1);
    const border = members.filter((n) => n.ifaces.length > 1);
    for (const n of own) {
      const p = pos[n.id], s = sizes[n.id] ?? { w: CARD_W, h: DEFAULT_H };
      minX = Math.min(minX, p.x - s.w / 2 - PAD);
      maxX = Math.max(maxX, p.x + s.w / 2 + PAD);
      minY = Math.min(minY, p.y - s.h / 2 - PAD - 18);
      maxY = Math.max(maxY, p.y + s.h / 2 + PAD);
    }
    for (const n of border) {
      const p = pos[n.id], s = sizes[n.id] ?? { w: CARD_W, h: DEFAULT_H };
      const hasOwn = own.length > 0;
      minX = Math.min(minX, hasOwn ? p.x : p.x - s.w / 2 - PAD);
      maxX = Math.max(maxX, hasOwn ? p.x : p.x + s.w / 2 + PAD);
      minY = Math.min(minY, p.y - s.h / 2 - PAD - 18);
      maxY = Math.max(maxY, p.y + s.h / 2 + PAD);
    }
    if (minX === Infinity) continue;
    out[z.id] = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return out;
}

/** Where a ray from the card center in direction d leaves the card rectangle (+ margin). */
export function exitPoint(c: Pt, d: Pt, s: Size, margin = 6): Pt {
  const hw = s.w / 2 + margin, hh = s.h / 2 + margin;
  const tx = d.x === 0 ? Infinity : hw / Math.abs(d.x);
  const ty = d.y === 0 ? Infinity : hh / Math.abs(d.y);
  const t = Math.min(tx, ty);
  return { x: c.x + d.x * t, y: c.y + d.y * t };
}

/** Segment between two cards, shifted sideways by `offset` (for parallel lines). */
export function segment(a: Pt, sa: Size, b: Pt, sb: Size, offset: number): { p1: Pt; p2: Pt; mid: Pt; n: Pt; d: Pt } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const d = { x: dx / len, y: dy / len };
  const n = { x: -d.y, y: d.x };
  const a2 = { x: a.x + n.x * offset, y: a.y + n.y * offset };
  const b2 = { x: b.x + n.x * offset, y: b.y + n.y * offset };
  const p1 = exitPoint(a2, d, sa);
  const p2 = exitPoint(b2, { x: -d.x, y: -d.y }, sb);
  return { p1, p2, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, n, d };
}

export function bounds(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w)), y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

export const zoneHue = (i: number) => [200, 160, 280, 30, 330][i % 5];
