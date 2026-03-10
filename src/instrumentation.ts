import type { Attributes } from "@opentelemetry/api"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino"
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis-4"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import {
  ParentBasedSampler,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions"

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318"
const serviceName = process.env.OTEL_SERVICE_NAME || "polinetwork-telegram-bot"
const storageRate = Number.parseFloat(process.env.OTEL_STORAGE_SAMPLE_RATE || "0.1")
const nodeEnv = process.env.NODE_ENV || "development"

/**
 * Custom sampler that always traces high-importance spans (commands, automod)
 * and samples storage/caching operations at a configurable rate.
 */
class BotSampler implements Sampler {
  private ratioSampler = new TraceIdRatioBasedSampler(storageRate)

  shouldSample(
    context: Parameters<Sampler["shouldSample"]>[0],
    traceId: string,
    _spanName: string,
    _spanKind: Parameters<Sampler["shouldSample"]>[3],
    attributes: Attributes
  ): SamplingResult {
    const importance = attributes["bot.importance"] as string | undefined

    if (importance === "high") {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED }
    }

    if (importance === "low") {
      return this.ratioSampler.shouldSample(context, traceId)
    }

    // Default: always sample (covers auto-instrumented HTTP, Redis, etc.)
    return { decision: SamplingDecision.RECORD_AND_SAMPLED }
  }

  toString(): string {
    return `BotSampler{storageRate=${storageRate}}`
  }
}

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "unknown",
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: nodeEnv,
  }),
  sampler: new ParentBasedSampler({ root: new BotSampler() }),
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
  }),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${endpoint}/v1/logs` })),
  instrumentations: [new HttpInstrumentation(), new RedisInstrumentation(), new PinoInstrumentation()],
})

sdk.start()

// Expose shutdown via globalThis so the app can flush telemetry on exit
// without importing this file (which would cause tsup to bundle it twice).
;(globalThis as Record<string, unknown>).__otelShutdown = () => sdk.shutdown()
