import { redactSecrets } from "./redact.js";

export interface Paging {
  total: number;
  offset: number;
  limit: number;
}

export interface RateLimit {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

export interface PrintfulResult<T> {
  result: T;
  paging?: Paging;
  rateLimit: RateLimit;
}

export class PrintfulApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "PrintfulApiError";
    this.status = status;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export type Sleep = (ms: number) => Promise<void>;

export interface PrintfulClientOptions {
  token: string;
  storeId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  /** Extra random delay added after Retry-After. Tests can pin this to 0. */
  jitterMs?: () => number;
  maxRateLimitRetries?: number;
  /** Do not block the caller longer than this on a single 429. */
  maxRateLimitWaitMs?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_WAIT_MS = 5_000;

function headerNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseRetryAfterSeconds(header: string | null, nowMs = Date.now()): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, (dateMs - nowMs) / 1000);
}

function toQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function encodeResourceId(id: string | number): string {
  return encodeURIComponent(String(id)).replace(/%40/g, "@");
}

function readRateLimit(headers: Headers): RateLimit {
  const rateLimit: RateLimit = {};
  const limit = headerNumber(headers.get("x-ratelimit-limit"));
  const remaining = headerNumber(headers.get("x-ratelimit-remaining"));
  const resetSeconds = headerNumber(headers.get("x-ratelimit-reset"));
  if (limit !== undefined) rateLimit.limit = limit;
  if (remaining !== undefined) rateLimit.remaining = remaining;
  if (resetSeconds !== undefined) rateLimit.resetSeconds = resetSeconds;
  return rateLimit;
}

function formatError(status: number, body: string, retryAfterSeconds: number | undefined): string {
  let detail = body.trim().slice(0, 500);
  try {
    const parsed = JSON.parse(body) as {
      result?: unknown;
      error?: { reason?: unknown; message?: unknown };
    };
    const message =
      typeof parsed.error?.message === "string"
        ? parsed.error.message
        : typeof parsed.result === "string"
          ? parsed.result
          : undefined;
    const reason = typeof parsed.error?.reason === "string" ? parsed.error.reason : undefined;
    if (message) {
      detail = reason && reason !== message ? `${reason}: ${message}` : message;
    }
  } catch {
    // Keep the trimmed body when Printful does not return JSON.
  }

  if (status === 429) {
    const wait =
      retryAfterSeconds === undefined ? "the time in the Retry-After header" : String(retryAfterSeconds);
    return `Printful rate limit reached (429). Wait ${wait} seconds, then retry the same call. The request was not processed. ${detail}`.trim();
  }

  if (!detail) {
    return `Printful API request failed (${status}).`;
  }
  return `Printful API request failed (${status}). ${detail}`;
}

export class PrintfulClient {
  private readonly token: string;
  private readonly storeId?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;
  private readonly jitterMs: () => number;
  private readonly maxRateLimitRetries: number;
  private readonly maxRateLimitWaitMs: number;

