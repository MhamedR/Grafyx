/**
 * Turns VS Code resources into the absolute root grafyx-atlas scans.
 * `process.cwd()` is never the project root.
 */

import {existsSync, statSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve, win32} from 'node:path';
import type {AtlasSnapshot, PackageNode} from 'grafyx-atlas';

export interface OpenDocument {
  readonly fsPath: string;
  readonly isDirty: boolean;
  readonly isUntitled: boolean;
}

export interface WorkspaceContext {
  readonly folders: readonly string[];
  readonly dirtyPaths: readonly string[];
  readonly targetPath?: string;
  readonly activeDocument?: OpenDocument;
}

export type RootDecision =
  | {readonly kind: 'root'; readonly root: string}
  | {readonly kind: 'walk'; readonly start: string}
  | {readonly kind: 'choose'; readonly folders: readonly string[]}
  | {readonly kind: 'error'; readonly message: string};

export function decideRoot(input: {
  readonly configuredRoot: string;
  readonly folders: readonly string[];
  readonly targetPath?: string;
  readonly activePath?: string;
}): RootDecision {
  const configured = input.configuredRoot.trim();
  const anchor =
    containingFolder(input.folders, input.targetPath) ??
    containingFolder(input.folders, input.activePath);

  if (configured.length > 0) {
    if (isAbsolutePath(configured)) return {kind: 'root', root: resolve(configured)};
    const base = anchor ?? (input.folders.length === 1 ? input.folders[0] : undefined);
    if (base) return {kind: 'root', root: resolve(base, configured)};
    if (input.folders.length > 1) return {kind: 'choose', folders: input.folders};
    return {
      kind: 'error',
      message:
        'grafyxAtlas.root is relative. Open a workspace folder so it can be resolved. The scan does not use the process working directory.',
    };
  }

  if (anchor) return {kind: 'root', root: anchor};

  const outside = outsideStart(input.folders, input.targetPath, input.activePath);
  if (outside) return {kind: 'walk', start: outside};

  if (input.folders.length === 1) {
    const only = input.folders[0];
    if (only) return {kind: 'root', root: only};
  }
  if (input.folders.length > 1) return {kind: 'choose', folders: input.folders};
  return {kind: 'error', message: 'Open a folder to map a project.'};
}

/**
 * Walks up from a file or directory to the nearest package.json.
 * If none exists, the starting directory is the root extractProject receives.
 */
export function findProjectRoot(start: string): string {
  let current = resolve(start);
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch {
    current = dirname(current);
  }

  const origin = current;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return origin;
    current = parent;
  }
}

/**
 * Longest atlas node whose path contains `filePath`.
 * Workspace packages use `.` for the root package, which loses to a longer path.
 */
export function nodeForFile(snapshot: AtlasSnapshot, filePath: string): PackageNode | undefined {
  const matches = nodesForPath(snapshot, filePath);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The part under `filePath`, or every part inside that folder.
 * `packages` is not itself a part; it contains `packages/grafyx` and the rest.
 */
export function nodesForPath(snapshot: AtlasSnapshot, filePath: string): readonly PackageNode[] {
  const relative = relativeToRoot(snapshot.root, filePath);
  if (relative === undefined) return [];

  const located = snapshot.nodes.map((node) => ({node, path: nodePathOf(node)}));
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

/** Posix path of `filePath` relative to `root`, or undefined when it is outside. */
export function relativeToRoot(root: string, filePath: string): string | undefined {
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

/** Explorer passes a file URI. The editor context menu may pass a text editor. */
export function filePathFromCommandArgument(argument: unknown): string | undefined {
  if (!argument || typeof argument !== 'object') return undefined;

  if ('scheme' in argument && 'fsPath' in argument) {
    const uri = argument as {scheme?: unknown; fsPath?: unknown};
    if (uri.scheme === 'file' && typeof uri.fsPath === 'string') return uri.fsPath;
  }

  if ('document' in argument) {
    const document = (argument as {document?: {uri?: {scheme?: unknown; fsPath?: unknown}}})
      .document;
    if (document?.uri?.scheme === 'file' && typeof document.uri.fsPath === 'string') {
      return document.uri.fsPath;
    }
  }

  return undefined;
}

function outsideStart(
  folders: readonly string[],
  targetPath: string | undefined,
  activePath: string | undefined,
): string | undefined {
  if (targetPath && containingFolder(folders, targetPath) === undefined) return targetPath;
  if (activePath && containingFolder(folders, activePath) === undefined) return activePath;
  return undefined;
}

function containingFolder(
  folders: readonly string[],
  resource: string | undefined,
): string | undefined {
  if (!resource) return undefined;
  let best: string | undefined;
  let bestLength = -1;
  for (const folder of folders) {
    if (relativeToRoot(folder, resource) === undefined) continue;
    if (folder.length > bestLength) {
      best = folder;
      bestLength = folder.length;
    }
  }
  return best;
}

export function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function nodePathOf(node: PackageNode): string {
  return node.path === '.' ? '' : canonical(node.path);
}

function canonical(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '');
}

function hasDrive(value: string): boolean {
  return /^[A-Za-z]:/.test(value);
}
