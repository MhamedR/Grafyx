import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {ATLAS_COMMANDS} from '../src/commands.js';
import {DEFAULT_PORT} from '../src/settings.js';

test('the extension manifest matches the registered commands', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    icon?: string;
    main?: string;
    engines?: {vscode?: string};
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{command: string; title: string}>;
      configuration?: {properties?: Record<string, {default?: unknown}>};
      menus?: {
        'explorer/context'?: Array<{command: string}>;
        'editor/context'?: Array<{command: string}>;
      };
    };
  };

  const commands = manifest.contributes?.commands ?? [];
  assert(commands.length === ATLAS_COMMANDS.length, 'every command is contributed');
  for (const command of ATLAS_COMMANDS) {
    const contributed = commands.find((item) => item.command === command.id);
    assert(contributed?.title === command.title, `${command.id} keeps its title`);
    assert(
      manifest.activationEvents?.includes(`onCommand:${command.id}`) === true,
      `${command.id} activates on its command`,
    );
  }

  assert(manifest.main === './dist/extension.js', 'the extension host loads the bundle');
  assert(manifest.icon === 'icon.png', 'the extension shows the Grafyx icon');
  assert(manifest.engines?.vscode === '^1.95.0', 'ESM extensions need a current VS Code');

  const properties = manifest.contributes?.configuration?.properties ?? {};
  assert(properties['grafyxAtlas.root']?.default === '', 'root defaults to the workspace');
  assert(
    properties['grafyxAtlas.port']?.default === DEFAULT_PORT,
    'the editor port is not the CLI port',
  );
  const cliPort: number = 4318;
  assert(DEFAULT_PORT !== cliPort, 'grafyx-atlas keeps 4318');
  assert(properties['grafyxAtlas.openIn']?.default === 'editor', 'the map opens in a VS Code tab');
  assert(properties['grafyxAtlas.diagnostics']?.default === true, 'cycle warnings default on');

  const explorer =
    manifest.contributes?.menus?.['explorer/context']?.map((item) => item.command) ?? [];
  assert(explorer.includes('grafyxAtlas.showImpact'), 'explorer can show impact');
  assert(explorer.includes('grafyxAtlas.goDeeper'), 'explorer can go deeper');
  const editor = manifest.contributes?.menus?.['editor/context']?.map((item) => item.command) ?? [];
  assert(editor.includes('grafyxAtlas.showUpstream'), 'the editor can show upstream');
});