  constructor(options: PrintfulClientOptions) {
    if (!options.token.trim()) {
      throw new Error("PrintfulClient requires a non-empty token.");
    }
    this.token = options.token.trim();
    this.baseUrl = (options.baseUrl ?? "https://api.printful.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.jitterMs = options.jitterMs ?? (() => Math.floor(Math.random() * 250));
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RETRIES;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? DEFAULT_MAX_WAIT_MS;
    if (options.storeId?.trim()) {
      this.storeId = options.storeId.trim();
    }
  }

  listStores(): Promise<PrintfulResult<unknown>> {
    return this.request("GET", "/stores");
  }

  listCatalogProducts(categoryId?: string): Promise<PrintfulResult<unknown>> {
    return this.request("GET", "/products", {
      query: { category_id: categoryId },
    });
  }

  getProduct(productId: number): Promise<PrintfulResult<unknown>> {
    return this.request("GET", `/products/${encodeResourceId(productId)}`);
  }

  getVariant(variantId: number): Promise<PrintfulResult<unknown>> {
    return this.request("GET", `/products/variant/${encodeResourceId(variantId)}`);
  }

  getShippingRates(body: unknown): Promise<PrintfulResult<unknown>> {
    return this.request("POST", "/shipping/rates", { body });
  }

  estimateOrderCosts(body: unknown): Promise<PrintfulResult<unknown>> {
    return this.request("POST", "/orders/estimate-costs", { body });
  }

  /**
   * Always creates a draft. The confirm query is forced off and any confirm
   * field on the body is removed so this method cannot submit an order.
   */
  createDraftOrder(body: unknown): Promise<PrintfulResult<unknown>> {
    const payload = isRecord(body) ? { ...body } : {};
    delete payload.confirm;
    return this.request("POST", "/orders", {
      query: { confirm: false },
      body: payload,
    });
  }

  confirmOrder(orderId: string | number): Promise<PrintfulResult<unknown>> {
    return this.request("POST", `/orders/${encodeResourceId(orderId)}/confirm`);
  }

  cancelOrder(orderId: string | number): Promise<PrintfulResult<unknown>> {
    return this.request("DELETE", `/orders/${encodeResourceId(orderId)}`);
  }

  getOrder(orderId: string | number): Promise<PrintfulResult<unknown>> {
    return this.request("GET", `/orders/${encodeResourceId(orderId)}`);
  }

  listOrders(query: Query): Promise<PrintfulResult<unknown>> {
    return this.request("GET", "/orders", { query });
  }

  listSyncProducts(query: Query): Promise<PrintfulResult<unknown>> {
    return this.request("GET", "/sync/products", { query });
  }

  createSyncProduct(body: unknown): Promise<PrintfulResult<unknown>> {
    return this.request("POST", "/store/products", { body });
  }

  uploadFile(body: unknown): Promise<PrintfulResult<unknown>> {
    return this.request("POST", "/files", { body });
  }

  createMockupTask(productId: number, body: unknown): Promise<PrintfulResult<unknown>> {
    return this.request("POST", `/mockup-generator/create-task/${encodeResourceId(productId)}`, { body });
  }

  getMockupTask(taskKey: string): Promise<PrintfulResult<unknown>> {
    return this.request("GET", "/mockup-generator/task", { query: { task_key: taskKey } });
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<PrintfulResult<T>> {
    const secrets = [this.token];
    const url = `${this.baseUrl}${path}${toQuery(options.query)}`;
    if (url.includes(this.token)) {
      throw new PrintfulApiError("Refusing to send the API token in the request URL.", 0);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "User-Agent": "printful-mcp/0.1.0",
    };
    if (this.storeId) headers["X-PF-Store-Id"] = this.storeId;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Network request failed";
        throw new PrintfulApiError(
          redactSecrets(`Printful request could not be completed. ${message}`, secrets),
          0,
        );
      }

      const rawBody = await response.text();
      const body = redactSecrets(rawBody, secrets);
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));

      if (response.status === 429 && attempt < this.maxRateLimitRetries) {
        const waitMs = Math.ceil((retryAfterSeconds ?? 1) * 1000);
        if (waitMs <= this.maxRateLimitWaitMs) {
          await this.sleep(waitMs + this.jitterMs());
          attempt += 1;
          continue;
        }
      }

      if (!response.ok) {
        throw new PrintfulApiError(
          redactSecrets(formatError(response.status, body, retryAfterSeconds), secrets),
          response.status,
          retryAfterSeconds,
        );
      }

      let parsed: { code?: number; result?: T; paging?: Paging; error?: { message?: string } };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        throw new PrintfulApiError(
          `Printful returned a non-JSON response (${response.status}).`,
          response.status,
        );
      }

      if (typeof parsed.code === "number" && parsed.code >= 400) {
        throw new PrintfulApiError(
          redactSecrets(formatError(parsed.code, body, retryAfterSeconds), secrets),
          parsed.code,
          retryAfterSeconds,
        );
      }

      return {
        result: parsed.result as T,
        ...(parsed.paging ? { paging: parsed.paging } : {}),
        rateLimit: readRateLimit(response.headers),
      };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
