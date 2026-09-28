/**
 * Byte and line counts for source the extractors already read.
 */

import {readdir, readFile} from 'node:fs/promises';
import {join, relative, sep} from 'node:path';
import type {FileMeasure, PackageNode, ScanStats} from './model.js';

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;

export function measureText(text: string): {readonly bytes: number; readonly lines: number} {
  const bytes = Buffer.byteLength(text);
  if (text.length === 0) return {bytes, lines: 0};
  const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  return {bytes, lines};
}

export function scanFrom(started: number, nodes: readonly PackageNode[]): ScanStats {
  let fileCount = 0;
  let byteCount = 0;
  let lineCount = 0;

  for (const node of nodes) {
    for (const measure of node.measures ?? []) {
      fileCount += 1;
      byteCount += measure.bytes;
      lineCount += measure.lines;
    }
  }

  return {
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    fileCount,
    byteCount,
    lineCount,
  };
}

/**
 * Reads source under one directory and returns one measure per file.
 *
 * Paths are relative to `directory`. `node_modules`, `dist`, `coverage`,
 * and dot-folders are skipped, matching the source map.
 */
export async function measureTree(directory: string): Promise<FileMeasure[]> {
  const files = await walk(directory, directory);
  const measured = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(file.absolute, 'utf8');
      const size = measureText(text);
      return {path: file.relative, bytes: size.bytes, lines: size.lines};
    }),
  );

  measured.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return measured;
}

async function walk(
  directory: string,
  root: string,
): Promise<Array<{readonly absolute: string; readonly relative: string}>> {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'coverage' ||
        entry.name.startsWith('.')
      ) {
        return [];
      }

      const full = join(directory, entry.name);
      if (entry.isDirectory()) return walk(full, root);
      if (!SOURCE_FILE.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
      return [{absolute: full, relative: toPosix(relative(root, full))}];
    }),
  );

  return nested.flat();
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}
