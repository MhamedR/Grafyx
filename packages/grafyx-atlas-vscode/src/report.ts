/**
 * Text for the Grafyx Atlas output channel.
 * Numbers and order come from grafyx-atlas; this file only prints them.
 */

import {
  CYCLE_CLEAR,
  EMPTY_LINE,
  LENS_QUESTION,
  SOURCE_LENS_QUESTION,
  buildPackageGraph,
  cycles,
  downstream,
  formatBytes,
  order,
  structureStats,
  upstream,
  type AtlasSnapshot,
  type Lens,
} from 'grafyx-atlas';

export function lensQuestion(snapshot: AtlasSnapshot, lens: Lens): string {
  return snapshot.kind === 'source' ? SOURCE_LENS_QUESTION[lens] : LENS_QUESTION[lens];
}

export function reportImpact(snapshot: AtlasSnapshot, id: string): string {
  const reached = downstream(buildPackageGraph(snapshot), id);
  const question = lensQuestion(snapshot, 'impact');
  if (reached.length === 0) return `${id}\n${question}\n${id} reaches nothing else.`;
  return `${id}\n${question}\n${list(reached)}`;
}

export function reportUpstream(snapshot: AtlasSnapshot, id: string): string {
  const stoodOn = upstream(buildPackageGraph(snapshot), id);
  const question = lensQuestion(snapshot, 'upstream');
  if (stoodOn.length === 0) return `${id}\n${question}\n${id} stands on nothing else here.`;
  return `${id}\n${question}\n${list(stoodOn)}`;
}

function list(ids: readonly string[]): string {
  return ids.map((id) => `  ${id}`).join('\n');
}

export function reportCycles(snapshot: AtlasSnapshot): string {
  const found = cycles(buildPackageGraph(snapshot));
  if (found.length === 0) return CYCLE_CLEAR;
  const lines = [lensQuestion(snapshot, 'cycles')];
  for (const component of found) lines.push(component.join(' → '));
  return lines.join('\n');
}

export function reportOrder(snapshot: AtlasSnapshot): string {
  const result = order(buildPackageGraph(snapshot));
  if (result.kind === 'cycle') {
    const lines = [lensQuestion(snapshot, 'cycles')];
    for (const component of result.components) lines.push(component.join(' → '));
    return lines.join('\n');
  }
  const lines = [lensQuestion(snapshot, 'order')];
  result.ids.forEach((id, index) => {
    lines.push(`${index + 1}. ${id}`);
  });
  return lines.join('\n');
}

export function reportStats(snapshot: AtlasSnapshot): string {
  const stats = structureStats(snapshot);
  const lines: string[] = [];
  if (stats.scan) {
    lines.push(
      `${stats.scan.fileCount} files, ${formatBytes(stats.scan.byteCount)}, ${stats.scan.lineCount} lines`,
    );
  }
  lines.push('Largest files');
  for (const file of stats.largestFiles) lines.push(`${file.path}  ${formatBytes(file.bytes)}`);
  lines.push('Change reach');
  for (const item of stats.blast) lines.push(`${item.id}  ${item.reached}`);
  lines.push('Weight by part');
  for (const item of stats.weight) lines.push(`${item.id}  ${formatBytes(item.bytes)}`);
  lines.push('Direct coupling');
  for (const item of stats.coupling)
    lines.push(`${item.id}  in ${item.inDegree}  out ${item.outDegree}`);
  if (snapshot.nodes.length === 0) lines.push(EMPTY_LINE);
  return lines.join('\n');
}

export function reportFocus(snapshot: AtlasSnapshot): string {
  return [lensQuestion(snapshot, 'map'), ...snapshot.nodes.map((node) => node.id)].join('\n');
}
