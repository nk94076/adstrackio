import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * The actual outbound HTTP call for one webhook delivery (Phase 11: API +
 * Integrations) — see docs/api/webhooks.md#ssrf-protection.
 *
 * Connects to `pinnedAddress` (a specific IP already validated safe by
 * packages/shared/src/webhook-url.ts, resolved immediately before this
 * call) via a custom `lookup` override, rather than letting Node re-
 * resolve `url`'s hostname itself — this is what actually closes the
 * DNS-rebinding gap: even if the hostname's DNS record changes between
 * validation and this call, the TCP connection still only ever goes to
 * the address that was checked. TLS certificate verification is
 * unaffected — `servername`/SNI still uses the real hostname (Node's
 * default), so a certificate for the wrong host still fails normally.
 *
 * Redirects are never followed. A 3xx response is treated like any other
 * status code (recorded, not retried as a redirect) — deliberately
 * simpler and safer than re-validating a redirect target's own SSRF
 * safety on every hop.
 */
export interface SendWebhookHttpRequestOptions {
  url: string;
  pinnedAddress: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookHttpResult {
  status: number;
  bodySnippet: string;
}

/** Hard ceiling on how much of a response body is ever buffered — a
 * malicious or misconfigured endpoint streaming gigabytes back must not
 * exhaust this process's memory. */
const MAX_BUFFERED_BYTES = 64 * 1024;
const RESPONSE_SNIPPET_BYTES = 2 * 1024;

export async function sendWebhookHttpRequest(
  options: SendWebhookHttpRequestOptions,
): Promise<WebhookHttpResult> {
  const parsed = new URL(options.url);
  const isHttps = parsed.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const isIpv6 = options.pinnedAddress.includes(":");

  return new Promise<WebhookHttpResult>((resolve, reject) => {
    const requestOptions: RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: "POST",
      headers: { ...options.headers, Host: parsed.hostname },
      timeout: options.timeoutMs,
      lookup: (_hostname, _lookupOptions, callback) => {
        callback(null, options.pinnedAddress, isIpv6 ? 6 : 4);
      },
    };

    const req = requestFn(requestOptions, (res) => {
      let receivedBytes = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (chunks.reduce((sum, c) => sum + c.length, 0) < MAX_BUFFERED_BYTES) {
          chunks.push(chunk);
        }
        if (receivedBytes > MAX_BUFFERED_BYTES * 8) {
          req.destroy(new Error("Webhook response exceeded the maximum allowed size"));
        }
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).subarray(0, RESPONSE_SNIPPET_BYTES).toString("utf8");
        resolve({ status: res.statusCode ?? 0, bodySnippet: body });
      });
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy(new Error("Webhook request timed out"));
    });
    req.on("error", (error) => reject(error));
    req.write(options.body);
    req.end();
  });
}

/**
 * Retry classification (Phase 11) — see docs/api/webhooks.md#retries.
 * Retries on network-level failures, timeouts, 408, 429, and any 5xx.
 * Never retries a normal 4xx validation failure (400, 401, 403, 404,
 * 422, ...): those mean the destination understood and rejected the
 * request, and retrying an unchanged payload would just fail identically
 * every time.
 */
export function isRetryableWebhookFailure(status: number | null, networkError: boolean): boolean {
  if (networkError || status === null) {
    return true;
  }
  return status === 408 || status === 429 || status >= 500;
}
