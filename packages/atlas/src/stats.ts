/**
 * Charts for one snapshot: where the bytes sit, and how far a change reaches.
 *
 * The numbers come from file measures on the nodes and from the same
 * directed graph the lenses use. Nothing here reads the filesystem.
 */

import type {AtlasSnapshot, ScanStats} from './model.js';
import {buildPackageGraph, degrees, downstream} from './structural.js';

const CHART_LIMIT = 8;

export interface LargestFile {
  readonly nodeId: string;
  readonly path: string;
  readonly bytes: number;
  readonly lines: number;
}

export interface PartWeight {
  readonly id: string;
  readonly bytes: number;
  readonly lines: number;
  readonly files: number;
}

export interface BlastRadius {
  readonly id: string;
  readonly reached: number;
}

export interface Coupling {
  readonly id: string;
  readonly inDegree: number;
  readonly outDegree: number;
}

export interface StructureStats {
  readonly largestFiles: readonly LargestFile[];
  readonly weight: readonly PartWeight[];
  readonly blast: readonly BlastRadius[];
  readonly coupling: readonly Coupling[];
  readonly scan: ScanStats | null;
  readonly totals: {
    readonly bytes: number;
    readonly lines: number;
    readonly files: number;
    readonly nodes: number;
    readonly edges: number;
  };
}

/**
 * Ranks the picture by size, reach, and direct coupling.
 *
 * Lists stay short enough to draw. Ties break on the label, so the same
 * snapshot always produces the same chart.
 */
export function structureStats(snapshot: AtlasSnapshot): StructureStats {
  const structure = buildPackageGraph(snapshot);
  const largest: LargestFile[] = [];
  const weight: PartWeight[] = [];
  let bytes = 0;
  let lines = 0;
  let files = 0;

  for (const node of snapshot.nodes) {
    const measures = node.measures ?? [];
    let nodeBytes = 0;
    let nodeLines = 0;

    for (const measure of measures) {
      nodeBytes += measure.bytes;
      nodeLines += measure.lines;
      files += 1;
      largest.push({
        nodeId: node.id,
        path: fileLabel(node.id, measure.path),
        bytes: measure.bytes,
        lines: measure.lines,
      });
    }

    bytes += nodeBytes;
    lines += nodeLines;
    if (nodeBytes > 0) {
      weight.push({id: node.id, bytes: nodeBytes, lines: nodeLines, files: measures.length});
    }
  }

  largest.sort(byBytesThenPath);
  weight.sort((left, right) => right.bytes - left.bytes || compareText(left.id, right.id));

  const blast = snapshot.nodes
    .map((node) => ({id: node.id, reached: downstream(structure, node.id).length}))
    .filter((item) => item.reached > 0)
    .sort((left, right) => right.reached - left.reached || compareText(left.id, right.id));

  const coupling = snapshot.nodes
    .map((node) => {
      const count = degrees(structure, node.id);
      return {id: node.id, inDegree: count.inDegree, outDegree: count.outDegree};
    })
    .filter((item) => item.inDegree + item.outDegree > 0)
    .sort(
      (left, right) =>
        right.inDegree + right.outDegree - (left.inDegree + left.outDegree) ||
        compareText(left.id, right.id),
    );

  return {
    largestFiles: largest.slice(0, CHART_LIMIT),
    weight: weight.slice(0, CHART_LIMIT),
    blast: blast.slice(0, CHART_LIMIT),
    coupling: coupling.slice(0, CHART_LIMIT),
    scan: snapshot.scan ?? null,
    totals: {
      bytes,
      lines,
      files,
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
    },
  };
}

function fileLabel(nodeId: string, path: string): string {
  if (path === nodeId || path.startsWith(`${nodeId}/`)) return path;
  return `${nodeId}/${path}`;
}

function byBytesThenPath(left: LargestFile, right: LargestFile): number {
  return right.bytes - left.bytes || compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
