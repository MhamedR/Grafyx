import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {connectionCurve} from '../src/ui/curves.js';
import type {PlacedNode} from '../src/layout.js';

function node(id: string, rank: number, x: number, y: number): PlacedNode {
  return {id, rank, x, y, width: 100, height: 40, cyclic: false};
}

test('edges leave the right of A and enter the left of B', () => {
  const from = node('a', 0, 10, 20);
  const to = node('b', 1, 200, 20);
  const d = connectionCurve(from, to);

  assert(d.startsWith('M 110 40'), 'the path starts at the right-middle of A');
  assert(d.includes('200 40'), 'the path ends at the left-middle of B');
  assert(d.includes(' C '), 'ranks use a cubic');
});

test('a same-rank edge dips instead of crossing the nodes', () => {
  const from = node('a', 2, 10, 10);
  const to = node('b', 2, 10, 80);
  const d = connectionCurve(from, to);

  assert(d.includes(' C '), 'a same-rank edge is still a cubic');
  assert(d.includes('132'), 'the dip sits 32px below the lower midpoint');
});
