/**
 * Source-structure extractor.
 *
 * A single project is drawn as its src tree: one node per top-level folder
 * or loose file, with import edges between those parts. Files stay on the
 * node so the tooltip can list them. Relative imports and tsconfig path
 * aliases both count. A package name such as `react` does not.
 */

import {readdir, readFile} from 'node:fs/promises';
import {existsSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {measureText, scanFrom} from './measure.js';
import {
  IMPORTS,
  atlasEdgeId,
  type AtlasEdge,
  type AtlasSnapshot,
  type FileMeasure,
  type PackageNode,
} from './model.js';

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const FROM_SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"`]{0,500}?\bfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

interface SourceFile {
  readonly absolute: string;
  readonly relativeToSource: string;
}

/**
 * Maps one project's source tree.
 *
 * An edge A → B means A must exist before B: the imported part points at the
 * part that imports it. Rank 0 is a part that imports nothing else in src.
 */
export async function extractSource(root: string): Promise<AtlasSnapshot> {
  const started = performance.now();
  const resolvedRoot = resolve(root);
  const sourceDirectory = await findSourceRoot(resolvedRoot);
  const files = sourceDirectory === null ? [] : await sourceFiles(sourceDirectory, sourceDirectory);

  const grouped = new Map<string, SourceFile[]>();
  for (const file of files) {
    const key = file.relativeToSource.split('/')[0] ?? file.relativeToSource;
    const group = grouped.get(key);
    if (group) group.push(file);
    else grouped.set(key, [file]);
  }

  const nodeOf = new Map<string, string>();
  for (const [id, members] of grouped) {
    for (const file of members) nodeOf.set(file.absolute, id);
  }

  const edges = new Map<string, AtlasEdge>();
  const aliases = await loadAliases(resolvedRoot);
  const texts = await Promise.all(
    files.map(async (file) => ({file, text: await readFile(file.absolute, 'utf8')})),
  );
  const measured = new Map<string, {bytes: number; lines: number}>();
  for (const {file, text} of texts) measured.set(file.absolute, measureText(text));

  const nodes: PackageNode[] = [...grouped.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([id, members]) => {
      const folder = members.some((file) => file.relativeToSource.includes('/'));
      const listed = members
        .map((file) =>
          folder ? file.relativeToSource.slice(id.length + 1) : file.relativeToSource,
        )
        .sort();

      return {
        id,
        version: '',
        private: false,
        path: toPosix(relative(resolvedRoot, join(sourceDirectory ?? resolvedRoot, id))),
        description: '',
        files: listed,
        measures: measuresOf(
          members,
          (file) => (folder ? file.relativeToSource.slice(id.length + 1) : file.relativeToSource),
          measured,
        ),
      };
    });

  for (const {file, text} of texts) {
    const importer = nodeOf.get(file.absolute);
    if (importer === undefined) continue;

    for (const resolved of resolveImports(file.absolute, text, aliases)) {
      const imported = nodeOf.get(resolved);
      if (imported === undefined || imported === importer) continue;
      const id = atlasEdgeId(IMPORTS, imported, importer);
      if (!edges.has(id)) {
        edges.set(id, {id, from: imported, to: importer, relation: IMPORTS});
      }
    }
  }

  return {
    nodes,
    edges: [...edges.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    extractedAt: new Date().toISOString(),
    root: resolvedRoot,
    kind: 'source',
    scan: scanFrom(started, nodes),
  };
}

/**
 * Opens one folder or file from a source map.
 *
 * A flat folder opens into its files. A nested folder opens one level down:
 * each child folder stays a node, and import edges connect those parts.
 * Files one import away from outside the folder stay visible as links.
 */
export async function extractSourceFocus(
  root: string,
  nodePath: string,
): Promise<AtlasSnapshot | null> {
  const started = performance.now();
  const resolvedRoot = resolve(root);
  const sourceDirectory = await findSourceRoot(resolvedRoot);
  if (sourceDirectory === null || nodePath.length === 0) return null;

  const files = await sourceFiles(sourceDirectory, sourceDirectory);
  const focus = files.filter((file) => {
    const fromRoot = toPosix(relative(resolvedRoot, file.absolute));
    return fromRoot === nodePath || fromRoot.startsWith(`${nodePath}/`);
  });
  if (focus.length === 0) return null;

  const aliases = await loadAliases(resolvedRoot);
  const texts = await Promise.all(
    files.map(async (file) => ({file, text: await readFile(file.absolute, 'utf8')})),
  );
  const importsOf = new Map<string, readonly string[]>();
  const measured = new Map<string, {bytes: number; lines: number}>();

  for (const {file, text} of texts) {
    importsOf.set(file.absolute, resolveImports(file.absolute, text, aliases));
    measured.set(file.absolute, measureText(text));
  }

  const focusPaths = new Set(focus.map((file) => file.absolute));
  const include = new Set(focusPaths);

  for (const file of focus) {
    for (const target of importsOf.get(file.absolute) ?? []) include.add(target);
  }

  for (const [importer, targets] of importsOf) {
    if (targets.some((target) => focusPaths.has(target))) include.add(importer);
  }

  const byAbsolute = new Map(files.map((file) => [file.absolute, file]));
  const visible: SourceFile[] = [];

  for (const absolute of include) {
    const known = byAbsolute.get(absolute);
    if (known) {
      visible.push(known);
      continue;
    }
    visible.push({
      absolute,
      relativeToSource: toPosix(relative(sourceDirectory, absolute)),
    });
  }

  const parts = focusParts(visible, nodePath, resolvedRoot, measured);
  const nodes: PackageNode[] = parts
    .map((part) => ({
      id: part.id,
      version: part.inside ? '' : 'link',
      private: false,
      path: part.path,
      description: part.inside ? '' : 'Outside this part.',
      ...(part.files ? {files: part.files} : {}),
      ...(part.measures.length > 0 ? {measures: part.measures} : {}),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const idOf = new Map<string, string>();
  for (const part of parts) {
    for (const absolute of part.absolutes) idOf.set(absolute, part.id);
  }

  const edges = new Map<string, AtlasEdge>();
  for (const [importer, targets] of importsOf) {
    const to = idOf.get(importer);
    if (to === undefined) continue;
    for (const target of targets) {
      const from = idOf.get(target);
      if (from === undefined || from === to) continue;
      const id = atlasEdgeId(IMPORTS, from, to);
      if (!edges.has(id)) edges.set(id, {id, from, to, relation: IMPORTS});
    }
  }

  return {
    nodes,
    edges: [...edges.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    extractedAt: new Date().toISOString(),
    root: resolvedRoot,
    kind: 'source',
    scan: scanFrom(started, nodes),
  };
}

interface FocusPart {
  readonly id: string;
  readonly path: string;
  readonly inside: boolean;
  readonly files?: readonly string[];
  readonly measures: readonly FileMeasure[];
  readonly absolutes: readonly string[];
}

/**
 * A flat folder opens into its files. A nested folder opens one level:
 * the files sitting in it, and a node for each child folder. Duplicate
 * names such as `page.tsx` stay inside their folder instead of becoming
 * a path-shaped id.
 */
function focusParts(
  visible: readonly SourceFile[],
  nodePath: string,
  resolvedRoot: string,
  measured: ReadonlyMap<string, {bytes: number; lines: number}>,
): FocusPart[] {
  const inside: SourceFile[] = [];
  const outside: SourceFile[] = [];

  for (const file of visible) {
    const fromRoot = toPosix(relative(resolvedRoot, file.absolute));
    if (fromRoot === nodePath || fromRoot.startsWith(`${nodePath}/`)) inside.push(file);
    else outside.push(file);
  }

  const nested = inside.some((file) => restUnder(file, nodePath, resolvedRoot).includes('/'));
  const parts: FocusPart[] = [];

  if (nested) {
    const groups = new Map<string, SourceFile[]>();
    for (const file of inside) {
      const key = restUnder(file, nodePath, resolvedRoot).split('/')[0] ?? file.relativeToSource;
      const group = groups.get(key);
      if (group) group.push(file);
      else groups.set(key, [file]);
    }

    for (const [id, members] of groups) {
      const folder = members.some((file) => restUnder(file, nodePath, resolvedRoot).includes('/'));
      const listed = folder
        ? members.map((file) => restUnder(file, nodePath, resolvedRoot).slice(id.length + 1)).sort()
        : undefined;
      parts.push({
        id,
        path: `${nodePath}/${id}`,
        inside: true,
        ...(listed ? {files: listed} : {}),
        measures: measuresOf(
          members,
          (file) =>
            folder
              ? restUnder(file, nodePath, resolvedRoot).slice(id.length + 1)
              : (file.relativeToSource.split('/').pop() ?? file.relativeToSource),
          measured,
        ),
        absolutes: members.map((file) => file.absolute),
      });
    }
  } else {
    for (const file of inside) {
      const base = file.relativeToSource.split('/').pop() ?? file.relativeToSource;
      parts.push({
        id: base,
        path: toPosix(relative(resolvedRoot, file.absolute)),
        inside: true,
        measures: [sized(base, file.absolute, measured)],
        absolutes: [file.absolute],
      });
    }
  }

  const taken = new Set(parts.map((part) => part.id));
  const outsideIds = fileIds(outside);

  for (const file of outside) {
    const base = outsideIds.get(file.absolute) ?? file.relativeToSource;
    const id = taken.has(base) ? file.relativeToSource : base;
    taken.add(id);
    parts.push({
      id,
      path: toPosix(relative(resolvedRoot, file.absolute)),
      inside: false,
      measures: [sized(id, file.absolute, measured)],
      absolutes: [file.absolute],
    });
  }

  return parts;
}

function measuresOf(
  members: readonly SourceFile[],
  pathOf: (file: SourceFile) => string,
  measured: ReadonlyMap<string, {bytes: number; lines: number}>,
): FileMeasure[] {
  return members
    .map((file) => sized(pathOf(file), file.absolute, measured))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function sized(
  path: string,
  absolute: string,
  measured: ReadonlyMap<string, {bytes: number; lines: number}>,
): FileMeasure {
  const size = measured.get(absolute) ?? {bytes: 0, lines: 0};
  return {path, bytes: size.bytes, lines: size.lines};
}

function restUnder(file: SourceFile, nodePath: string, resolvedRoot: string): string {
  const fromRoot = toPosix(relative(resolvedRoot, file.absolute));
  if (!fromRoot.startsWith(`${nodePath}/`)) return fromRoot;
  return fromRoot.slice(nodePath.length + 1);
}

function fileIds(files: readonly SourceFile[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const base = file.relativeToSource.split('/').pop() ?? file.relativeToSource;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }

  const ids = new Map<string, string>();
  for (const file of files) {
    const base = file.relativeToSource.split('/').pop() ?? file.relativeToSource;
    ids.set(file.absolute, (counts.get(base) ?? 0) > 1 ? file.relativeToSource : base);
  }
  return ids;
}

async function findSourceRoot(root: string): Promise<string | null> {
  const src = join(root, 'src');
  if ((await sourceFiles(src, src)).length > 0) return src;
  if ((await sourceFiles(root, root)).length > 0) return root;
  return null;
}

async function sourceFiles(directory: string, sourceRoot: string): Promise<SourceFile[]> {
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
      if (entry.isDirectory()) return sourceFiles(full, sourceRoot);
      if (!SOURCE_FILE.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
      return [{absolute: full, relativeToSource: toPosix(relative(sourceRoot, full))}];
    }),
  );

  return nested.flat();
}

interface PathAlias {
  readonly prefix: string;
  readonly suffix: string;
  readonly wildcard: boolean;
  readonly targets: readonly PathTarget[];
}

interface PathTarget {
  readonly prefix: string;
  readonly suffix: string;
  readonly wildcard: boolean;
}

function resolveImports(fromFile: string, text: string, aliases: readonly PathAlias[]): string[] {
  const resolved: string[] = [];

  for (const specifier of specifiers(text)) {
    const file = specifier.startsWith('.')
      ? resolveSpecifier(fromFile, specifier)
      : resolveAlias(specifier, aliases);
    if (file !== null) resolved.push(file);
  }

  return resolved;
}

async function loadAliases(root: string): Promise<PathAlias[]> {
  const [tsconfig, jsconfig] = await Promise.all([
    readConfig(join(root, 'tsconfig.json')),
    readConfig(join(root, 'jsconfig.json')),
  ]);
  const fromTypeScript = aliasesFrom(tsconfig, root);
  if (fromTypeScript.length > 0) return fromTypeScript;
  return aliasesFrom(jsconfig, root);
}

async function readConfig(path: string): Promise<unknown> {
  try {
    return parseJsonc(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function aliasesFrom(config: unknown, root: string): PathAlias[] {
  if (!isRecord(config)) return [];
  const options = config.compilerOptions;
  if (!isRecord(options) || !isRecord(options.paths)) return [];

  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
  const base = resolve(root, baseUrl);
  const aliases: PathAlias[] = [];

  for (const [pattern, targets] of Object.entries(options.paths)) {
    if (!Array.isArray(targets)) continue;
    const compiled = targets.filter((target): target is string => typeof target === 'string');
    if (compiled.length === 0) continue;
    aliases.push(compileAlias(pattern, compiled, base));
  }

  aliases.sort((left, right) => right.prefix.length - left.prefix.length);
  return aliases;
}

function compileAlias(pattern: string, targets: readonly string[], base: string): PathAlias {
  const star = pattern.indexOf('*');
  return {
    prefix: star === -1 ? pattern : pattern.slice(0, star),
    suffix: star === -1 ? '' : pattern.slice(star + 1),
    wildcard: star !== -1,
    targets: targets.map((target) => {
      const mark = target.indexOf('*');
      const head = mark === -1 ? target : target.slice(0, mark);
      return {
        prefix: resolve(base, head),
        suffix: mark === -1 ? '' : target.slice(mark + 1),
        wildcard: mark !== -1,
      };
    }),
  };
}

function resolveAlias(specifier: string, aliases: readonly PathAlias[]): string | null {
  for (const alias of aliases) {
    const captured = capture(specifier, alias);
    if (captured === null) continue;

    for (const target of alias.targets) {
      const path = target.wildcard
        ? `${join(target.prefix, captured)}${target.suffix}`
        : target.prefix;
      const file = resolveFile(path);
      if (file !== null) return file;
    }
  }

  return null;
}

function capture(specifier: string, alias: PathAlias): string | null {
  if (!alias.wildcard) return specifier === alias.prefix ? '' : null;
  if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return null;
  if (specifier.length < alias.prefix.length + alias.suffix.length) return null;
  return specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonc(text: string): unknown {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      out += text.slice(start, index);
      continue;
    }

    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }

    out += char ?? '';
    index += 1;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function specifiers(text: string): string[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = new Set<string>();

  for (const match of source.matchAll(FROM_SPECIFIER)) {
    const specifier = match[1];
    if (specifier) found.add(specifier);
  }

  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[1];
    if (specifier) found.add(specifier);
  }

  return [...found];
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  return resolveFile(resolve(dirname(fromFile), specifier));
}

function resolveFile(base: string): string | null {
  const candidates = [base];

  if (base.endsWith('.js')) {
    candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  } else if (base.endsWith('.mjs')) {
    candidates.push(`${base.slice(0, -4)}.ts`);
  }

  candidates.push(
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js'),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }

  return null;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}
