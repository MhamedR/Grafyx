#!/usr/bin/env node
/**
 * CLI for grafyx/atlas.
 *
 * From a clone, the default root is this repository and the UI is bundled on
 * start. From the published package, the default root is the working
 * directory and the UI ships prebuilt beside this file. The page receives one
 * snapshot; the browser session is the only picture state after that.
 */

import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {access} from 'node:fs/promises';
import {platform} from 'node:os';
import {join, resolve} from 'node:path';
import {startAtlasMcpServer} from './mcp.js';
import {atlasServerDirectory, startAtlasServer} from './server-app.js';

const here = atlasServerDirectory();
const repoRoot = resolve(here, '../../..');
const packaged = existsSync(join(here, 'ui', 'app.js'));

const USAGE = `Usage: grafyx-atlas [--root <path>] [--port <number>] [--no-open]
       grafyx-atlas --mcp [--root <path>]

  --root <path>    Project to map. Defaults to the current directory.
  --port <number>  Port on 127.0.0.1. Defaults to PORT, then 4318.
  --no-open        Do not open a browser.
  --mcp            Speak MCP on stdio instead of serving the map.`;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const root = resolve(readOption('--root') ?? (packaged ? process.cwd() : repoRoot));

  if (process.argv.includes('--mcp')) {
    startAtlasMcpServer({root});
    return;
  }

  const port = Number(readOption('--port') ?? process.env.PORT ?? 4318);

  if (!packaged) {
    try {
      await access(join(repoRoot, 'packages/grafyx/dist/grafyx/index.js'));
    } catch {
      console.error('Build grafyx before starting atlas: npm run build');
      process.exit(1);
    }
  }

  try {
    const running = await startAtlasServer({root, port});
    console.log(`grafyx/atlas  ${running.url}`);
    console.log(running.root);
    openBrowser(running.url);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function openBrowser(url: string): void {
  if (process.env.CI === 'true' || process.argv.includes('--no-open')) return;

  const system = platform();
  const command = system === 'darwin' ? 'open' : system === 'win32' ? 'cmd' : 'xdg-open';
  const args = system === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {detached: true, stdio: 'ignore'});
  child.on('error', () => {
    console.error(`Open ${url} in a browser.`);
  });
  child.unref();
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

await main();
