/**
 * Activity Bar list of the last scan. Clicking a part reveals it on the map.
 */

import {join} from 'node:path';
import * as vscode from 'vscode';
import {nodeShape, type AtlasSnapshot, type PackageNode} from 'grafyx-atlas';

class AtlasPart extends vscode.TreeItem {
  constructor(node: PackageNode, snapshot: AtlasSnapshot) {
    super(node.id, vscode.TreeItemCollapsibleState.None);
    const absolute =
      node.path === '.' || node.path.length === 0 ? snapshot.root : join(snapshot.root, node.path);
    const incoming = snapshot.edges.filter((edge) => edge.to === node.id).length;
    const outgoing = snapshot.edges.filter((edge) => edge.from === node.id).length;
    const shape = nodeShape(snapshot.kind, node);
    this.description = `${incoming} in · ${outgoing} out`;
    this.tooltip = node.path;
    this.contextValue = 'atlasPart';
    this.resourceUri = vscode.Uri.file(absolute);
    this.iconPath = new vscode.ThemeIcon(
      shape === 'file' ? 'file' : shape === 'folder' ? 'folder' : 'package',
    );
    this.command = {
      command: 'grafyxAtlas.revealFile',
      title: 'Reveal in Map',
      arguments: [this.resourceUri],
    };
  }
}

export class AtlasTree implements vscode.TreeDataProvider<AtlasPart> {
  private snapshot: AtlasSnapshot | null = null;
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;

  setSnapshot(snapshot: AtlasSnapshot | null): void {
    this.snapshot = snapshot;
    this.changes.fire();
  }

  getTreeItem(element: AtlasPart): vscode.TreeItem {
    return element;
  }

  getChildren(): AtlasPart[] {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.nodes.length === 0) return [];
    return [...snapshot.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => new AtlasPart(node, snapshot));
  }
}
