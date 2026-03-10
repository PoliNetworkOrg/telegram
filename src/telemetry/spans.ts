import type { Attributes } from "@opentelemetry/api"
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api"

const tracer = trace.getTracer("polinetwork-telegram-bot")

export { tracer }

/**
 * Wraps a function in an OpenTelemetry span. Automatically records exceptions
 * and sets span status on error.
 */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * Starts a new span as a child of the current active span, without creating
 * a new async context. Useful for fire-and-forget spans or when you need
 * to manually control the span lifecycle.
 */
export function startSpan(name: string, attributes: Attributes): Span {
  return tracer.startSpan(name, { attributes }, context.active())
}

/** Records an exception on the currently active span (if any). */
export function recordException(error: unknown): void {
  const span = trace.getActiveSpan()
  if (span) {
    span.recordException(error instanceof Error ? error : new Error(String(error)))
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
  }
}
