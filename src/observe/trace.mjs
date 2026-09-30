/**
 * Langfuse tracing for the LLM advisor.
 *
 * Three rules shaped this file.
 *
 * 1. Observability must never change behaviour. A trace that fails to send is a
 *    tracing problem, not a watchdog problem, so every failure here is swallowed
 *    and logged at debug. If Langfuse is down, the watchdog keeps working.
 *
 * 2. Loading is lazy. The daemon is a long-running process that watches every
 *    terminal; paying to parse OpenTelemetry on every boot when tracing is off
 *    is a real cost for no benefit, so the SDK is imported on first use.
 *
 * 3. The advisor's input is terminal output. Terminal output is where secrets
 *    end up by accident -- an echoed env var, a failed curl with a token in the
 *    URL. So prompts and completions go through the same redaction the capture
 *    layer already uses, and that is not optional to turn off silently.
 */
import { log } from '../core/log.mjs';
import { redact } from '../capture/stream.mjs';

const TRACER_NAME = 'watchdog';

/** @type {{enabled:boolean, tracer:any, forceFlush:()=>Promise<void>, shutdown:()=>Promise<void>, describe:()=>object}} */
let state = disabled('not initialised');

function disabled(reason) {
  const noop = async () => {};
  return {
    enabled: false,
    tracer: null,
    forceFlush: noop,
    shutdown: noop,
    describe: () => ({ enabled: false, reason }),
  };
}

/**
 * Reads tracing settings from config, then env. Env wins so a one-off run can be
 * traced without editing the project's config file.
 */
export function resolveTracing(cfg = {}) {
  const t = cfg.tracing ?? {};
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY || t.publicKey || null;
  const secretKey = process.env.LANGFUSE_SECRET_KEY || t.secretKey || null;
  const baseUrl = process.env.LANGFUSE_BASE_URL || t.baseUrl || 'https://cloud.langfuse.com';
  // An explicit off switch. Credentials alone must not be the only way to stop,
  // because a test harness inherits the same global config as the real daemon
  // and would otherwise ship its deliberately-fake transcripts to the project.
  if (process.env.WD_TRACING === 'off') {
    return {
      enabled: false,
      configured: false,
      publicKey: null,
      secretKey: null,
      baseUrl,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || t.environment || 'local',
      redact: t.redact !== false,
      reason: 'disabled by WD_TRACING=off',
    };
  }
  return {
    // Credentials are the real gate. An enabled flag with no keys is a config
    // mistake, and treating it as "on" would mean silently dropping every span.
    enabled: Boolean(publicKey && secretKey),
    configured: Boolean(t.enabled || process.env.LANGFUSE_PUBLIC_KEY),
    publicKey,
    secretKey,
    baseUrl,
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || t.environment || 'local',
    redact: t.redact !== false,
    reason: null,
  };
}

/**
 * Idempotent. Returns the tracing handle; never throws.
 */
export async function initTracing(cfg = {}) {
  if (state.enabled) return state;
  const r = resolveTracing(cfg);
  if (!r.enabled) {
    state = disabled(r.reason || (r.configured ? 'enabled but LANGFUSE_PUBLIC_KEY/SECRET_KEY are missing' : 'not configured'));
    return state;
  }

  try {
    // Imported here, not at the top, so an untraced run never loads OTel.
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
    const { LangfuseSpanProcessor } = await import('@langfuse/otel');

    const processor = new LangfuseSpanProcessor({
      publicKey: r.publicKey,
      secretKey: r.secretKey,
      baseUrl: r.baseUrl,
      environment: r.environment,
      // immediate, not batched: a daemon can be killed at any moment, and a
      // batched buffer is exactly the data that dies with the process.
      exportMode: 'immediate',
      timeout: 5,
    });

    // The optional in-memory exporter is used by tests to assert on real spans.
    let memory = null;
    const spanProcessors = [processor];
    if (process.env.WD_TRACE_MEMORY === '1') {
      memory = new InMemorySpanExporter();
      spanProcessors.push(new SimpleSpanProcessor(memory));
    }

    // OpenTelemetry SDK v2 removed addSpanProcessor(); processors are constructor
    // config now. Calling the old method throws TypeError, which is why this is
    // built before the provider rather than bolted on.
    const provider = new BasicTracerProvider({ spanProcessors });
    const tracer = provider.getTracer(TRACER_NAME, '0.1.0');

    state = {
      enabled: true,
      tracer,
      memory,
      forceFlush: async () => {
        try {
          await processor.forceFlush();
        } catch (e) {
          log.debug('tracing flush failed: ' + e.message);
        }
      },
      shutdown: async () => {
        try {
          await processor.shutdown();
        } catch (e) {
          log.debug('tracing shutdown failed: ' + e.message);
        }
      },
      describe: () => ({ enabled: true, baseUrl: r.baseUrl, environment: r.environment, redact: r.redact }),
    };
    log.info(`langfuse tracing on: ${r.baseUrl} env=${r.environment} redact=${r.redact}`);
    return state;
  } catch (e) {
    // A missing or broken SDK must not stop the daemon from starting.
    state = disabled('initialisation failed: ' + e.message);
    log.debug('langfuse tracing unavailable: ' + e.message);
    return state;
  }
}

