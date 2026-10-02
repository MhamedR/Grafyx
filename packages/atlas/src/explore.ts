/**
 * Neighborhood, search, and presentation for the map.
 *
 * The session still owns lenses and layout. This module only answers
 * questions the picture asks while a developer explores: what is next to
 * this node, what the query matches, and how a node should read.
 */

import type {AtlasEdge, AtlasSnapshot, PackageNode} from './model.js';

export const FOCUS_MODES = ['full', 'one', 'two', 'dependencies', 'dependents'] as const;

export type FocusMode = (typeof FOCUS_MODES)[number];

export const FOCUS_LABEL: Record<FocusMode, string> = {
  full: 'Full graph',
  one: 'One hop',
  two: 'Two hops',
  dependencies: 'Dependencies',
  dependents: 'Dependents',
};

export type NodeRole =
  | 'default'
  | 'selected'
  | 'dependency'
  | 'dependent'
  | 'related'
  | 'dimmed'
  | 'filtered'
  | 'hidden';

export type EdgeFlow = 'plain' | 'dependency' | 'dependent' | 'related' | 'quiet';

export interface DirectRelations {
  /** Nodes that must exist before `id`. Incoming edges. */
  readonly dependencies: readonly string[];
  /** Nodes that need `id` first. Outgoing edges. */
  readonly dependents: readonly string[];
  readonly dependencyEdges: readonly string[];
  readonly dependentEdges: readonly string[];
}

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  readonly field: 'name' | 'path' | 'file' | 'description';
  readonly detail: string;
}

const EMPTY_RELATIONS: DirectRelations = {
  dependencies: [],
  dependents: [],
  dependencyEdges: [],
  dependentEdges: [],
};

export function directRelations(edges: readonly AtlasEdge[], id: string): DirectRelations {
  const dependencies: string[] = [];
  const dependents: string[] = [];
  const dependencyEdges: string[] = [];
  const dependentEdges: string[] = [];
  const seenIn = new Set<string>();
  const seenOut = new Set<string>();

  for (const edge of edges) {
    if (edge.to === id) {
      dependencyEdges.push(edge.id);
      if (!seenIn.has(edge.from)) {
        seenIn.add(edge.from);
        dependencies.push(edge.from);
      }
    } else if (edge.from === id) {
      dependentEdges.push(edge.id);
      if (!seenOut.has(edge.to)) {
        seenOut.add(edge.to);
        dependents.push(edge.to);
      }
    }
  }

  return {dependencies, dependents, dependencyEdges, dependentEdges};
}

/**
 * Nodes kept on screen for a focus mode.
 * `null` means the full graph stays visible.
 */
export function visibleIds(
  snapshot: AtlasSnapshot,
  selectedId: string | null,
  mode: FocusMode,
): ReadonlySet<string> | null {
  if (mode === 'full' || selectedId === null) return null;
  if (!snapshot.nodes.some((node) => node.id === selectedId)) return null;

  const direction = mode === 'dependencies' ? 'in' : mode === 'dependents' ? 'out' : 'both';
  const depth = mode === 'one' ? 1 : mode === 'two' ? 2 : Number.POSITIVE_INFINITY;
  return walk(snapshot.edges, selectedId, direction, depth);
}

export function matchesQuery(node: PackageNode, query: string): boolean {
  const filter = query.trim().toLowerCase();
  if (filter.length === 0) return true;
  if (node.id.toLowerCase().includes(filter)) return true;
  if (node.path.toLowerCase().includes(filter)) return true;
  if (node.description.toLowerCase().includes(filter)) return true;
  return (node.files ?? []).some((file) => file.toLowerCase().includes(filter));
}

export function searchNodes(
  nodes: readonly PackageNode[],
  query: string,
  limit = 20,
): readonly SearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const node of nodes) {
    let best: SearchHit | null = null;
    const consider = (field: SearchHit['field'], text: string, detail: string): void => {
      const weight = field === 'name' ? 1 : field === 'path' ? 0.92 : field === 'file' ? 0.84 : 0.7;
      const score = Math.round(scoreText(trimmed, text) * weight);
      if (score <= 0) return;
      if (!best || score > best.score) best = {id: node.id, score, field, detail};
    };

    consider('name', node.id, node.path);
    if (node.path.length > 0) consider('path', node.path, node.path);
    if (node.description.length > 0) {
      consider(
        'description',
        node.description,
        node.path.length > 0 ? node.path : node.description,
      );
    }
    for (const file of node.files ?? []) {
      const detail = node.path.length > 0 ? `${node.path}/${file}` : file;
      consider('file', file, detail);
    }
    if (best) hits.push(best);
  }

  hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return hits.slice(0, limit);
}

