import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {DEFAULT_PORT, normalizeOpenIn, resolvePort} from '../src/settings.js';

test('an edited port wins over PORT', () => {
  assert(resolvePort({port: 4400, portExplicit: true}, '4318') === 4400, 'the setting is --port');
});

test('PORT is the port when the setting is still the default', () => {
  assert(
    resolvePort({port: DEFAULT_PORT, portExplicit: false}, '4500') === 4500,
    'PORT is used while the setting is untouched',
  );
  assert(
    resolvePort({port: DEFAULT_PORT, portExplicit: false}, undefined) === 4328,
    '4328 is the editor default, not the CLI port',
  );
  assert(
    resolvePort({port: DEFAULT_PORT, portExplicit: false}, '  ') === DEFAULT_PORT,
    'a blank PORT is ignored',
  );
});

test('a port that listen would reject is reported', () => {
  let message = '';
  try {
    resolvePort({port: 4318, portExplicit: false}, 'nope');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes('nope'), 'the message keeps the rejected value');
  assert(message.includes('0 to 65535'), 'the message names the range');
});

test('openIn accepts the three places the map can go', () => {
  assert(normalizeOpenIn('external') === 'external', 'external matches the CLI');
  assert(normalizeOpenIn('none') === 'none', 'none matches --no-open');
  assert(normalizeOpenIn('editor') === 'editor', 'editor keeps the map in VS Code');
  assert(
    normalizeOpenIn('simpleBrowser') === 'editor',
    'the old simple browser value stays in the editor',
  );
  assert(normalizeOpenIn('popup') === 'editor', 'an unknown value opens in the editor');
});
