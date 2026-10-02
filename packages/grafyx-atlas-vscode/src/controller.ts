/**
 * Command handlers. Every scan, lens, and server start goes through grafyx-atlas.
 */

import {basename} from 'node:path';
import {
  EMPTY_LINE,
  extractProject,
  extractSourceFocus,
  parseCommand,
  type AtlasSnapshot,
  type PackageNode,
} from 'grafyx-atlas';
import {ATLAS_COMMANDS, type AtlasCommandId} from './commands.js';
import {cycleDiagnostics} from './diagnostics.js';
import type {AtlasHost} from './host.js';
import type {MapServer} from './map-server.js';
import {
  reportCycles,
  reportFocus,
  reportImpact,
  reportOrder,
  reportStats,
  reportUpstream,
} from './report.js';
import {resolvePort, type AtlasSettings} from './settings.js';
import {
  decideRoot,
  findProjectRoot,
  isAbsolutePath,
  nodesForPath,
  relativeToRoot,
  type WorkspaceContext,
} from './workspace.js';

const NOTHING_DEEPER = 'Nothing deeper here.';
const SAVE_FIRST = 'Save the file before Grafyx Atlas can read it. The scan reads the filesystem.';

export interface AtlasControllerOptions {
  readonly host: AtlasHost;
  readonly readWorkspace: (argument: unknown) => WorkspaceContext | Promise<WorkspaceContext>;
  readonly readSettings: () => AtlasSettings;
  readonly envPort: string | undefined;
  readonly mapServer: MapServer;
  readonly scan?: (root: string) => Promise<AtlasSnapshot>;
  readonly focus?: (root: string, nodePath: string) => Promise<AtlasSnapshot | null>;
}

export interface AtlasController {
  readonly commandIds: readonly string[];
  run(command: string, argument?: unknown): Promise<void>;
  dispose(): Promise<void>;
}

class Cancelled extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'Cancelled';
  }
}

