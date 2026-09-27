/**
 * End-to-end integration test for the reactive graph.
 *
 * This verifies that values, computed nodes, dependency propagation,
 * scheduling, and effects work together as one system through the public API.
 */

import {
  ReactiveComputed,
  ReactiveEffect,
  ReactiveRuntime,
  ReactiveValue,
} from '../../grafyx/index.js';
import {assert} from '../../../test/assert.js';

/**
 * Verifies the complete source → computed → computed → effect pipeline.
 */
function testReactivePipeline(): void {
  const runtime = new ReactiveRuntime();

  const source = new ReactiveValue(runtime, 'source', 2);

  const doubled = new ReactiveComputed(runtime, 'doubled', () => source.value * 2);

  const formatted = new ReactiveComputed(runtime, 'formatted', () => `value=${doubled.value}`);

  const values: string[] = [];

  const effect = new ReactiveEffect(runtime, 'effect', () => {
    values.push(formatted.value);
  });

  // The first effect execution establishes the complete dependency chain.
  effect.run();

  assert(values.length === 1, 'effect should run once during initialization');

  assert(values[0] === 'value=4', 'effect should observe the initial computed value');

  // Change the source and flush the scheduled reactive work.
  source.value = 5;
  runtime.flush();

  assert(values.length === 2, 'effect should run again after the source changes');

  assert(values[1] === 'value=10', 'effect should observe the updated computed value');
}

/**
 * Verifies that the complete reactive pipeline correctly handles dynamic
 * dependency changes.
 */
function testDynamicReactivePipeline(): void {
  const runtime = new ReactiveRuntime();

  const useFirst = new ReactiveValue(runtime, 'useFirst', true);
  const first = new ReactiveValue(runtime, 'first', 10);
  const second = new ReactiveValue(runtime, 'second', 20);

  const selected = new ReactiveComputed(runtime, 'selected', () =>
    useFirst.value ? first.value : second.value,
  );

  const values: number[] = [];

  const effect = new ReactiveEffect(runtime, 'effect', () => {
    values.push(selected.value);
  });

  // Establish the initial dependency graph.
  effect.run();

  assert(values[0] === 10, 'effect should initially observe the first branch');

  // Switch the computed node to the second dependency branch.
  useFirst.value = false;
  runtime.flush();

  assert(values[1] === 20, 'effect should observe the second branch after switching');

  // Changing the old branch should no longer trigger the effect.
  first.value = 100;
  runtime.flush();

  assert(values.length === 2, 'effect should no longer depend on the inactive branch');

  // Changing the active branch should still trigger the effect.
  second.value = 200;
  runtime.flush();

  assert(values[2] === 200, 'effect should continue tracking the active branch');
}

/**
 * Run the dynamic integration test.
 */
testReactivePipeline();
testDynamicReactivePipeline();
