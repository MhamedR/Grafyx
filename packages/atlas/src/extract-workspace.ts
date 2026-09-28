/**
 * Workspace extractor.
 *
 * Parsing stays here, outside the reactive evaluators. The result is an
 * AtlasSnapshot a later file, CI, or multi-repo extractor can also return.
 */

import {access, readFile, readdir} from 'node:fs/promises';
import {existsSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {measureTree, scanFrom} from './measure.js';
import {
  BUNDLE_INCLUDES,
  WORKSPACE_DEPENDS,
  atlasEdgeId,
  type AtlasEdge,
  type AtlasSnapshot,
  type PackageNode,
  type Relation,
} from './model.js';

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const REEXPORT = /export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  description?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
}

interface DiscoveredPackage {
  readonly id: string;
  readonly version: string;
  readonly private: boolean;
  readonly path: string;
  readonly description: string;
  readonly directory: string;
  readonly dependencyNames: readonly string[];
}

/**
 * Scans one workspace root.
 *
 * An edge A → B means A must exist before B. `workspace-depends` comes from
 * package manifests. `bundle-includes` comes from source re-exports, because
 * the published package copies those modules into its build.
 */
export async function extractWorkspace(root: string): Promise<AtlasSnapshot> {
  const started = performance.now();
  const resolvedRoot = resolve(root);

  let manifest: PackageManifest;
  try {
    manifest = await readManifest(join(resolvedRoot, 'package.json'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read workspace root ${resolvedRoot}: ${message}`, {cause: error});
  }

  const directories = await workspaceDirectories(resolvedRoot, manifest);
  const discovered = await Promise.all(
    directories.map((directory) => readPackage(resolvedRoot, directory)),
  );
  const packages = discovered.filter((pkg): pkg is DiscoveredPackage => pkg !== null);

  packages.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const names = new Set(packages.map((pkg) => pkg.id));
  const edges = new Map<string, AtlasEdge>();
  const [bundled, measures] = await Promise.all([
    Promise.all(packages.map((pkg) => bundledPackages(pkg, packages))),
    Promise.all(packages.map((pkg) => measureTree(pkg.directory))),
  ]);
  const nodes: PackageNode[] = packages.map((pkg, index) => {
    const measured = measures[index] ?? [];
    return {
      id: pkg.id,
      version: pkg.version,
      private: pkg.private,
      path: pkg.path,
      description: pkg.description,
      ...(measured.length > 0 ? {measures: measured} : {}),
    };
  });

  packages.forEach((pkg, index) => {
    for (const dependency of pkg.dependencyNames) {
      if (!names.has(dependency) || dependency === pkg.id) continue;
      addEdge(edges, WORKSPACE_DEPENDS, dependency, pkg.id);
    }

    for (const dependency of bundled[index] ?? []) {
      addEdge(edges, BUNDLE_INCLUDES, dependency, pkg.id);
    }
  });

  return {
    nodes,
    edges: [...edges.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    extractedAt: new Date().toISOString(),
    root: resolvedRoot,
    scan: scanFrom(started, nodes),
  };
}

function addEdge(
  edges: Map<string, AtlasEdge>,
  relation: Relation,
  from: string,
  to: string,
): void {
  const id = atlasEdgeId(relation, from, to);
  if (!edges.has(id)) {
    edges.set(id, {id, from, to, relation});
  }
}

async function readPackage(root: string, directory: string): Promise<DiscoveredPackage | null> {
  let manifest: PackageManifest;
  try {
    manifest = await readManifest(join(directory, 'package.json'));
  } catch {
    return null;
  }

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) return null;

  const dependencyNames = [
    ...dependencyKeys(manifest.dependencies),
    ...dependencyKeys(manifest.devDependencies),
    ...dependencyKeys(manifest.peerDependencies),
    ...dependencyKeys(manifest.optionalDependencies),
  ];

  return {
    id: manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    private: manifest.private === true,
    path: toPosix(relative(root, directory)) || '.',
    description: typeof manifest.description === 'string' ? manifest.description : '',
    directory,
    dependencyNames,
  };
}

function dependencyKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];

  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name]) => name);
}

async function readManifest(file: string): Promise<PackageManifest> {
  const text = await readFile(file, 'utf8');
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file} is not a package manifest.`);
  }

  return parsed as PackageManifest;
}

async function workspaceDirectories(root: string, manifest: PackageManifest): Promise<string[]> {
  const patterns = workspacePatterns(manifest.workspaces);

  if (patterns.length === 0) {
    return [root];
  }

  const matches = await Promise.all(patterns.map((pattern) => matchPattern(root, pattern)));
  return [...new Set(matches.flat())];
}

function workspacePatterns(workspaces: unknown): string[] {
  if (typeof workspaces === 'string') return [workspaces];
  if (Array.isArray(workspaces)) {
    return workspaces.filter((pattern): pattern is string => typeof pattern === 'string');
  }
  if (typeof workspaces === 'object' && workspaces !== null && 'packages' in workspaces) {
    return workspacePatterns(workspaces.packages);
  }
  return [];
}

async function matchPattern(root: string, pattern: string): Promise<string[]> {
  const parts = pattern.split('/').filter((part) => part.length > 0);
  const directories = await parts.reduce(
    async (previous, part) => {
      const current = await previous;
      const expanded = await Promise.all(
        current.map(async (directory) => {
          if (part === '*') return childDirectories(directory);
          if (part === '**') {
            const nested = await descendantDirectories(directory);
            return [directory].concat(nested);
          }
          return [join(directory, part)];
        }),
      );
      return expanded.flat();
    },
    Promise.resolve([root]),
  );

  const existing = await Promise.all(
    directories.map(async (directory) => {
      try {
        await access(join(directory, 'package.json'));
        return directory;
      } catch {
        return null;
      }
    }),
  );

  return existing.filter((directory): directory is string => directory !== null);
}

async function childDirectories(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'),
    )
    .map((entry) => join(directory, entry.name));
}

async function descendantDirectories(directory: string): Promise<string[]> {
  const children = await childDirectories(directory);
  const nested = await Promise.all(children.map((child) => descendantDirectories(child)));
  return [...children, ...nested.flat()];
}

async function bundledPackages(
  pkg: DiscoveredPackage,
  packages: readonly DiscoveredPackage[],
): Promise<string[]> {
  const files = await sourceFiles(pkg.directory);
  const texts = await Promise.all(
    files.map(async (file) => ({file, text: await readFile(file, 'utf8')})),
  );
  const included = new Set<string>();

  for (const {file, text} of texts) {
    REEXPORT.lastIndex = 0;

    for (const match of text.matchAll(REEXPORT)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith('.')) continue;

      const resolved = resolveSpecifier(file, specifier);
      if (resolved === null) continue;

      const owner = packageAt(resolved, packages);
      if (owner !== null && owner !== pkg.id) included.add(owner);
    }
  }

  return [...included];
}

async function sourceFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') {
        return [];
      }
      if (entry.name.startsWith('.')) return [];

      const full = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) return [full];
      return [];
    }),
  );

  return nested.flat();
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
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

function packageAt(file: string, packages: readonly DiscoveredPackage[]): string | null {
  const sorted = [...packages].sort(
    (left, right) => right.directory.length - left.directory.length,
  );

  for (const pkg of sorted) {
    if (file === pkg.directory || file.startsWith(pkg.directory + sep)) return pkg.id;
  }

  return null;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}
