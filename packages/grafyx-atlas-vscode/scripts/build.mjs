/**
 * Bundles the extension around the built grafyx-atlas package and copies the
 * prebuilt map UI next to the bundle so startAtlasServer can serve it.
 */

import {spawnSync} from 'node:child_process';
import {cp, mkdir, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageDir));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args) {
  const result = spawnSync(npm, args, {cwd: repoRoot, stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['run', 'build']);
run(['run', 'build', '-w', 'grafyx-atlas']);

const dist = join(packageDir, 'dist');
await rm(dist, {recursive: true, force: true});

await esbuild.build({
  absWorkingDir: packageDir,
  entryPoints: [join(packageDir, 'src/extension.ts')],
  outfile: join(dist, 'extension.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['vscode', 'esbuild'],
  sourcemap: true,
  logLevel: 'warning',
});

const uiOut = join(dist, 'ui');
const uiSource = join(repoRoot, 'packages/atlas/dist/ui');
await mkdir(uiOut, {recursive: true});
await cp(join(uiSource, 'app.js'), join(uiOut, 'app.js'));
await cp(join(uiSource, 'atlas.css'), join(uiOut, 'atlas.css'));
