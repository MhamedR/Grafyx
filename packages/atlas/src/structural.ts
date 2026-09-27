/**
 * Directed structure over a snapshot.
 *
 * Algorithms stay on the public grafyx graph. Relation names live in an
 * atlas map keyed by edge id, because GraphEdge only carries id, from, to,
 * and version.
 */

import {
  DirectedGraph,
  Node,
  getAncestors,
  getDescendants,
  hasCycle,
  hasPath,
  stronglyConnectedComponents,
  topologicalSort,
} from 'grafyx';
import type {AtlasSnapshot, PackageNode, Relation} from './model.js';

export interface PackageGraph {
  readonly graph: DirectedGraph<PackageNode>;
  readonly relations: ReadonlyMap<number, Relation>;
}

export interface Degrees {
  readonly inDegree: number;
  readonly outDegree: number;
}

export type BuildOrder =
  | {readonly kind: 'order'; readonly ids: readonly string[]}
  | {readonly kind: 'cycle'; readonly components: readonly (readonly string[])[]};

/**
 * Builds a directed graph whose edges point from what must exist to what
 * comes after.
 */
export function buildPackageGraph(snapshot: AtlasSnapshot): PackageGraph {
  const graph = new DirectedGraph<PackageNode>();
  const relations = new Map<number, Relation>();
  const nodes = [...snapshot.nodes].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  for (const node of nodes) {
    graph.addNode(new Node(node.id, node));
  }

  const edges = [...snapshot.edges].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  for (const edge of edges) {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    if (graph.hasEdge(edge.from, edge.to)) continue;

    graph.addEdge(edge.from, edge.to);
    const stored = graph.getEdge(edge.from, edge.to);
    if (stored) relations.set(stored.id, edge.relation);
  }

  return {graph, relations};
}

export function relationOf(
  structure: PackageGraph,
  from: string,
  to: string,
): Relation | undefined {
  if (!structure.graph.hasNode(from) || !structure.graph.hasNode(to)) return undefined;
  const edge = structure.graph.getEdge(from, to);
  if (!edge) return undefined;
  return structure.relations.get(edge.id);
}

/**
 * Build order. When the graph has a cycle, topologicalSort throws and the
 * strongly connected components are returned instead.
 */
export function order(structure: PackageGraph): BuildOrder {
  if (!hasCycle(structure.graph)) {
    return {
      kind: 'order',
      ids: topologicalSort(structure.graph).map((node) => node.id),
    };
  }

  try {
    topologicalSort(structure.graph);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('cycle')) throw error;
    return {kind: 'cycle', components: components(structure)};
  }

  return {kind: 'cycle', components: components(structure)};
}

export function components(structure: PackageGraph): string[][] {
  return stronglyConnectedComponents(structure.graph).map((component) =>
    component.map((node) => node.id),
  );
}

export function cycles(structure: PackageGraph): string[][] {
  return components(structure).filter((component) => {
    const only = component[0];
    if (component.length > 1) return true;
    return only !== undefined && structure.graph.getEdge(only, only) !== undefined;
  });
}

export function downstream(structure: PackageGraph, id: string): string[] {
  if (!structure.graph.hasNode(id)) return [];
  return getDescendants(structure.graph, id).map((node) => node.id);
}

export function upstream(structure: PackageGraph, id: string): string[] {
  if (!structure.graph.hasNode(id)) return [];
  return getAncestors(structure.graph, id).map((node) => node.id);
}

export function path(structure: PackageGraph, from: string, to: string): string[] | null {
  if (!structure.graph.hasNode(from) || !structure.graph.hasNode(to)) return null;
  if (!hasPath(structure.graph, from, to)) return null;
  if (from === to) return [from];

  const previous = new Map<string, string>();
  const queue = [from];
  const seen = new Set<string>([from]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    for (const next of structure.graph.getOutgoing(current)) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      previous.set(next.id, current);

      if (next.id === to) {
        const trail = [to];
        let cursor = to;

        while (cursor !== from) {
          const prior = previous.get(cursor);
          if (prior === undefined) return null;
          cursor = prior;
          trail.push(cursor);
        }

        trail.reverse();
        return trail;
      }

      queue.push(next.id);
    }
  }

  return null;
}

export function degrees(structure: PackageGraph, id: string): Degrees {
  return {
    inDegree: structure.graph.getInDegree(id),
    outDegree: structure.graph.getOutDegree(id),
  };
}
