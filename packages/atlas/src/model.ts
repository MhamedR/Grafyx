/**
 * Snapshot model for grafyx/atlas.
 *
 * Extractors return this shape. New maps add relation names; they do not
 * invent a second graph model.
 */

export const WORKSPACE_DEPENDS = 'workspace-depends';
export const BUNDLE_INCLUDES = 'bundle-includes';
export const IMPORTS = 'imports';

/**
 * Relation name carried by a snapshot edge.
 *
 * v1 discovers `workspace-depends` and `bundle-includes`. Later extractors
 * may use new names in the same field.
 */
export type Relation = typeof WORKSPACE_DEPENDS | typeof BUNDLE_INCLUDES | (string & {});

export const LENSES = ['map', 'impact', 'upstream', 'cycles', 'order'] as const;

export type Lens = (typeof LENSES)[number];

export const LENS_QUESTION: Record<Lens, string> = {
  map: 'The workspace, in build order.',
  impact: 'What must be rebuilt if this package changes.',
  upstream: 'What this package stands on.',
  cycles: 'Where the order is impossible.',
  order: 'The schedule, and only the schedule.',
};

export const SOURCE_LENS_QUESTION: Record<Lens, string> = {
  map: 'The source, in dependency order.',
  impact: 'What must change if this part changes.',
  upstream: 'What this part stands on.',
  cycles: 'Where the order is impossible.',
  order: 'The schedule, and only the schedule.',
};

export const DIRECTION_LINE = 'A → B means A must exist before B. Rank 0 has no incoming edge.';

export const CYCLE_CLEAR = 'This workspace has a build order.';

export const READING_LINE = 'Reading workspace';

export const EMPTY_LINE = 'This root has no packages.';

/** Byte and line count for one source file the extractor read. */
export interface FileMeasure {
  /** Path relative to the node. Matches `files` when that list is present. */
  readonly path: string;
  readonly bytes: number;
  readonly lines: number;
}

/** How long the scan took, and how much source it read. */
export interface ScanStats {
  readonly durationMs: number;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly lineCount: number;
}

export interface PackageNode {
  readonly id: string;
  readonly version: string;
  readonly private: boolean;
  readonly path: string;
  readonly description: string;
  /** Source files inside a structure node. Package nodes omit this. */
  readonly files?: readonly string[];
  /** Present once the extractor has read the source. Ordered by `path`. */
  readonly measures?: readonly FileMeasure[];
}

/** A source node is a folder when it lists files, and a file otherwise. */
export type NodeShape = 'folder' | 'file';

export function nodeShape(kind: AtlasSnapshot['kind'], node: PackageNode): NodeShape | null {
  if (kind !== 'source') return null;
  const files = node.files ?? [];
  if (files.length === 0) return 'file';
  const ownName = node.path.split('/').pop() ?? node.id;
  if (files.length === 1 && (files[0] === node.id || files[0] === ownName)) return 'file';
  return 'folder';
}

export function nodeBytes(node: PackageNode): number {
  let bytes = 0;
  for (const measure of node.measures ?? []) bytes += measure.bytes;
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = 'KB';
  if (value >= 1024) {
    value /= 1024;
    unit = 'MB';
  }
  if (value >= 1024) {
    value /= 1024;
    unit = 'GB';
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

export function nodeCaption(node: PackageNode, shape: NodeShape | null): string {
  const weight = node.measures && node.measures.length > 0 ? formatBytes(nodeBytes(node)) : null;

  if (shape === 'folder' && node.files) {
    const count = node.files.length;
    const files = `${count} ${count === 1 ? 'file' : 'files'}`;
    return weight ? `${files} · ${weight}` : files;
  }
  if (shape === 'file' && node.version.length === 0) return weight ?? 'file';
  if (weight && node.version.length > 0) return `${node.version} · ${weight}`;
  return node.version;
}

export interface AtlasEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly relation: Relation;
}

export interface AtlasSnapshot {
  readonly nodes: readonly PackageNode[];
  readonly edges: readonly AtlasEdge[];
  readonly extractedAt: string;
  readonly root: string;
  /** `source` is a src tree. Omitted snapshots are workspace package maps. */
  readonly kind?: 'workspace' | 'source';
  /** Cost of the scan that produced this snapshot. */
  readonly scan?: ScanStats;
}

export interface AtlasBoot {
  readonly root: string;
  readonly snapshot: AtlasSnapshot | null;
  readonly error: string | null;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export function atlasEdgeId(relation: Relation, from: string, to: string): string {
  return `${relation}:${from}:${to}`;
}

export function isLens(value: string): value is Lens {
  return (LENSES as readonly string[]).includes(value);
}
