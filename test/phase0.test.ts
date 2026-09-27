import {
  ManualEffectScheduler,
  Node,
  ReactiveComputed,
  ReactiveEffect,
  ReactiveRuntime,
  ReactiveScheduler,
  ReactiveValue,
} from '../packages/grafyx/index.js';
import {assert} from './assert.js';

function thrown(run: () => void): {didThrow: boolean; value: unknown} {
  try {
    run();
    return {didThrow: false, value: undefined};
  } catch (error) {
    return {didThrow: true, value: error};
  }
}

function testRuntimeDisposesOwnersAndCustomWork(): void {
  const runtime = new ReactiveRuntime();
  const scheduler = new ManualEffectScheduler();
  const source = new ReactiveValue(runtime, 'source', 1);
  const computed = new ReactiveComputed(runtime, 'computed', () => source.value * 2);
  let runs = 0;
  const effect = new ReactiveEffect(
    runtime,
    'effect',
    () => {
      runs++;
      void computed.value;
    },
    scheduler,
  );

  effect.run();
  source.value = 2;
  assert(scheduler.hasPendingWork, 'custom effect work should be pending before disposal');

  runtime.dispose();
  scheduler.flush();

  assert(source.disposed, 'runtime disposal should dispose values');
  assert(computed.disposed, 'runtime disposal should dispose computeds');
  assert(effect.destroyed, 'runtime disposal should destroy effects');
  assert(runs === 1, 'custom-scheduled effects must not run after runtime disposal');
  assert(
    thrown(() => {
      source.value = 3;
    }).didThrow,
    'disposed runtime values must reject writes before mutation',
  );
}

function testNodeDisposalCancelsPendingChange(): void {
  const runtime = new ReactiveRuntime();
  const source = new ReactiveValue(runtime, 'source', 1);

  runtime.scheduleChange(source.node);
  source.dispose();
  runtime.flush();

  assert(source.node.version === 0, 'disposed nodes must not receive queued changes');
  assert(runtime.pendingChangeCount === 0, 'disposed nodes must leave no pending-change state');
}

function testRuntimeIsolationAndUniqueIds(): void {
  const firstRuntime = new ReactiveRuntime();
  const secondRuntime = new ReactiveRuntime();
  const source = new ReactiveValue(firstRuntime, 'source', 1);
  const computed = new ReactiveComputed(secondRuntime, 'computed', () => source.value * 2);

  const crossRuntime = thrown(() => {
    void computed.value;
  });

  assert(crossRuntime.didThrow, 'cross-runtime dependency reads must throw');
  assert(
    crossRuntime.value instanceof Error &&
      crossRuntime.value.message.includes('cannot cross runtime boundaries'),
    'cross-runtime failure should explain the ownership boundary',
  );

  const duplicateRuntime = new ReactiveRuntime();
  new ReactiveValue(duplicateRuntime, 'duplicate', 1);
  const duplicate = thrown(() => {
    new ReactiveValue(duplicateRuntime, 'duplicate', 2);
  });

  assert(duplicate.didThrow, 'a runtime must reject duplicate node IDs');
}

function testBatchErrorFinalization(): void {
  const runtime = new ReactiveRuntime();
  const events: string[] = [];
  const result = thrown(() => {
    runtime.batch(() => {
      runtime.deferUntilBatchComplete(() => {
        events.push('first');
        throw new Error('deferred failure');
      });
      runtime.deferUntilBatchComplete(() => {
        events.push('second');
      });
      throw new Error('callback failure');
    });
  });

  assert(
    events.join(',') === 'first,second',
    'batch finalization should execute every deferred task',
  );
  assert(
    result.value instanceof Error && result.value.message === 'callback failure',
    'the primary callback error should take precedence over finalization errors',
  );
}

function testSchedulerErrorAndReentrancyContracts(): void {
  const scheduler = new ReactiveScheduler();
  scheduler.schedule(() => {
    throw undefined;
  });
  assert(thrown(() => scheduler.flush()).didThrow, 'scheduler must rethrow undefined values');

  const manual = new ManualEffectScheduler();
  const events: string[] = [];
  manual.schedule(() => {
    events.push('a');
    manual.schedule(() => events.push('b'));
    manual.flush();
  });

  const recursive = thrown(() => manual.flush());
  assert(recursive.didThrow, 'manual scheduler must reject recursive flushes');
  assert(events.join(',') === 'a', 'new manual work must wait for the next flush');

  manual.flush();
  assert(events.join(',') === 'a,b', 'deferred manual work should remain queued');
}

function testComputedDepthLimitAndWideDependencies(): void {
  const deepRuntime = new ReactiveRuntime();
  const source = new ReactiveValue(deepRuntime, 'deep-source', 1);
  let current: {value: number} = source;

  for (let index = 0; index < 1_100; index++) {
    const previous = current;
    current = new ReactiveComputed(deepRuntime, `deep-${index}`, () => previous.value + 1);
  }

  const deepRead = thrown(() => {
    void current.value;
  });

  assert(
    deepRead.value instanceof Error &&
      deepRead.value.message === 'Reactive computation depth exceeded 1000.',
    'deep computations should fail with a stable limit instead of overflowing the stack',
  );
  assert(
    deepRuntime.context.activeConsumer === undefined,
    'failed deep evaluation must restore reactive context',
  );

  const wideRuntime = new ReactiveRuntime();
  const values = Array.from(
    {length: 4_000},
    (_, index) => new ReactiveValue(wideRuntime, `wide-${index}`, index),
  );
  const sum = new ReactiveComputed(wideRuntime, 'sum', () =>
    values.reduce((total, value) => total + value.value, 0),
  );

  const initial = sum.value;
  values[0]!.value = -1;
  assert(sum.value === initial - 1, 'wide dependency reconciliation should remain correct');
  assert(sum.node.producerCount === values.length, 'wide computed should retain every producer');
}

function verifyNodeTypeContract(): void {
  new Node('default-string');
  new Node('explicit-string', 'payload');
  new Node('typed', {name: 'Ada'});

  // @ts-expect-error Non-string payloads are required.
  new Node<{name: string}>('missing-payload');
}

testRuntimeDisposesOwnersAndCustomWork();
testNodeDisposalCancelsPendingChange();
testRuntimeIsolationAndUniqueIds();
testBatchErrorFinalization();
testSchedulerErrorAndReentrancyContracts();
testComputedDepthLimitAndWideDependencies();
void verifyNodeTypeContract;
