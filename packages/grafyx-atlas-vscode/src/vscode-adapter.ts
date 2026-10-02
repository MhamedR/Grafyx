/**
 * VS Code bindings. No atlas behavior lives here.
 */

import {randomBytes} from 'node:crypto';
import {isAbsolute, join} from 'node:path';
import type {AtlasSnapshot} from 'grafyx-atlas';
import * as vscode from 'vscode';
import type {AtlasHost} from './host.js';
import {DEFAULT_PORT, normalizeOpenIn, type AtlasSettings} from './settings.js';
import {AtlasTree} from './tree.js';
import {atlasWebviewHtml} from './webview.js';
import {filePathFromCommandArgument, type WorkspaceContext} from './workspace.js';

export function createVsCodeHost(
  output: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection,
  context: vscode.ExtensionContext,
): AtlasHost {
  let panel: vscode.WebviewPanel | undefined;
  const tree = new AtlasTree();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = 'Grafyx Atlas';
  status.text = '$(type-hierarchy) Atlas';
  status.tooltip = 'Open Grafyx Atlas';
  status.command = 'grafyxAtlas.openMap';
  status.show();

  const postToMap = (message: Record<string, unknown>): void => {
    // VS Code's webview.postMessage accepts only the payload.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    panel?.webview.postMessage({source: 'grafyx-atlas-extension', ...message});
  };

  const syncActiveFile = (): void => {
    if (!panel || !followActiveEditor()) return;
    const document = vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme !== 'file') return;
    postToMap({type: 'activeFile', path: document.uri.fsPath});
  };

  context.subscriptions.push(
    status,
    vscode.window.registerTreeDataProvider('grafyxAtlas.explorer', tree),
    vscode.window.onDidChangeActiveTextEditor(() => {
      syncActiveFile();
    }),
  );

  const onWebviewMessage = async (message: unknown): Promise<void> => {
    if (!message || typeof message !== 'object') return;
    const record = message as {
      source?: unknown;
      type?: unknown;
      id?: unknown;
      path?: unknown;
      root?: unknown;
    };
    if (record.source !== 'grafyx-atlas') return;

    if (record.type === 'ready') {
      syncActiveFile();
      return;
    }

    if (record.type === 'selection') {
      const id = typeof record.id === 'string' ? record.id : '';
      if (id.length === 0) {
        status.text = '$(type-hierarchy) Atlas';
        status.tooltip = 'Open Grafyx Atlas';
        return;
      }
      status.text = `$(type-hierarchy) ${id.length > 48 ? `${id.slice(0, 45)}…` : id}`;
      status.tooltip = typeof record.path === 'string' && record.path.length > 0 ? record.path : id;
      return;
    }

    if (
      (record.type !== 'open' && record.type !== 'reveal') ||
      typeof record.path !== 'string' ||
      typeof record.root !== 'string'
    ) {
      return;
    }

    const uri = vscode.Uri.file(absoluteAtlasPath(record.root, record.path));
    if (record.type === 'reveal') {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
      }
      await vscode.window.showTextDocument(uri, {preview: false});
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(text);
    }
  };

  return {
    registerCommand(id, handler) {
      context.subscriptions.push(
        vscode.commands.registerCommand(id, (argument?: unknown) => {
          void handler(argument);
        }),
      );
    },
    log(message) {
      output.appendLine(message);
    },
    showError(message) {
      void vscode.window.showErrorMessage(message);
    },
    showWarning(message) {
      void vscode.window.showWarningMessage(message);
    },
    showInformation(message) {
      void vscode.window.showInformationMessage(message);
    },
    async pick(items, placeHolder) {
      return vscode.window.showQuickPick([...items], {placeHolder});
    },
    async input(prompt, placeHolder) {
      return vscode.window.showInputBox({prompt, placeHolder});
    },
    async openExternal(url) {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
      if (!opened) throw new Error(`Open ${url} in a browser.`);
    },
    async openInEditor(url) {
      const html = atlasWebviewHtml(url, randomBytes(16).toString('hex'));
      if (!panel) {
        panel = vscode.window.createWebviewPanel(
          'grafyxAtlas.map',
          'Grafyx Atlas',
          vscode.ViewColumn.Active,
          {enableScripts: true, retainContextWhenHidden: true},
        );
        context.subscriptions.push(
          panel,
          panel.webview.onDidReceiveMessage((message: unknown) => {
            void onWebviewMessage(message);
          }),
          panel.onDidDispose(() => {
            panel = undefined;
          }),
        );
      }
      panel.reveal(vscode.ViewColumn.Active);
      panel.webview.html = html;
    },
    setStructure(snapshot: AtlasSnapshot | null) {
      tree.setSnapshot(snapshot);
    },
    setDiagnostics(items) {
      const grouped = new Map<string, vscode.Diagnostic[]>();
      for (const item of items) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          item.message,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'Grafyx Atlas';
        const list = grouped.get(item.file);
        if (list) list.push(diagnostic);
        else grouped.set(item.file, [diagnostic]);
      }
      diagnostics.clear();
      for (const [file, list] of grouped) diagnostics.set(vscode.Uri.file(file), list);
    },
    clearDiagnostics() {
      diagnostics.clear();
    },
    revealOutput() {
      output.show(true);
    },
  };
}

function followActiveEditor(): boolean {
  return (
    vscode.workspace.getConfiguration('grafyxAtlas').get<boolean>('followActiveEditor') ?? true
  );
}

function absoluteAtlasPath(root: string, nodePath: string): string {
  if (nodePath === '.' || nodePath.length === 0) return root;
  if (isAbsolute(nodePath)) return nodePath;
  return join(root, nodePath);
}

export function readSettings(): AtlasSettings {
  const config = vscode.workspace.getConfiguration('grafyxAtlas');
  const inspected = config.inspect<number>('port');
  const portExplicit =
    inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined ||
    inspected?.workspaceFolderValue !== undefined;

  return {
    root: config.get<string>('root') ?? '',
    port: config.get<number>('port') ?? DEFAULT_PORT,
    portExplicit,
    openIn: normalizeOpenIn(config.get<string>('openIn')),
    diagnostics: config.get<boolean>('diagnostics') ?? true,
  };
}

export function readWorkspace(argument: unknown): WorkspaceContext {
  const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const targetPath = filePathFromCommandArgument(argument);
  const active = vscode.window.activeTextEditor?.document;
  const dirtyPaths = vscode.workspace.textDocuments
    .filter((document) => document.isDirty && document.uri.scheme === 'file')
    .map((document) => document.uri.fsPath);

  let activeDocument: WorkspaceContext['activeDocument'];
  if (active?.uri.scheme === 'untitled') {
    activeDocument = {fsPath: '', isDirty: active.isDirty, isUntitled: true};
  } else if (active?.uri.scheme === 'file') {
    activeDocument = {fsPath: active.uri.fsPath, isDirty: active.isDirty, isUntitled: false};
  }

  return {
    folders,
    dirtyPaths,
    ...(targetPath !== undefined ? {targetPath} : {}),
    ...(activeDocument !== undefined ? {activeDocument} : {}),
  };
}
