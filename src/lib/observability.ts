/**
 * Observability — Sentry init + a thin capture helper.
 *
 * Sentry is OPTIONAL. When SENTRY_DSN isn't set, init() does nothing and
 * captureError() falls through to console.error. Lets local dev and
 * cost-sensitive deploys skip the integration entirely.
 *
 * Environment is read at init time, NOT lazily, so make sure init() is
 * called AFTER dotenv.config() in the entry script.
 *
 * Phase 9.2 hardening:
 *   - sendDefaultPii: false — Sentry SDK won't auto-attach user IPs,
 *     cookies, Authorization headers, request body.
 *   - beforeSend / beforeBreadcrumb hooks strip credentials from any
 *     URLs we might log (?token=, ?code=) and remove Bearer headers.
 */

import * as Sentry from "@sentry/node";

let initialized = false;

/** Strip credentials from URL query strings before they hit Sentry. */
function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  // Replace ?token=... &code=... ?access_token=... etc. with [redacted]
  return url.replace(
    /([?&](?:token|code|state|access_token|refresh_token|api_key|key|secret|hottok)=)[^&]+/gi,
    "$1[redacted]",
  );
}

/** Recursively scrub a value: strip Authorization headers and known
 *  credential-bearing URLs. */
function scrubExtras(extras: unknown): unknown {
  if (extras == null) return extras;
  if (Array.isArray(extras)) return extras.map(scrubExtras);
  if (typeof extras !== "object") return extras;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extras as Record<string, unknown>)) {
    const kl = k.toLowerCase();
    if (kl === "authorization" || kl === "cookie" || kl === "set-cookie") {
      out[k] = "[redacted]";
    } else if ((kl === "url" || kl === "href" || kl === "location") && typeof v === "string") {
      out[k] = scrubUrl(v);
    } else if (typeof v === "object") {
      out[k] = scrubExtras(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function initObservability(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.error("[observability] SENTRY_DSN unset — error capture disabled, logs only.");
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.GIT_SHA,
    // Capture 100% of errors; sample 10% of normal transactions.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.consoleIntegration(),
    ],
    beforeSend(event) {
      // Strip credential-bearing URLs from request data
      if (event.request?.url) event.request.url = scrubUrl(event.request.url);
      if (event.request?.headers) {
        const h = event.request.headers as Record<string, string>;
        for (const k of Object.keys(h)) {
          const kl = k.toLowerCase();
          if (kl === "authorization" || kl === "cookie") h[k] = "[redacted]";
        }
      }
      // Same for extras we attached via captureError
      if (event.extra) event.extra = scrubExtras(event.extra) as typeof event.extra;
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data?.url) {
        breadcrumb.data.url = scrubUrl(String(breadcrumb.data.url));
      }
      return breadcrumb;
    },
  });
  initialized = true;
  console.error("[observability] Sentry initialized (PII scrubbing on).");
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  const scrubbed = context ? (scrubExtras(context) as Record<string, unknown>) : context;
  if (!initialized) {
    console.error("[observability] captureError:", err, scrubbed ?? {});
    return;
  }
  Sentry.captureException(err, { extra: scrubbed });
}

export function captureMessage(msg: string, context?: Record<string, unknown>): void {
  const scrubbed = context ? (scrubExtras(context) as Record<string, unknown>) : context;
  if (!initialized) {
    console.error("[observability] captureMessage:", msg, scrubbed ?? {});
    return;
  }
  Sentry.captureMessage(msg, { extra: scrubbed });
}
