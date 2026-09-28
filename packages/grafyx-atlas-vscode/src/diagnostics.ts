/**
 * Maps atlas cycles onto file-level warnings.
 * The extractor reports parts, not source positions, so each warning sits
 * on the first line of a file that belongs to that part.
 */

import {join, resolve} from 'node:path';
import {
  buildPackageGraph,
  cycles,
  LENS_QUESTION,
  SOURCE_LENS_QUESTION,
  type AtlasSnapshot,
  type PackageNode,
} from 'grafyx-atlas';

export interface AtlasFileDiagnostic {
  readonly file: string;
  readonly message: string;
}

export function cycleDiagnostics(snapshot: AtlasSnapshot): readonly AtlasFileDiagnostic[] {
  const found = cycles(buildPackageGraph(snapshot));
  const question = snapshot.kind === 'source' ? SOURCE_LENS_QUESTION.cycles : LENS_QUESTION.cycles;
  const diagnostics: AtlasFileDiagnostic[] = [];

  for (const component of found) {
    const message = `${question} ${component.join(' → ')}`;
    for (const id of component) {
      const node = snapshot.nodes.find((item) => item.id === id);
      if (!node) continue;
      diagnostics.push({file: fileForNode(snapshot, node), message});
    }
  }

  return diagnostics;
}

function fileForNode(snapshot: AtlasSnapshot, node: PackageNode): string {
  if (snapshot.kind !== 'source') {
    return resolve(
      snapshot.root,
      ...splitPosix(node.path === '.' ? '' : node.path),
      'package.json',
    );
  }

  const ownName = node.path.split('/').pop() ?? node.id;
  const files = node.files ?? [];
  const isFile =
    files.length === 0 || (files.length === 1 && (files[0] === node.id || files[0] === ownName));
  const base = splitPosix(node.path);
  if (isFile) return resolve(snapshot.root, ...base);

  const first = files[0];
  if (!first) return join(snapshot.root, ...base);
  return resolve(snapshot.root, ...base, ...splitPosix(first));
}

function splitPosix(value: string): string[] {
  return value.split('/').filter((part) => part.length > 0);
}