export function createAtlasController(options: AtlasControllerOptions): AtlasController {
  const host = options.host;
  const scan = options.scan ?? extractProject;
  const focus = options.focus ?? extractSourceFocus;
  const handlers = new Map<string, (argument: unknown) => Promise<void>>();
  let disposed = false;

  const guard =
    (work: (argument: unknown) => Promise<void>) =>
    async (argument: unknown): Promise<void> => {
      try {
        await work(argument);
      } catch (error) {
        if (error instanceof Cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        host.log(message);
        if (error instanceof Error && error.stack) host.log(error.stack);
        host.showError(message);
        host.revealOutput();
      }
    };

  const bind = (id: AtlasCommandId, work: (argument: unknown) => Promise<void>): void => {
    const wrapped = guard(work);
    handlers.set(id, wrapped);
    host.registerCommand(id, wrapped);
  };

  bind('grafyxAtlas.openMap', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const port = resolvePort(options.readSettings(), options.envPort);
    const started = await options.mapServer.start(root, port);
    const settings = options.readSettings();
    host.log(`grafyx/atlas  ${started.url}`);
    host.log(root);
    if (settings.openIn === 'external') {
      host.revealOutput();
      await host.openExternal(started.url);
    } else if (settings.openIn === 'none') {
      host.revealOutput();
      host.showInformation(`Grafyx Atlas is running at ${started.url}`);
    } else await host.openInEditor(started.url);
    try {
      await scanned(root);
    } catch (error) {
      host.log(error instanceof Error ? error.message : String(error));
    }
  });

  bind('grafyxAtlas.stopMap', async () => {
    const stopped = await options.mapServer.stop();
    if (stopped) host.showInformation('Grafyx Atlas stopped.');
    else host.showInformation('Grafyx Atlas is not running.');
  });

  bind('grafyxAtlas.showImpact', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    const node = await selectNode(snapshot, workspace, 'Part to trace');
    if (!node) return;
    publish(reportImpact(snapshot, node.id), 'map');
    await showOnMap(root, 'impact', node.id);
  });

  bind('grafyxAtlas.showUpstream', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    const node = await selectNode(snapshot, workspace, 'Part to trace');
    if (!node) return;
    publish(reportUpstream(snapshot, node.id), 'map');
    await showOnMap(root, 'upstream', node.id);
  });

  bind('grafyxAtlas.showCycles', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    publish(reportCycles(snapshot), 'map');
    await showOnMap(root, 'cycles');
  });

  bind('grafyxAtlas.showOrder', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    publish(reportOrder(snapshot), 'map');
    await showOnMap(root, 'order');
  });

  bind('grafyxAtlas.showStats', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    publish(reportStats(snapshot), 'map');
    await showOnMap(root, 'stats');
  });

  bind('grafyxAtlas.goDeeper', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    const node = await selectNode(snapshot, workspace, 'Folder to open');
    if (!node) return;
    const deeper = await focus(root, node.path);
    if (!deeper) {
      host.log(NOTHING_DEEPER);
      host.showInformation(NOTHING_DEEPER);
      host.revealOutput();
      return;
    }
    publish(reportFocus(deeper));
  });

  bind('grafyxAtlas.refreshDiagnostics', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    publish(reportCycles(snapshot));
  });

  bind('grafyxAtlas.runCommand', async (argument) => {
    const text = await host.input('Part and lens', 'services impact');
    if (text === undefined) return;
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    const parsed = parseCommand(
      text,
      snapshot.nodes.map((node) => node.id),
    );
    if (!parsed.lens && !parsed.packageId) {
      publish('No matching part or lens.');
      return;
    }
    const lens = parsed.lens;
    if (lens === 'cycles') {
      publish(reportCycles(snapshot), 'map');
      await showOnMap(root, 'cycles');
      return;
    }
    if (lens === 'order') {
      publish(reportOrder(snapshot), 'map');
      await showOnMap(root, 'order');
      return;
    }
    if (lens === 'impact' || lens === 'upstream') {
      const id = parsed.packageId ?? (await selectNode(snapshot, workspace, 'Part to trace'))?.id;
      if (!id) return;
      publish(lens === 'impact' ? reportImpact(snapshot, id) : reportUpstream(snapshot, id), 'map');
      await showOnMap(root, lens, id);
      return;
    }
    if (parsed.packageId) {
      publish(
        `${reportImpact(snapshot, parsed.packageId)}\n${reportUpstream(snapshot, parsed.packageId)}`,
        'map',
      );
      await showOnMap(root, 'impact', parsed.packageId);
      return;
    }
    publish(reportOrder(snapshot), 'map');
    await showOnMap(root, 'map');
  });

  bind('grafyxAtlas.revealFile', async (argument) => {
    const {root, workspace} = await projectRoot(argument);
    warnIfDirty(root, workspace.dirtyPaths);
    const snapshot = await scanned(root);
    const node = await selectNode(snapshot, workspace, 'Part to reveal');
    if (!node) return;
    await showOnMap(root, 'map', node.id);
  });

  async function projectRoot(
    argument: unknown,
  ): Promise<{readonly root: string; readonly workspace: WorkspaceContext}> {
    const workspace = await options.readWorkspace(argument);
    if (!workspace.targetPath && workspace.activeDocument?.isUntitled) {
      throw new Error(SAVE_FIRST);
    }

    const activePath =
      workspace.activeDocument && !workspace.activeDocument.isUntitled
        ? workspace.activeDocument.fsPath
        : undefined;
    let decision = decideRoot({
      configuredRoot: options.readSettings().root,
      folders: workspace.folders,
      ...(workspace.targetPath !== undefined ? {targetPath: workspace.targetPath} : {}),
      ...(activePath !== undefined ? {activePath} : {}),
    });

    if (decision.kind === 'choose') {
      const picked = await host.pick([...decision.folders], 'Folder to map');
      if (!picked) throw new Cancelled();
      const configured = options.readSettings().root.trim();
      decision =
        configured.length > 0 && !isAbsolutePath(configured)
          ? decideRoot({
              configuredRoot: configured,
              folders: [picked],
              targetPath: picked,
            })
          : {kind: 'root', root: picked};
    }

    if (decision.kind === 'error') throw new Error(decision.message);
    if (decision.kind === 'walk') return {root: findProjectRoot(decision.start), workspace};
    if (decision.kind === 'choose') throw new Cancelled();
    return {root: decision.root, workspace};
  }

  async function scanned(root: string): Promise<AtlasSnapshot> {
    const snapshot = await scan(root);
    if (snapshot.nodes.length === 0) host.log(EMPTY_LINE);
    if (options.readSettings().diagnostics) host.setDiagnostics(cycleDiagnostics(snapshot));
    else host.clearDiagnostics();
    host.setStructure(snapshot);
    return snapshot;
  }

  async function selectNode(
    snapshot: AtlasSnapshot,
    workspace: WorkspaceContext,
    placeHolder: string,
  ): Promise<PackageNode | undefined> {
    const candidate =
      workspace.targetPath ??
      (workspace.activeDocument && !workspace.activeDocument.isUntitled
        ? workspace.activeDocument.fsPath
        : undefined);
    if (candidate) {
      const matches = nodesForPath(snapshot, candidate);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const picked = await host.pick(
          matches.map((node) => node.id),
          `Part in ${basename(candidate)}`,
        );
        if (!picked) return undefined;
        return matches.find((node) => node.id === picked);
      }
      host.log(`${basename(candidate)} is not an atlas part.`);
    }
    if (snapshot.nodes.length === 0) throw new Error(EMPTY_LINE);
    const picked = await host.pick(
      snapshot.nodes.map((node) => node.id),
      placeHolder,
    );
    if (!picked) return undefined;
    return snapshot.nodes.find((node) => node.id === picked);
  }

  function warnIfDirty(root: string, dirtyPaths: readonly string[]): void {
    const inside = dirtyPaths.filter((file) => relativeToRoot(root, file) !== undefined);
    if (inside.length === 0) return;
    const names = inside.slice(0, 5).map((file) => basename(file));
    const extra = inside.length > 5 ? ` and ${inside.length - 5} more` : '';
    const message = `Grafyx Atlas read the saved copy of ${names.join(', ')}${extra}. Save to include unsaved edits.`;
    host.log(message);
    host.showWarning(message);
  }

  function publish(message: string, where: 'map' | 'output' = 'output'): void {
    host.log(message);
    host.showInformation(spoken(message));
    if (where === 'output') host.revealOutput();
  }

  async function showOnMap(root: string, lens: string, id?: string): Promise<void> {
    const settings = options.readSettings();
    if (settings.openIn === 'none') {
      host.revealOutput();
      return;
    }
    const port = resolvePort(settings, options.envPort);
    const started = await options.mapServer.start(root, port);
    const url = mapViewUrl(started.url, lens, id);
    if (settings.openIn === 'external') {
      await host.openExternal(url);
      return;
    }
    await host.openInEditor(url);
  }

  return {
    commandIds: ATLAS_COMMANDS.map((command) => command.id),
    run(command, argument) {
      const handler = handlers.get(command);
      if (!handler) return Promise.reject(new Error(`Unknown command ${command}.`));
      return handler(argument);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await options.mapServer.stop();
      host.clearDiagnostics();
    },
  };
}

function mapViewUrl(base: string, lens: string, id?: string): string {
  const url = new URL(base);
  url.searchParams.set('lens', lens);
  if (id !== undefined && id.length > 0) url.searchParams.set('id', id);
  return url.toString();
}

function spoken(message: string): string {
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const head = lines[0] ?? message;
  const question = lines[1];
  const rest = lines.slice(question ? 2 : 1);
  if (!question) return head;
  if (rest.length === 0) return `${head}. ${question}`;
  return `${head}. ${question} ${rest.join(', ')}.`;
}
