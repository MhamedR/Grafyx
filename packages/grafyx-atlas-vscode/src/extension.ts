/**
 * Extension entry. Activation only registers commands and the output channel.
 * Scans and the map server start when a command runs.
 */

import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as vscode from 'vscode';
import {createAtlasController, type AtlasController} from './controller.js';
import {createMapServer} from './map-server.js';
import {createVsCodeHost, readSettings, readWorkspace} from './vscode-adapter.js';

let controller: AtlasController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Grafyx Atlas');
  const diagnostics = vscode.languages.createDiagnosticCollection('grafyx-atlas');
  context.subscriptions.push(output, diagnostics, {
    dispose() {
      void controller?.dispose();
    },
  });

  controller = createAtlasController({
    host: createVsCodeHost(output, diagnostics, context),
    readWorkspace,
    readSettings,
    envPort: process.env.PORT,
    mapServer: createMapServer(dirname(fileURLToPath(import.meta.url))),
  });
}

export async function deactivate(): Promise<void> {
  await controller?.dispose();
  controller = undefined;
}
