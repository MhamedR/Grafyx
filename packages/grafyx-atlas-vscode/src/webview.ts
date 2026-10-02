/**
 * Editor tab around the atlas page.
 * The page stays on the local server. This shell passes the VS Code theme
 * and editor events through to it, and passes open/reveal requests back.
 */

export function atlasWebviewHtml(url: string, nonce: string): string {
  const origin = new URL(url).origin;
  const src = url.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    html, body, iframe { margin: 0; padding: 0; width: 100%; height: 100%; border: none; background: var(--vscode-editor-background, #12110e); }
  </style>
</head>
<body>
  <iframe id="atlas" src="${src}" title="Grafyx Atlas" allow="clipboard-write"></iframe>
  <script nonce="${nonce}">
${BRIDGE}
  </script>
</body>
</html>`;
}

const BRIDGE = `(function () {
  var vscode = acquireVsCodeApi();
  var frame = document.getElementById('atlas');

  function pick(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function kind() {
    var list = document.body.classList;
    if (list.contains('vscode-high-contrast-light')) return 'high-contrast-light';
    if (list.contains('vscode-high-contrast')) return 'high-contrast';
    if (list.contains('vscode-light')) return 'light';
    return 'dark';
  }

  function tokens() {
    var link = pick('--vscode-textLink-foreground') || pick('--vscode-focusBorder');
    var border = pick('--vscode-panel-border') || pick('--vscode-widget-border');
    var surface = pick('--vscode-sideBar-background') || pick('--vscode-editor-background');
    var elevated = pick('--vscode-editorWidget-background') || surface;
    return {
      '--bg': pick('--vscode-editor-background'),
      '--field': pick('--vscode-editor-background'),
      '--surface': surface,
      '--node': elevated,
      '--surface-elevated': elevated,
      '--text': pick('--vscode-editor-foreground'),
      '--ink': pick('--vscode-editor-foreground'),
      '--muted': pick('--vscode-descriptionForeground'),
      '--border': border,
      '--hairline': border,
      '--accent': link,
      '--copper': link,
      '--focus': pick('--vscode-focusBorder'),
      '--selection': pick('--vscode-list-activeSelectionBackground'),
      '--dependency': pick('--vscode-charts-blue') || link,
      '--dependent': pick('--vscode-charts-yellow') || pick('--vscode-editorWarning-foreground'),
      '--danger': pick('--vscode-errorForeground'),
      '--edge': pick('--vscode-editor-foreground'),
      '--bundle-ink': pick('--vscode-charts-orange') || link
    };
  }

  function post(message) {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(Object.assign({source: 'grafyx-atlas-host'}, message), '*');
  }

  function sendTheme() {
    post({
      type: 'theme',
      kind: kind(),
      reducedMotion:
        document.body.classList.contains('monaco-reduce-motion') ||
        matchMedia('(prefers-reduced-motion: reduce)').matches,
      tokens: tokens()
    });
  }

  if (frame) {
    frame.addEventListener('load', function () {
      sendTheme();
      vscode.postMessage({source: 'grafyx-atlas', type: 'ready'});
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source === 'grafyx-atlas' && frame && event.source === frame.contentWindow) {
      if (data.type === 'ready') sendTheme();
      vscode.postMessage(data);
      return;
    }
    if (data.source === 'grafyx-atlas-extension') post(data);
  });

  new MutationObserver(sendTheme).observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });
})();`;
