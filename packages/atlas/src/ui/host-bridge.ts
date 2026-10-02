/**
 * Messages between the atlas page and a host that embeds it.
 * The page stays usable with no host. VS Code is the host that answers.
 */

export type HostThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export interface HostThemeMessage {
  readonly type: 'theme';
  readonly kind: HostThemeKind;
  readonly reducedMotion: boolean;
  readonly tokens: Readonly<Record<string, string>>;
}

export interface HostActiveFileMessage {
  readonly type: 'activeFile';
  readonly path: string;
}

export type HostInbound = HostThemeMessage | HostActiveFileMessage;

const HOST = 'grafyx-atlas-host';
const PAGE = 'grafyx-atlas';

type Listener = (message: HostInbound) => void;

const listeners = new Set<Listener>();
let listening = false;
let pendingTheme: HostThemeMessage | null = null;
let pendingFile: HostActiveFileMessage | null = null;

export function atlasEmbedded(): boolean {
  return window.parent !== window;
}

export function postToHost(message: {readonly type: string} & Record<string, unknown>): void {
  if (!atlasEmbedded()) return;
  window.parent.postMessage({source: PAGE, ...message}, '*');
}

export function applyHostTheme(message: HostThemeMessage): void {
  const root = document.documentElement;
  root.dataset.host = 'vscode';
  root.dataset.theme = message.kind;
  for (const [key, value] of Object.entries(message.tokens)) {
    if (!key.startsWith('--') || value.trim().length === 0) continue;
    root.style.setProperty(key, value.trim());
  }
}

export function listenToHost(onMessage: Listener): () => void {
  installHostListener();
  listeners.add(onMessage);
  if (pendingTheme) onMessage(pendingTheme);
  if (pendingFile) onMessage(pendingFile);
  return () => listeners.delete(onMessage);
}

function installHostListener(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const message = readHostMessage(event.data);
    if (!message) return;
    if (message.type === 'theme') pendingTheme = message;
    else pendingFile = message;
    for (const listener of listeners) listener(message);
  });
}

function readHostMessage(data: unknown): HostInbound | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as {
    source?: unknown;
    type?: unknown;
    kind?: unknown;
    reducedMotion?: unknown;
    tokens?: unknown;
    path?: unknown;
  };
  if (record.source !== HOST) return null;

  if (record.type === 'theme' && record.tokens && typeof record.tokens === 'object') {
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.tokens as Record<string, unknown>)) {
      if (typeof value === 'string') tokens[key] = value;
    }
    return {
      type: 'theme',
      kind: themeKind(record.kind),
      reducedMotion: record.reducedMotion === true,
      tokens,
    };
  }

  if (record.type === 'activeFile' && typeof record.path === 'string' && record.path.length > 0) {
    return {type: 'activeFile', path: record.path};
  }

  return null;
}

/** Follow the OS until a host pins `data-host`. */
export function followSystemTheme(): () => void {
  const root = document.documentElement;
  const light = window.matchMedia('(prefers-color-scheme: light)');
  const contrast = window.matchMedia('(prefers-contrast: more)');

  const apply = (): void => {
    if (root.dataset.host === 'vscode') return;
    const bright = light.matches;
    if (contrast.matches) root.dataset.theme = bright ? 'high-contrast-light' : 'high-contrast';
    else root.dataset.theme = bright ? 'light' : 'dark';
  };

  apply();
  light.addEventListener('change', apply);
  contrast.addEventListener('change', apply);
  return () => {
    light.removeEventListener('change', apply);
    contrast.removeEventListener('change', apply);
  };
}

installHostListener();

function themeKind(value: unknown): HostThemeKind {
  if (
    value === 'light' ||
    value === 'dark' ||
    value === 'high-contrast' ||
    value === 'high-contrast-light'
  ) {
    return value;
  }
  return 'dark';
}