export function tracing() {
  return state;
}

/** Test seam: drop cached state so a test can re-init with different config. */
export function resetTracing() {
  state = disabled('reset');
}

function safe(s, doRedact) {
  if (typeof s !== 'string') return s;
  const clipped = s.length > 8000 ? s.slice(0, 8000) + '\n...[clipped]' : s;
  return doRedact ? redact(clipped) : clipped;
}

/**
 * Wraps one advisor review in a Langfuse generation observation.
 *
 * The span records the decision the watchdog actually made, not just the model's
 * text: the verdict, whether a fix was proposed, and the status of any provider
 * failure. Those are the fields you actually want when asking "why did it
 * decide that was noise" -- and a provider 402 must be visible as a provider
 * error rather than as a model confidently saying "unsure".
 */
export async function traceAdvisorReview({ cfg, sessionId, title, cwd, model, evidence, run }) {
  const handle = await initTracing(cfg);
  if (!handle.enabled) return run();

  const doRedact = resolveTracing(cfg).redact;
  const span = handle.tracer.startSpan('watchdog.advisor.review');
  const t0 = Date.now();

  let result;
  try {
    span.setAttribute('langfuse.trace.name', `advisor: ${String(title).slice(0, 120)}`);
    span.setAttribute('langfuse.observation.type', 'generation');
    span.setAttribute('gen_ai.system', 'opencode');
    if (model) span.setAttribute('gen_ai.request.model', String(model));
    span.setAttribute('langfuse.observation.input', safe(evidence, doRedact));
    span.setAttribute('langfuse.observation.metadata', { cwd, title: String(title).slice(0, 200) });
    if (sessionId) span.setAttribute('langfuse.trace.session.id', String(sessionId));

    result = await run();
  } catch (e) {
    span.setAttribute('langfuse.observation.level', 'ERROR');
    span.setAttribute('langfuse.observation.status_message', e.message);
    span.recordException(e);
    span.end();
    await handle.forceFlush();
    // The caller is not insulated from a real failure, but tracing is not the
    // reason for it: rethrow only what `run` itself threw.
    throw e;
  }

  try {
    const ms = Date.now() - t0;
    span.setAttribute('gen_ai.usage.input_tokens', Number(result?.usageIn ?? 0));
    span.setAttribute('gen_ai.usage.output_tokens', Number(result?.usageOut ?? 0));
    span.setAttribute('watchdog.verdict', String(result?.verdict ?? 'unknown'));
    span.setAttribute('watchdog.confidence', Number(result?.confidence ?? 0));
    span.setAttribute('watchdog.proposed_fix', Boolean(result?.fix));
    span.setAttribute('watchdog.status', String(result?.status ?? 'ok'));
    span.setAttribute('langfuse.observation.output', safe(result?.summary ?? result?.raw ?? '', doRedact));

    if (result?.status) {
      // A provider failure is not a model opinion. Marking it as a warning keeps
      // "the model said unsure" and "we could not afford to ask" distinguishable
      // in the traces, which is the whole reason these fields exist.
      span.setAttribute('langfuse.observation.level', 'WARNING');
      span.setAttribute('langfuse.observation.status_message', String(result?.error ?? result?.summary ?? ''));
    }
    span.end();
    await handle.forceFlush();
  } catch (e) {
    // Recording the outcome is best-effort and must not mask the real result.
    log.debug('failed to finalise advisor span: ' + e.message);
    try {
      span.end();
    } catch {
      /* ignore */
    }
  }

  return result;
}
