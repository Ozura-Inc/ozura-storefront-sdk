# @ozura/storefront-sdk

Server-side SDK for the Ozura storefront API. Read a merchant's catalog, mint cart-style payment links, and tail orders — from any Node 18+ backend.

```bash
npm install @ozura/storefront-sdk
```

## Quick start

```ts
import { OzuraStorefront } from "@ozura/storefront-sdk";

const ozura = new OzuraStorefront({
  apiKey: process.env.OZURA_STOREFRONT_KEY!, // oz_sf_…
});

// Read products
const products = await ozura.getProducts({ groups: ["hats"] });

// Mint a cart link
const cart = await ozura.createCart({
  items: [{ name: "Acme T-Shirt", qty: 2, unitPrice: 19.99 }],
  successUrl: "https://your-backend.example.com/ozura-callback",
});
// Send `cart.url` to your customer

// Tail orders since the last poll
const orders = await ozura.listOrders({ since: lastPolledAt });

// Verify an incoming successUrl callback (browser GET — must not be trusted blindly)
const verified = await ozura.verifyOrder(transactionId);
```

## Server-side only

The SDK takes a key (`oz_sf_…`) that grants scoped read/write to one merchant's storefront. **Never bundle the key with browser code, never log it, never expose it to a client.** The package has no browser build by design — the constructor will throw if your bundler tries to ship it client-side.

Treat the key like a database password. Conjure, Replit, custom Node servers, agentic dev workflows — they all run server-side and proxy SDK calls for the browser.

## How `createCart` actually works

The `successUrl` you pass is the URL **your server** will receive a GET to once the customer pays. The browser hops through Ozura's `/checkout-return` proxy first (so the Order is written + inventory ticks), then redirects to your URL with the transaction details as query params:

```
GET /ozura-callback?success=true
                  &transactionId=2604280000990C64B
                  &sessionId=session_…
                  &amount=39.98
                  &currency=USD
                  &cardLastFour=1111
                  &cardBrand=VISA
                  &transDate=2026-04-30T22:00:15.850Z
                  &shippingAddress={...JSON...}     // when collectShippingAddress=true
                  &metadata={...JSON...}
```

**The redirect is browser-driven and tamper-able.** Always call `verifyOrder(transactionId)` in your handler before fulfilling — it confirms the transaction exists for your merchant and returns its server-canonical state.

```ts
app.get("/ozura-callback", async (req, res) => {
  const { transactionId, success } = req.query;
  if (success !== "true") return res.redirect("/cart");

  const order = await ozura.verifyOrder(String(transactionId));
  // order is now authoritative — fulfill against this, not the query string
  await sendReceipt(order);
  res.redirect("/thank-you");
});
```

## Order webhooks → polling for v1

Real-time webhooks for `order.refunded` / `order.fulfilled` land in v2. For now, **poll `listOrders` every 5–15 minutes** with the previous batch's `nextSince` cursor. The cursor is monotonic on `updatedAt`, so polling captures every state change in chronological order.

```ts
let cursor: string | null = await loadCursorFromDb();
while (true) {
  const { data, nextSince, hasMore } = await ozura.listOrders({
    since: cursor ?? undefined,
    limit: 100,
  });
  for (const order of data) {
    await handleOrderEvent(order); // idempotent on order.transactionId
  }
  cursor = nextSince ?? cursor;
  await saveCursorToDb(cursor);
  if (!hasMore) break;
}
```

The recovery property matters: if your `successUrl` handler is offline when a customer pays, the next poll picks the order up. **Polling is the correctness path, not a nice-to-have.**

## Scopes

Storefront keys are scoped at mint time in the Ozura dashboard. Default for any AI builder / storefront / Replit project:

| Scope | What it allows |
|---|---|
| `storefront:catalog:read` | `getProducts()` |
| `storefront:cart-link:create` | `createCart()` |
| `storefront:orders:read` | `listOrders()`, `verifyOrder()` (returns minimal projection) |
| `storefront:orders:full` | Adds card last-4 + shipping address to order responses. **Only enable when a backend genuinely needs them** — fulfillment, fraud rules, dispute handling. Not for AI builders. |

Principle of least privilege: keys without `orders:full` see redacted order metadata. If the key leaks, no cardholder PII goes with it.

## Use with Conjure / Replit / Cursor / Claude Code

The shape is identical regardless of who's running it:

```ts
// Conjure builder generated site (Node API route)
import { OzuraStorefront } from "@ozura/storefront-sdk";
const ozura = new OzuraStorefront({ apiKey: process.env.OZURA_KEY! });
export async function GET() {
  return Response.json(await ozura.getProducts());
}
```

```ts
// Replit project
import { OzuraStorefront } from "@ozura/storefront-sdk";
const ozura = new OzuraStorefront({ apiKey: Deno.env.get("OZURA_KEY")! });
```

```ts
// Cursor / Claude Code agentic flow generating a checkout
const ozura = new OzuraStorefront({ apiKey: process.env.OZURA_KEY! });
const cart = await ozura.createCart({ items, successUrl: process.env.HOST + "/checkout/done" });
```

## Errors

Non-2xx responses throw `OzuraApiError`:

```ts
import { OzuraApiError } from "@ozura/storefront-sdk";

try {
  await ozura.verifyOrder("missing-txn");
} catch (err) {
  if (err instanceof OzuraApiError && err.status === 404) {
    // transactionId doesn't belong to this merchant
  }
}
```

Network failures and timeouts throw the underlying `Error` / `AbortError`.

## API reference

### `new OzuraStorefront(options)`

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | — | Required. Must start with `oz_sf_`. |
| `baseUrl` | `string` | Staging Azure host | Override for self-hosted Ozura or v2 production routing. |
| `fetch` | `typeof fetch` | global | Override fetch (Node 18+ has it built-in). |
| `timeoutMs` | `number` | `30000` | Per-request timeout. |

### `getProducts(input?)`

Returns `StorefrontProduct[]`.

| Filter | Notes |
|---|---|
| `tags?: string[]` | Match products with ANY of these tags |
| `groups?: string[]` | Match products in ANY of these groups |
| `brands?: string[]` | Match products with ANY of these brands |
| `productTypes?: string[]` | Match products with ANY of these productTypes |
| `metadata?: Record<string,string>` | Match products whose `metadata` contains ALL of these key/value pairs (AND across keys) |
| `ids?: string[]` | Exact ID set |
| `websiteId?: string` | Filter to a website-builder site |
| `limit?: number` | 1..100, default 50 |
| `includeStock?: boolean` | Default true; set false for SEO scrapers |

```ts
// "All red Nike shirts" — typical merchant filter
const products = await ozura.getProducts({
  brands: ["Nike"],
  productTypes: ["shirt"],
  metadata: { color: "red" },
});
```

### `createCart(input)`

Returns `CreateCartResult` ({ url, paymentLinkId, paymentLinkCode, expiresAt, currency, amount }).

`successUrl` is your **server** endpoint, not a browser destination.

### `listOrders(input?)`

Returns `{ data: Order[], nextSince: string | null, hasMore: boolean }`.

Cursor is `updatedAt` ascending — pass the previous `nextSince` on the next call. Idempotent on boundary records.

### `verifyOrder(transactionId)`

Returns the canonical `Order` for a transactionId. Throws `OzuraApiError(404)` when the transactionId doesn't belong to your merchant.

## Trademarks

*Ozura®* and *OzuraPay®* are trademarks of Ozura Inc. The MIT license below grants rights to the SDK source code only — it does not grant rights to the Ozura trademarks, branding, or product names.

## License

MIT — see [LICENSE](./LICENSE).
