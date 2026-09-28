/**
 * Local map server for grafyx/atlas.
 *
 * The CLI in `server.ts` parses arguments and calls `startAtlasServer`.
 * Importing this module does not listen. Call `startAtlasServer` to bind
 * 127.0.0.1. The UI is the prebuilt bundle beside this file when the package
 * is built, and an esbuild bundle of `src/ui` when it is not.
 */

import {existsSync} from 'node:fs';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractProject} from './extract-project.js';
import {extractSourceFocus} from './extract-source.js';
import type {AtlasBoot, AtlasSnapshot} from './model.js';

export interface AtlasServerOptions {
  readonly root: string;
  readonly port: number;
  /**
   * Directory that contains `ui/app.js` and `ui/atlas.css`.
   * Defaults to this module's directory, which is correct for the CLI.
   */
  readonly moduleDirectory?: string;
}

export interface RunningAtlasServer {
  readonly url: string;
  readonly root: string;
  readonly port: number;
  close(): Promise<void>;
}

interface LocatedAssets {
  readonly base: string;
  readonly uiDir: string;
  readonly prebuiltUi: string;
  readonly repoRoot: string;
  readonly packaged: boolean;
}

function locate(moduleDirectory?: string): LocatedAssets {
  const base = moduleDirectory ?? dirname(fileURLToPath(import.meta.url));
  const uiDir = join(base, 'ui');
  const prebuiltUi = join(uiDir, 'app.js');
  return {
    base,
    uiDir,
    prebuiltUi,
    repoRoot: resolve(base, '../../..'),
    packaged: existsSync(prebuiltUi),
  };
}

/** Directory of this module. The CLI uses it for the default root and the UI. */
export function atlasServerDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Serves the atlas map on 127.0.0.1.
 *
 * Does not open a browser and does not read `process.argv`. The caller owns
 * logging and the browser. `close` stops listening.
 */
export async function startAtlasServer(options: AtlasServerOptions): Promise<RunningAtlasServer> {
  const located = locate(options.moduleDirectory);
  const script = located.packaged
    ? await readFile(located.prebuiltUi, 'utf8')
    : await bundleUi(located);
  const stylesheet = await readFile(join(located.uiDir, 'atlas.css'), 'utf8');
  const server = createServer((request, response) => {
    void handle(request, response, {root: options.root, script, stylesheet});
  });

  const boundPort = await new Promise<number>((resolveListen, rejectListen) => {
    const fail = (error: Error): void => {
      rejectListen(error);
    };
    server.once('error', fail);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', fail);
      const address = server.address();
      resolveListen(address && typeof address !== 'string' ? address.port : options.port);
    });
  });

  return {
    url: `http://127.0.0.1:${boundPort}`,
    root: options.root,
    port: boundPort,
    close() {
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  assets: {readonly root: string; readonly script: string; readonly stylesheet: string},
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  try {
    if (url.pathname === '/atlas.css') {
      send(response, 200, 'text/css; charset=utf-8', assets.stylesheet);
      return;
    }

    if (url.pathname === '/app.js') {
      send(response, 200, 'text/javascript; charset=utf-8', assets.script);
      return;
    }

    if (url.pathname === '/api/snapshot') {
      const snapshot = await extractProject(assets.root);
      send(response, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot));
      return;
    }

    if (url.pathname === '/api/focus') {
      const nodePath = url.searchParams.get('path') ?? '';
      const snapshot = await extractSourceFocus(assets.root, nodePath);
      if (!snapshot) {
        send(response, 404, 'text/plain; charset=utf-8', 'Nothing deeper here.');
        return;
      }
      send(response, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot));
      return;
    }

    if (url.pathname !== '/') {
      send(response, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }

    const boot = await bootPayload(assets.root);
    send(response, 200, 'text/html; charset=utf-8', html(boot));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(response, 500, 'text/plain; charset=utf-8', message);
  }
}

async function bootPayload(root: string): Promise<AtlasBoot> {
  try {
    const snapshot: AtlasSnapshot = await extractProject(root);
    return {root: snapshot.root, snapshot, error: null};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {root, snapshot: null, error: message};
  }
}

function html(boot: AtlasBoot): string {
  const payload = JSON.stringify(boot).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>grafyx/atlas</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,520&family=Outfit:wght@340;420;520&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/atlas.css" />
  </head>
  <body>
    <div id="root"></div>
    <script id="atlas-boot" type="application/json">${payload}</script>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;
}

async function bundleUi(located: LocatedAssets): Promise<string> {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    absWorkingDir: located.repoRoot,
    entryPoints: [join(located.uiDir, 'main.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    sourcemap: 'inline',
    define: {'process.env.NODE_ENV': '"development"'},
    logLevel: 'silent',
  });

  const file = result.outputFiles?.[0];
  if (!file) throw new Error('The atlas UI bundle was empty.');
  return file.text;
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  response.end(body);
}
