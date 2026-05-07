/**
 * Copyright (c) 2026 Ozura Inc.
 * Licensed under the MIT License — see ./LICENSE.
 *
 * @ozura/storefront-sdk
 *
 * Server-side SDK for the Ozura storefront API. Lets any backend (Conjure
 * builder, Replit project, custom Node service, agentic dev workflows) read
 * a merchant's product catalog, mint cart-style payment links, and tail
 * orders.
 *
 * **Server-side only.** The constructor takes an `oz_sf_…` key that grants
 * scoped access to a single merchant's storefront — never bundle this with
 * browser code, never log it, never expose it to a client. The SDK
 * intentionally has no browser build.
 */

export const SDK_VERSION = "0.3.0";

/**
 * Default Ozura storefront API base. Currently points at the development
 * vanity URL — the SDK is in early-access and ships against the dev
 * backend until we promote to staging + production. Pass `baseUrl` in
 * the constructor options to override.
 */
const DEFAULT_BASE_URL = "https://dev-api.ozura.com";

export interface OzuraStorefrontOptions {
  /** Storefront API key (`oz_sf_…`). Required. */
  apiKey: string;
  /**
   * Override the API base URL. Defaults to `https://dev-api.ozura.com`
   * during early-access; will move to `https://api.ozura.com` once the
   * SDK promotes to staging and again when production lands. Sandbox
   * keys (`oz_sf_…`) are sandbox-only in v1 — production-scoped keys
   * arrive later, at which point the SDK will auto-detect from the key
   * prefix and route accordingly.
   */
  baseUrl?: string;
  /** Optional fetch implementation override (Node 18+ has it global). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  timeoutMs?: number;
}

/** Item shape for cart-link creation. */
export interface CartItemInput {
  /** Optional Ozura ProductId. If omitted the SDK doesn't synthesize one
   *  on this side — the backend assigns a synthetic id at create time. */
  productId?: string;
  name: string;
  qty: number;
  unitPrice: number;
  imageUrl?: string;
  /**
   * When set, the cart-link is minted as a recurring-checkout session
   * instead of a one-shot cart. Pass through the {@link
   * StorefrontProductRecurring} sub-doc you got from `getProducts()` to
   * keep the cycle config intact. Mixing recurring and one-off items in
   * a single cart is not supported in v1 — split into separate
   * `createCart()` calls.
   */
  recurring?: StorefrontProductRecurring;
}

export interface CreateCartInput {
  items: CartItemInput[];
  /**
   * URL the customer's browser is redirected to after a successful
   * checkout. **This is the only required URL.** The Ozura backend wraps
   * it through `/checkout-return` so an Order row is written before the
   * redirect lands here.
   *
   * Treat this as a server endpoint on YOUR backend — it receives the
   * transaction details as query params (transactionId, amount, currency,
   * cardLastFour, etc.). Verify `transactionId` via `verifyOrder()`
   * before fulfilling: the redirect is a browser GET and is tamper-able.
   */
  successUrl: string;
  cancelUrl?: string;
  errorUrl?: string;
  /** Merchant-visible label on the resulting PaymentLink shadow. */
  name?: string;
  expiresInDays?: number;
  usageLimit?: number;
  /** Force the checkout to collect a shipping address. Auto-set on
   *  product-backed links when the underlying product has
   *  `requiresShipping: true`. */
  collectShippingAddress?: boolean;
}

export interface CreateCartResult {
  paymentLinkId: string;
  paymentLinkCode: string;
  url: string;
  expiresAt: string | null;
  currency: string;
  amount: number;
}

/**
 * Optional subscription / recurring-billing config on a product. When
 * present the parent product's `price` is the **per-cycle amount** (not
 * a one-time charge); customers are enrolled into a recurring schedule
 * at checkout. SDK consumers (Conjure, Replit integrations, custom
 * Node services) should render a "$29.99 / mo" pill instead of a plain
 * price when this is set.
 */
export interface StorefrontProductRecurring {
  interval: "daily" | "weekly" | "monthly" | "yearly";
  intervalCount?: number;
  /** YYYY-MM-DD; absent means "starts at checkout time". */
  startDate?: string;
  /** YYYY-MM-DD; absent means open-ended. */
  endDate?: string;
  /** Total billing cycles cap; absent means open-ended. */
  maxCycles?: number;
  /** One-time charge added at enrollment (e.g. activation fee). */
  setupFee?: number;
  /** Introductory pricing — `initialAmount` charged for the first
   *  `initialCycles` cycles, then the regular `price` takes over. */
  initialAmount?: number;
  initialCycles?: number;
  /** Florida-capped at 3.00. Optional surcharge % added each cycle. */
  surchargePercent?: number;
  /** Merchant-side external reference; surfaced on processor records. */
  merchantRecurringReference?: string;
}

export interface StorefrontProduct {
  _id: string;
  name: string;
  description?: string;
  /**
   * Per-cycle amount when `recurring` is set; one-time charge otherwise.
   */
  price: number;
  currency: string;
  imageUrl?: string;
  tags?: string[];
  group?: string;
  sku?: string;
  /** Brand the product is sold under, e.g. "Nike". */
  brand?: string;
  /** Product type / category, e.g. "shirt", "ebook". Distinct from
   *  `group` (which is the merchant's collection bucketing). */
  productType?: string;
  /** Arbitrary string-keyed attributes set by the merchant (color,
   *  size, material, country-of-origin, etc.). Capped server-side at
   *  50 entries with ≤200 char keys/values. */
  metadata?: Record<string, string>;
  /**
   * When present this product is a subscription. Absent = one-time
   * charge. See {@link StorefrontProductRecurring}.
   */
  recurring?: StorefrontProductRecurring;
  inStock?: boolean;
  tracksInventory?: boolean;
  available?: number;
}

export type OrderStatus = "paid" | "fulfilled" | "refunded";

export interface OrderItem {
  productId?: string;
  name: string;
  imageUrl?: string;
  qty: number;
  unitPrice: number;
}

export interface Order {
  _id: string;
  transactionId: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  paidAt: string;
  fulfilledAt?: string;
  refundedAt?: string;
  refundedAmount?: number;
  productName?: string;
  productImageUrl?: string;
  items?: OrderItem[];
  paymentLinkCode?: string;
  createdAt: string;
  updatedAt: string;
  /** Only present when the key has the `storefront:orders:full` scope. */
  cardLastFour?: string;
  cardBrand?: string;
  shipping?: {
    name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
}

export interface ListOrdersInput {
  /**
   * Cursor — return orders with `updatedAt > since`. Pass the previous
   * call's `nextSince` to chain. ISO 8601 string with millisecond precision.
   */
  since?: string;
  status?: OrderStatus;
  paymentLinkCode?: string;
  /** 1..100, defaults to 50 server-side. */
  limit?: number;
}

export interface ListOrdersResult {
  data: Order[];
  /** ISO 8601 timestamp to pass as `since` on the next call. */
  nextSince: string | null;
  /** True when the server has more rows beyond this batch. */
  hasMore: boolean;
}

export interface ListProductsInput {
  /** Match products with ANY of these tags. */
  tags?: string[];
  /** Match products in ANY of these groups. */
  groups?: string[];
  /** Match products with ANY of these brands. */
  brands?: string[];
  /** Match products with ANY of these productTypes. */
  productTypes?: string[];
  /**
   * Match products whose metadata contains ALL of these key/value
   * pairs. Example: `{ color: "red", size: "M" }` matches products
   * with `metadata.color === "red"` AND `metadata.size === "M"`.
   */
  metadata?: Record<string, string>;
  /** Exact ID set (overrides other filters' breadth). */
  ids?: string[];
  /** Filter to a specific website builder site. */
  websiteId?: string;
  /** 1..100, defaults to 50. */
  limit?: number;
  /** Set false to skip stock fields on the response (smaller payload
   *  for SEO scrapers / search-indexers). */
  includeStock?: boolean;
}

/** Thrown for non-2xx responses from the Ozura storefront API. */
export class OzuraApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;
  constructor(status: number, message: string, body?: unknown, code?: string) {
    super(message);
    this.name = "OzuraApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/**
 * The SDK entry point. Construct with an `oz_sf_…` key, call methods.
 * Stateless beyond the key + base URL — safe to share across requests.
 */
export class OzuraStorefront {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OzuraStorefrontOptions) {
    if (!options.apiKey) {
      throw new Error("OzuraStorefront: apiKey is required");
    }
    if (!options.apiKey.startsWith("oz_sf_")) {
      throw new Error(
        "OzuraStorefront: apiKey must start with `oz_sf_` — pass the storefront key minted in the Ozura dashboard, not a PayAPI key.",
      );
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl =
      options.fetch ??
      (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined!);
    if (!this.fetchImpl) {
      throw new Error(
        "OzuraStorefront: no fetch implementation. Use Node 18+ or pass `fetch` in options.",
      );
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Read products from the merchant's catalog. Filters are AND-across,
   * OR-within (e.g. `tags: ['a', 'b'], groups: ['hats']` = "(a OR b) AND
   * in hats"). Merchant identity comes from your API key, no merchantId
   * needed.
   */
  async getProducts(input: ListProductsInput = {}): Promise<StorefrontProduct[]> {
    const params = new URLSearchParams();
    if (input.tags?.length) params.set("tags", input.tags.join(","));
    if (input.groups?.length) params.set("groups", input.groups.join(","));
    if (input.brands?.length) params.set("brands", input.brands.join(","));
    if (input.productTypes?.length)
      params.set("productTypes", input.productTypes.join(","));
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      // URL-encoded JSON. The backend AND-matches across keys.
      params.set("metadata", JSON.stringify(input.metadata));
    }
    if (input.ids?.length) params.set("ids", input.ids.join(","));
    if (input.websiteId) params.set("websiteId", input.websiteId);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.includeStock === false) params.set("includeStock", "false");

    const path = `/api/storefront/products${
      params.toString() ? `?${params}` : ""
    }`;
    const res = await this.request<{ products: StorefrontProduct[] }>("GET", path);
    return res.products ?? [];
  }

  /**
   * Mint a cart-style payment link. Returns the URL the merchant should
   * redirect the customer to. Treat the URL as opaque — its format is
   * `https://stag-checkout.ozura.com/pay/pl_<hex>` today and may change.
   */
  async createCart(input: CreateCartInput): Promise<CreateCartResult> {
    if (!input.items?.length) {
      throw new Error("createCart: items array is required");
    }
    if (!input.successUrl) {
      throw new Error(
        "createCart: successUrl is required (treat it as a server endpoint on your backend, not a browser destination)",
      );
    }
    const res = await this.request<{ data: CreateCartResult }>(
      "POST",
      "/api/storefront/cart-links",
      {
        body: input,
      },
    );
    return res.data;
  }

  /**
   * Tail orders. Pass `since` to get only orders updated after that
   * timestamp; chain with `nextSince` from the previous call. Polls
   * 5–15 minutes is a reasonable cadence for refund / fulfillment
   * detection — webhook support lands in v2.
   *
   * Always idempotent on `transactionId` — a retried call may include
   * a boundary record from the previous batch.
   */
  async listOrders(input: ListOrdersInput = {}): Promise<ListOrdersResult> {
    const params = new URLSearchParams();
    if (input.since) params.set("since", input.since);
    if (input.status) params.set("status", input.status);
    if (input.paymentLinkCode) params.set("paymentLinkCode", input.paymentLinkCode);
    if (input.limit !== undefined) params.set("limit", String(input.limit));

    const path = `/api/storefront/orders${
      params.toString() ? `?${params}` : ""
    }`;
    const res = await this.request<{
      data: Order[];
      nextSince: string | null;
      hasMore: boolean;
    }>("GET", path);
    return {
      data: res.data ?? [],
      nextSince: res.nextSince ?? null,
      hasMore: !!res.hasMore,
    };
  }

  /**
   * Verify an order via its transactionId. Use this on the merchant's
   * `successUrl` handler **before fulfilling** — the redirect carrying
   * the transactionId is a browser GET and is tamper-able. This call
   * confirms the order exists for your merchant and returns its server
   * state. Throws an `OzuraApiError` with status 404 when the
   * transactionId doesn't belong to your merchant.
   */
  async verifyOrder(transactionId: string): Promise<Order> {
    if (!transactionId) {
      throw new Error("verifyOrder: transactionId is required");
    }
    const res = await this.request<{ data: Order }>(
      "GET",
      `/api/storefront/orders/${encodeURIComponent(transactionId)}`,
    );
    return res.data;
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; includeAuth?: boolean } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
      };
      if (opts.includeAuth !== false) {
        headers.authorization = `Bearer ${this.apiKey}`;
      }
      if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
      }

      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // non-JSON body — keep parsed undefined, attach raw text below
        }
      }

      if (!res.ok) {
        const message =
          (parsed as { message?: string; error?: string } | undefined)
            ?.message ??
          (parsed as { message?: string; error?: string } | undefined)
            ?.error ??
          `Ozura storefront request failed (${res.status})`;
        throw new OzuraApiError(res.status, message, parsed ?? text);
      }

      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export default OzuraStorefront;