/**
 * The single atlas node that contains `filePath`.
 * A tie returns nothing so the picture does not guess.
 */
export function locateByPath(snapshot: AtlasSnapshot, filePath: string): PackageNode | undefined {
  const relative = pathWithinRoot(snapshot.root, filePath);
  if (relative === undefined) return undefined;
  const matches = nodesForRelative(snapshot.nodes, relative);
  return matches.length === 1 ? matches[0] : undefined;
}

export function presentNode(input: {
  readonly selected: boolean;
  readonly dependency: boolean;
  readonly dependent: boolean;
  readonly emphasized: boolean;
  readonly lensScopes: boolean;
  readonly filtered: boolean;
  readonly hidden: boolean;
  readonly hasSelection: boolean;
}): NodeRole {
  if (input.hidden) return 'hidden';
  if (input.selected) return 'selected';
  if (input.filtered) return 'filtered';
  if (input.dependency) return 'dependency';
  if (input.dependent) return 'dependent';
  if (input.lensScopes && input.emphasized) return 'related';
  if (input.lensScopes || input.hasSelection) return 'dimmed';
  return 'default';
}

export function presentEdge(input: {
  readonly dependency: boolean;
  readonly dependent: boolean;
  readonly emphasized: boolean;
  readonly lensScopes: boolean;
  readonly hasSelection: boolean;
  readonly orderLens: boolean;
  readonly hidden: boolean;
}): EdgeFlow {
  if (input.hidden) return 'quiet';
  if (input.dependency) return 'dependency';
  if (input.dependent) return 'dependent';
  if (input.lensScopes && input.emphasized) return 'related';
  if (input.lensScopes || input.hasSelection || input.orderLens) return 'quiet';
  return 'plain';
}

export function roleLabel(role: NodeRole): string {
  if (role === 'default') return 'node';
  if (role === 'dependent') return 'required by';
  if (role === 'dependency') return 'depends on this selection';
  return role;
}

export {EMPTY_RELATIONS};

function walk(
  edges: readonly AtlasEdge[],
  start: string,
  direction: 'in' | 'out' | 'both',
  depth: number,
): Set<string> {
  const seen = new Set<string>([start]);
  let frontier = [start];

  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of edges) {
        const linked =
          (direction === 'in' || direction === 'both') && edge.to === current
            ? edge.from
            : (direction === 'out' || direction === 'both') && edge.from === current
              ? edge.to
              : null;
        if (linked === null || seen.has(linked)) continue;
        seen.add(linked);
        next.push(linked);
      }
    }
    frontier = next;
  }

  return seen;
}

function scoreText(query: string, text: string): number {
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  if (hay.length === 0) return 0;
  if (hay === needle) return 1000;
  if (hay.startsWith(needle)) return 860;
  const at = hay.indexOf(needle);
  if (at >= 0) return 700 - Math.min(at, 200);

  let matched = 0;
  let gaps = 0;
  let previous = -1;
  for (let index = 0; index < hay.length && matched < needle.length; index += 1) {
    if (hay[index] !== needle[matched]) continue;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    matched += 1;
  }
  if (matched < needle.length) return 0;
  return Math.max(1, 420 - gaps * 6);
}

function pathWithinRoot(root: string, filePath: string): string | undefined {
  const normalizedRoot = canonical(root);
  const normalizedFile = canonical(filePath);
  const windows = hasDrive(normalizedRoot) || hasDrive(normalizedFile);
  const rootKey = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const fileKey = windows ? normalizedFile.toLowerCase() : normalizedFile;
  if (fileKey === rootKey) return '';
  const prefix = `${rootKey}/`;
  if (!fileKey.startsWith(prefix)) return undefined;
  return normalizedFile.slice(normalizedRoot.length + 1);
}

function nodesForRelative(nodes: readonly PackageNode[], relative: string): readonly PackageNode[] {
  const located = nodes.map((node) => ({
    node,
    path: node.path === '.' ? '' : canonical(node.path),
  }));
  const containing = located.filter(
    (item) =>
      item.path.length > 0 && (relative === item.path || relative.startsWith(`${item.path}/`)),
  );
  if (containing.length > 0) {
    const best = Math.max(...containing.map((item) => item.path.length));
    return containing.filter((item) => item.path.length === best).map((item) => item.node);
  }

  const children = located.filter(
    (item) =>
      item.path.length > 0 && (relative.length === 0 || item.path.startsWith(`${relative}/`)),
  );
  if (children.length > 0) return children.map((item) => item.node);

  const root = located.find((item) => item.path.length === 0);
  return root ? [root.node] : [];
}

function canonical(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '');
}

function hasDrive(value: string): boolean {
  return /^[A-Za-z]:/.test(value);
}
