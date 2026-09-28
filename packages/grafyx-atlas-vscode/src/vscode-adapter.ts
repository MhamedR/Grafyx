/**
 * VS Code bindings. No atlas behavior lives here.
 */

import * as vscode from 'vscode';
import type {AtlasHost} from './host.js';
import {DEFAULT_PORT, normalizeOpenIn, type AtlasSettings} from './settings.js';
import {filePathFromCommandArgument, type WorkspaceContext} from './workspace.js';

export function createVsCodeHost(
  output: vscode.OutputChannel,
  diagnostics: vscode.DiagnosticCollection,
  context: vscode.ExtensionContext,
): AtlasHost {
  let panel: vscode.WebviewPanel | undefined;

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
      const origin = new URL(url).origin;
      const src = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';" />
  <style>
    html, body, iframe { margin: 0; padding: 0; width: 100%; height: 100%; border: none; background: #14120e; }
  </style>
</head>
<body>
  <iframe src="${src}" title="Grafyx Atlas"></iframe>
</body>
</html>`;

      if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        panel.webview.html = html;
        return;
      }

      panel = vscode.window.createWebviewPanel(
        'grafyxAtlas.map',
        'Grafyx Atlas',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );
      panel.webview.html = html;
      panel.onDidDispose(() => {
        panel = undefined;
      });
      context.subscriptions.push(panel);
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
