import {SpanStatusCode, context, trace} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  ReactiveComputed,
  ReactiveEffect,
  ReactiveRuntime,
  ReactiveValue,
} from '../../reactive/index.js';
import {createOpenTelemetryPlugin} from '../opentelemetry.js';
import {ensure} from '../../../test/assert.js';

function createTracer(): {
  exporter: InMemorySpanExporter;
  tracer: ReturnType<BasicTracerProvider['getTracer']>;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({spanProcessors: [new SimpleSpanProcessor(exporter)]});
  return {exporter, tracer: provider.getTracer('grafyx-test')};
}

function testBatchAndComputationSpansNest(): void {
  const {exporter, tracer} = createTracer();
  const runtime = new ReactiveRuntime();
  runtime.use(
    createOpenTelemetryPlugin({
      tracer,
      parentContext: (span) => trace.setSpan(context.active(), span),
    }),
  );

  const source = new ReactiveValue(runtime, 'source', 1);
  const doubled = new ReactiveComputed(runtime, 'doubled', () => source.value * 2);
  const seen: number[] = [];
  const effect = new ReactiveEffect(runtime, 'effect', () => {
    seen.push(doubled.value);
  });

  runtime.batch(() => {
    effect.run();
    source.value = 2;
  });

  const spans = exporter.getFinishedSpans();
  const batch = spans.find((span) => span.name === 'grafyx.batch');
  const effectSpan = spans.find((span) => span.name === 'grafyx.effect');
  const computedSpan = spans.find((span) => span.name === 'grafyx.computed');

  ensure(batch !== undefined, 'outermost batches should produce a span');
  ensure(effectSpan !== undefined, 'effect runs should produce a span');
  ensure(computedSpan !== undefined, 'computed evaluations should produce a span');
  ensure(
    effectSpan.parentSpanContext?.spanId === batch.spanContext().spanId,
    'effect spans should nest under the active batch span',
  );
  ensure(
    computedSpan.parentSpanContext?.spanId === effectSpan.spanContext().spanId,
    'computed spans should nest under the computation that read them',
  );
  ensure(
    computedSpan.attributes['grafyx.node.id'] === 'doubled',
    'computation spans should identify their node',
  );
  ensure(
    batch.attributes['grafyx.batch.changed_nodes'] === 1,
    'batch spans should record the number of changed nodes',
  );
  ensure(
    batch.events.some(
      (event) =>
        event.name === 'grafyx.node-invalidated' &&
        event.attributes?.['grafyx.path'] === 'source > doubled',
    ),
    'invalidations should be recorded on the active span with their causal path',
  );
  ensure(seen.join(',') === '2', 'instrumentation should not change reactive behavior');
}

function testFailedComputationsSetErrorStatus(): void {
  const {exporter, tracer} = createTracer();
  const runtime = new ReactiveRuntime();
  runtime.use(createOpenTelemetryPlugin({tracer, recordInvalidations: false}));

  const failing = new ReactiveComputed(runtime, 'failing', () => {
    throw new Error('boom');
  });

  try {
    void failing.value;
  } catch {
    // Expected.
  }

  const [span] = exporter.getFinishedSpans();
  ensure(span?.status.code === SpanStatusCode.ERROR, 'failed computations should be errors');
  ensure(span.status.message === 'boom', 'error spans should carry the failure message');
  ensure(span.parentSpanContext === undefined, 'without parentContext spans are roots');
}

function testUninstallEndsOpenSpans(): void {
  const {exporter, tracer} = createTracer();
  const runtime = new ReactiveRuntime();
  const uninstall = runtime.use(createOpenTelemetryPlugin({tracer}));

  runtime.batch(() => {
    uninstall();
  });

  ensure(exporter.getFinishedSpans().length === 1, 'removing the plugin should end open spans');
  ensure(!runtime.isObserved, 'removing the plugin should unsubscribe from runtime events');
}

testBatchAndComputationSpansNest();
testFailedComputationsSetErrorStatus();
testUninstallEndsOpenSpans();
