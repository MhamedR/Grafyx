import type {AtlasFileDiagnostic} from '../src/diagnostics.js';
import type {AtlasHost} from '../src/host.js';
import type {MapServer} from '../src/map-server.js';
import {DEFAULT_PORT, type AtlasSettings} from '../src/settings.js';
import type {WorkspaceContext} from '../src/workspace.js';

export interface FakeHost extends AtlasHost {
  readonly commands: string[];
  readonly logs: string[];
  readonly errors: string[];
  readonly warnings: string[];
  readonly infos: string[];
  readonly opened: string[];
  readonly editor: string[];
  readonly diagnostics: AtlasFileDiagnostic[][];
  cleared: number;
  nextPick: Array<string | undefined>;
  nextInput: Array<string | undefined>;
}

export function fakeHost(): FakeHost {
  const host: FakeHost = {
    commands: [],
    logs: [],
    errors: [],
    warnings: [],
    infos: [],
    opened: [],
    editor: [],
    diagnostics: [],
    cleared: 0,
    nextPick: [],
    nextInput: [],
    registerCommand(id) {
      host.commands.push(id);
    },
    log(message) {
      host.logs.push(message);
    },
    showError(message) {
      host.errors.push(message);
    },
    showWarning(message) {
      host.warnings.push(message);
    },
    showInformation(message) {
      host.infos.push(message);
    },
    pick() {
      return Promise.resolve(host.nextPick.shift());
    },
    input() {
      return Promise.resolve(host.nextInput.shift());
    },
    openExternal(url) {
      host.opened.push(url);
      return Promise.resolve();
    },
    openInEditor(url) {
      host.editor.push(url);
      return Promise.resolve();
    },
    setDiagnostics(items) {
      host.diagnostics.push([...items]);
    },
    clearDiagnostics() {
      host.cleared += 1;
    },
    revealOutput() {},
  };
  return host;
}

export function settings(partial: Partial<AtlasSettings> = {}): AtlasSettings {
  return {
    root: partial.root ?? '',
    port: partial.port ?? DEFAULT_PORT,
    portExplicit: partial.portExplicit ?? false,
    openIn: partial.openIn ?? 'editor',
    diagnostics: partial.diagnostics ?? true,
  };
}

export function workspace(partial: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    folders: partial.folders ?? [],
    dirtyPaths: partial.dirtyPaths ?? [],
    ...(partial.targetPath !== undefined ? {targetPath: partial.targetPath} : {}),
    ...(partial.activeDocument !== undefined ? {activeDocument: partial.activeDocument} : {}),
  };
}

export function fakeMap(): MapServer & {
  readonly starts: Array<{root: string; port: number}>;
  stops: number;
} {
  const starts: Array<{root: string; port: number}> = [];
  let running = false;
  let stops = 0;
  return {
    starts,
    get stops() {
      return stops;
    },
    start(root, port) {
      starts.push({root, port});
      running = true;
      return Promise.resolve({url: `http://127.0.0.1:${port}`});
    },
    stop() {
      stops += 1;
      const was = running;
      running = false;
      return Promise.resolve(was);
    },
  };
}
