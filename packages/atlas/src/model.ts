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

export interface PackageNode {
  readonly id: string;
  readonly version: string;
  readonly private: boolean;
  readonly path: string;
  readonly description: string;
  /** Source files inside a structure node. Package nodes omit this. */
  readonly files?: readonly string[];
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

export function nodeCaption(node: PackageNode, shape: NodeShape | null): string {
  if (shape === 'folder' && node.files) {
    const count = node.files.length;
    return `${count} ${count === 1 ? 'file' : 'files'}`;
  }
  if (shape === 'file' && node.version.length === 0) return 'file';
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
