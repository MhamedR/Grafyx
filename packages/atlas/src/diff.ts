/**
 * Structural diff between two atlas snapshots.
 */

import type {AtlasEdge, AtlasSnapshot, PackageNode} from './model.js';

export interface NodeChange {
  readonly id: string;
  readonly before: PackageNode;
  readonly after: PackageNode;
}

export interface AtlasDiff {
  readonly addedNodes: readonly PackageNode[];
  readonly removedNodes: readonly PackageNode[];
  readonly changedNodes: readonly NodeChange[];
  readonly addedEdges: readonly AtlasEdge[];
  readonly removedEdges: readonly AtlasEdge[];
}

export function diffSnapshots(before: AtlasSnapshot, after: AtlasSnapshot): AtlasDiff {
  const previousNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const nextEdges = new Map(after.edges.map((edge) => [edge.id, edge]));

  const addedNodes: PackageNode[] = [];
  const removedNodes: PackageNode[] = [];
  const changedNodes: NodeChange[] = [];
  const addedEdges: AtlasEdge[] = [];
  const removedEdges: AtlasEdge[] = [];

  for (const node of after.nodes) {
    const previous = previousNodes.get(node.id);
    if (!previous) {
      addedNodes.push(node);
      continue;
    }
    if (!sameNode(previous, node)) {
      changedNodes.push({id: node.id, before: previous, after: node});
    }
  }

  for (const node of before.nodes) {
    if (!nextNodes.has(node.id)) removedNodes.push(node);
  }

  for (const edge of after.edges) {
    if (!previousEdges.has(edge.id)) addedEdges.push(edge);
  }

  for (const edge of before.edges) {
    if (!nextEdges.has(edge.id)) removedEdges.push(edge);
  }

  return {addedNodes, removedNodes, changedNodes, addedEdges, removedEdges};
}

function sameNode(before: PackageNode, after: PackageNode): boolean {
  return (
    before.version === after.version &&
    before.private === after.private &&
    before.path === after.path &&
    before.description === after.description &&
    sameFiles(before.files, after.files) &&
    sameMeasures(before.measures, after.measures)
  );
}

function sameMeasures(before: PackageNode['measures'], after: PackageNode['measures']): boolean {
  const left = before ?? [];
  const right = after ?? [];
  return (
    left.length === right.length &&
    left.every(
      (measure, index) =>
        measure.path === right[index]?.path &&
        measure.bytes === right[index]?.bytes &&
        measure.lines === right[index]?.lines,
    )
  );
}

function sameFiles(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): boolean {
  const left = before ?? [];
  const right = after ?? [];
  return left.length === right.length && left.every((file, index) => file === right[index]);
}
