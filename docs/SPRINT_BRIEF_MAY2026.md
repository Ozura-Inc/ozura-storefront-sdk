# Storefront SDK + multi-product cart sprint — dev brief

**Audience:** Seba, Gabe — heads up on what shipped, where it lives, what it means for your areas.
**Status:** all live on `dev-api.ozura.com` (development backend); not promoted to staging or production yet.
**Window:** 2026-04 → 2026-05.
**Diff scope:** `origin/staging..origin/development` for backend + frontend; pre-sprint anchor → `main` for web-builder.

---

## 1. The lift in numbers

| Repo | Net diff vs. staging | New surfaces |
|---|---|---|
| `ozurapay-backend-v2` | +3,827 / −218 across 29 files, 15 commits | Order model, PaymentLink overhaul, Storefront key auth, Storefront SDK API surface, Product brand/type/metadata, refund flow |
| `ozurapay-frontend-v2` | +10,210 / −2,178 across 101 files, 30+ commits | Settings reorg, Storefront API Keys UI, Refund flow, Multi-product cart, CSV import, QR codes on payment links, 404 redesign, i18n × 6 locales |
| `ozura-web-builder` | +373 / −733 across 10 files | Worker refactor (vault/PayAPI keys removed), ProductsPanel filter UI, dashboard alignment |
| `ozura-storefront-sdk` | New repo, `@ozura/storefront-sdk@0.2.0` on npm | Server-side SDK: getProducts / createCart / listOrders / verifyOrder |
| `ozura-ui` | `0.15.28 → 0.15.30` | OzuraResponsiveDialog, OzuraCopyField, OzuraStatusPill, OzuraListTable promoted |

---

## 2. Architecture — what this stack now looks like

<div class="dgrm">
  <div class="dgrm-cap">Architecture overview</div>
  <div class="row">
    <div class="stage stage--accent">
      <div class="stage-t">Merchant Dashboard</div>
      <div class="stage-b">dev-dashboard.ozura.com<br/>JWT auth</div>
    </div>
    <div class="arrow-lbl">mint key<br/>(plaintext once)<br/>→</div>
    <div class="stage">
      <div class="stage-t">/storefront-keys</div>
      <div class="stage-b">CRUD + auto-mint + rotate</div>
    </div>
    <div class="arrow-lbl">oz_sf_…<br/>→</div>
    <div class="stage">
      <div class="stage-t">@ozura/storefront-sdk</div>
      <div class="stage-b">OzuraStorefront client</div>
    </div>
  </div>
  <div class="arrow-down">↓ used by</div>
  <div class="row">
    <div class="stage stage--accent">
      <div class="stage-t">Ozura Website Builder</div>
      <div class="stage-b">Cloudflare Pages Worker<br/>embeds oz_sf_ key only</div>
    </div>
    <div class="stage stage--accent">
      <div class="stage-t">Replit / Cursor / Node</div>
      <div class="stage-b">third-party SDK consumers</div>
    </div>
  </div>
  <div class="arrow-down">↓ Bearer oz_sf_…</div>
  <div class="row">
    <div class="stage">
      <div class="stage-t">/api/storefront/*</div>
      <div class="stage-b">getProducts · createCart · listOrders · verifyOrder</div>
    </div>
    <div class="arrow">→</div>
    <div class="stage">
      <div class="stage-t">Products + Orders (Mongo)</div>
      <div class="stage-b">scoped to merchantId via key</div>
    </div>
  </div>
  <div class="arrow-down" style="margin-top:0.8em;color:#5a5a66;font-size:9pt;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">— customer payment path —</div>
  <div class="row">
    <div class="stage"><div class="stage-t">Customer browser</div><div class="stage-b">deployed OWB site</div></div>
    <div class="arrow-lbl">/api/checkout<br/>→</div>
    <div class="stage"><div class="stage-t">Worker</div><div class="stage-b">→ /api/storefront/cart-links</div></div>
    <div class="arrow-lbl">cart.url<br/>→</div>
    <div class="stage"><div class="stage-t">stag-checkout.ozura.com</div><div class="stage-b">card → PayAPI</div></div>
  </div>
  <div class="arrow-down">↓ /checkout-return writes Order, 302 → successUrl</div>
  <div class="row">
    <div class="stage stage--good">
      <div class="stage-t">Customer back at deployed site</div>
      <div class="stage-b">successUrl?transactionId=…&cardLastFour=…</div>
    </div>
  </div>
</div>

**Trust model** — the storefront key is the *only* credential that touches a deployed customer-facing asset. Vault keys, PayAPI keys, and the merchantId stay on the server. If the deployed Worker source ever leaks: max blast radius is "list this merchant's already-public catalog + mint cart links pointing at this merchant's own site." Verified 16/16 absent in Worker source via Phase 3e smoke.

---

## 3. Storefront API key — anatomy

<div class="dgrm">
  <div class="dgrm-cap">OzuraStorefrontApiKey schema</div>
  <div class="row">
    <div class="stage stage--accent">
      <div class="stage-t">OzuraStorefrontApiKey (collection)</div>
      <ul class="stage-list">
        <li><code>merchantId</code> — ObjectId</li>
        <li><code>keyHash</code> — string (sha256 of plaintext)</li>
        <li><code>keyPrefix</code> — string (display, first 14 chars)</li>
        <li><code>label?</code> — string</li>
        <li><code>scopes</code> — Scope[]</li>
        <li><code>websiteId?</code> — ObjectId (OWB-bound)</li>
        <li><code>createdBy?</code> — ObjectId</li>
        <li><code>lastUsedAt?</code> — Date</li>
        <li><code>revokedAt?</code> — Date (soft-delete)</li>
        <li><code>expiresAt?</code> — Date (optional time-box)</li>
      </ul>
    </div>
    <div class="arrow-lbl">scopes<br/>references<br/>→</div>
    <div class="stage">
      <div class="stage-t">Scope vocabulary (enum)</div>
      <ul class="stage-list">
        <li><code>storefront:catalog:read</code></li>
        <li><code>storefront:cart-link:create</code></li>
        <li><code>storefront:orders:read</code> — minimal projection</li>
        <li><code>storefront:orders:full</code> — adds card last-4 + shipping</li>
      </ul>
    </div>
  </div>
</div>

**Hash strategy** — SHA-256 of the plaintext. No bcrypt: 128-bit random tokens (`oz_sf_<32 hex>`) don't need cost-stretching. Plaintext shown exactly once at mint.

**Indexes:**
- `{ merchantId: 1, createdAt: -1 }` for the merchant's list view
- `{ keyHash: 1 }` unique for O(1) auth lookup
- Partial unique on `{ merchantId, websiteId }` filtered to `websiteId exists AND revokedAt absent` — one active key per Ozura Website Builder site, with rotation cycles cleanly

**Bound merchant** — the key record's `merchantId` IS the merchant for the request. There is no `merchantId` query param to spoof. The auth middleware's only input is the bearer token. Horizontal-privilege-escalation vector eliminated at the design layer.

---

## 4. Storefront key lifecycle

<div class="dgrm">
  <div class="dgrm-cap">Storefront key state machine</div>
  <div class="state-grid">
    <div class="state-node state-node--terminal">○ start</div>
    <div class="state-tx"><div class="state-tx-arrow">→</div>mint<br/>(manual or auto)</div>
    <div class="state-node">Active</div>
    <div class="state-tx"><div class="state-tx-arrow">→</div>DELETE<br/>soft-revoke</div>
    <div class="state-node state-node--terminal">Revoked</div>
  </div>
  <div style="margin-top:0.7em">
    <div class="stage-t" style="margin-bottom:0.4em">Active self-loops:</div>
    <div class="row row-wrap">
      <div class="stage"><div class="stage-t">PATCH</div><div class="stage-b">update label or scopes</div></div>
      <div class="stage"><div class="stage-t">authed call</div><div class="stage-b">bumps lastUsedAt (fire-and-forget)</div></div>
      <div class="stage"><div class="stage-t">rotate</div><div class="stage-b">revoke old + mint new w/ same scopes</div></div>
    </div>
  </div>
  <div style="margin-top:0.6em">
    <div class="stage-t" style="margin-bottom:0.4em">Other terminal transitions:</div>
    <div class="row">
      <div class="stage stage--warn"><div class="stage-t">Active → Expired</div><div class="stage-b">expiresAt timestamp passes — auth fails after</div></div>
      <div class="stage stage--danger"><div class="stage-t">Revoked → ○</div><div class="stage-b">row preserved for audit, auth fails permanently</div></div>
    </div>
  </div>
</div>

The two URL-bearing endpoints not shown above (so the diagram stays parseable):

- `GET /storefront-keys/for-website/<websiteId>` — find-or-mint; returns plaintext on first mint, prefix-only thereafter
- `POST /storefront-keys/for-website/<websiteId>/rotate` — explicit rotate; revoke existing + mint fresh; returns new plaintext

**Rotate vs. revoke:**
- *Revoke* = soft-delete the row (`revokedAt: <timestamp>`), key is dead.
- *Rotate* = revoke the existing OWB-bound key + mint a new one with the same scopes + binding. Returns plaintext for embed in the new Worker. Existing deployed Worker keeps using the old key until re-deploy.

**Why no auto-rotation on every deploy** — that would silently invalidate the live deployed site every time a merchant updates their HTML. Explicit rotation lives at `/rotate`; first deploy uses find-or-mint at `/for-website/:websiteId`.

---

## 5. Cart-link payment flow — what actually happens when a customer pays

<div class="dgrm">
  <div class="dgrm-cap">Cart-link payment round-trip</div>
  <div class="seq">
    <div class="seq-actor">Customer</div><div class="seq-arrow">→</div><div class="seq-msg">clicks <em>Add to cart</em> on deployed OWB site</div>
    <div class="seq-actor">Site</div><div class="seq-arrow">→</div><div class="seq-msg"><code>ozura-cart.js</code> drawer renders, customer clicks <em>Checkout</em></div>
    <div class="seq-actor">Site → Worker</div><div class="seq-arrow">→</div><div class="seq-msg"><code>POST /api/checkout</code> with items[]</div>
    <div class="seq-actor">Worker → SF</div><div class="seq-arrow">→</div><div class="seq-msg"><code>POST dev-api.ozura.com/api/storefront/cart-links</code><br/>Authorization: Bearer oz_sf_…</div>
    <div class="seq-actor">SF backend</div><div class="seq-arrow">→</div><div class="seq-msg">validate, create PaymentLink shadow row</div>
    <div class="seq-actor">SF → Worker</div><div class="seq-arrow">←</div><div class="seq-msg"><code>{ url: "stag-checkout.ozura.com/pay/pl_…" }</code></div>
    <div class="seq-actor">Worker → Site</div><div class="seq-arrow">←</div><div class="seq-msg"><code>{ checkoutUrl }</code></div>
    <div class="seq-actor">Site → Customer</div><div class="seq-arrow">→</div><div class="seq-msg"><code>window.location = checkoutUrl</code></div>
    <div class="seq-actor">Customer → Checkout</div><div class="seq-arrow">→</div><div class="seq-msg">enters card details on stag-checkout.ozura.com</div>
    <div class="seq-actor">Checkout</div><div class="seq-arrow">→</div><div class="seq-msg">charges via PayAPI</div>
    <div class="seq-actor">Checkout → /checkout-return</div><div class="seq-arrow">→</div><div class="seq-msg">redirect with txn details</div>
    <div class="seq-actor">/checkout-return</div><div class="seq-arrow">→</div><div class="seq-msg">writes Order row, decrements inventory</div>
    <div class="seq-actor">/checkout-return → Customer</div><div class="seq-arrow">←</div><div class="seq-msg">302 → successUrl?transactionId=…&cardLastFour=…</div>
    <div class="seq-actor">Customer → Site</div><div class="seq-arrow">→</div><div class="seq-msg">lands at successUrl with params</div>
    <div class="seq-actor">Site</div><div class="seq-arrow">→</div><div class="seq-msg"><code>ozura-cart.js</code> clears cart, toasts success</div>
    <div class="seq-note">Optional: Worker (or SDK consumer) calls <code>verifyOrder(transactionId)</code> before fulfilling — the redirect URL is tamperable, the API call confirms canonical state.</div>
  </div>
</div>

**Verified end-to-end with test card `4111 1111 1111 1111`** in Phase 3b smoke (8/8 assertions passed). The `successUrl` round-trip preserves arbitrary query params — `https://merchant/return?my-marker=x` returns to that URL with `my-marker=x` *and* the appended `transactionId` / `cardLastFour` / etc.

---

## 6. Order polling — the v1 webhook substitute

<div class="dgrm">
  <div class="dgrm-cap">Order polling loop</div>
  <div class="seq">
    <div class="seq-note">Consumer state: <code>cursor = last seen updatedAt</code></div>
    <div class="seq-loop">↻ Every 5–15 minutes</div>
    <div class="seq-actor">Consumer → SF</div><div class="seq-arrow">→</div><div class="seq-msg"><code>GET /api/storefront/orders?since=&lt;ISO&gt;&amp;limit=100</code></div>
    <div class="seq-actor">SF → Mongo</div><div class="seq-arrow">→</div><div class="seq-msg">find merchantId=&lt;bound&gt;, updatedAt &gt; since, sort updatedAt asc<br/>compound index <code>(merchantId, updatedAt, _id)</code></div>
    <div class="seq-actor">Mongo → SF</div><div class="seq-arrow">←</div><div class="seq-msg">orders[]</div>
    <div class="seq-actor">SF → Consumer</div><div class="seq-arrow">←</div><div class="seq-msg"><code>{ data, nextSince, hasMore }</code></div>
    <div class="seq-actor">Consumer</div><div class="seq-arrow">→</div><div class="seq-msg"><code>handleOrderEvent(o)</code> — idempotent on transactionId</div>
    <div class="seq-note">Consumer state: <code>cursor = nextSince</code>. If <code>hasMore</code>, immediately page; else wait until next tick.</div>
  </div>
</div>

**Why polling, not webhooks for v1:** webhooks would mean another delivery pipeline (retries, DLQ, signing, replay). Max's call: ship the polling cursor first, defer real-time webhooks to v2. The cursor is a simple Mongo query against a compound index `{ merchantId: 1, updatedAt: 1, _id: 1 }` — no queue, no scheduler.

**Idempotent on `transactionId`** — boundary records may repeat across pages; the consumer's handler should be idempotent.

---

## 7. Product model evolution — before vs. after

<div class="dgrm">
  <div class="dgrm-cap">Product model evolution</div>
  <div class="compare">
    <div class="compare-side compare-side--bad">
      <h5>Before this sprint</h5>
      <ul>
        <li>name, description, price, currency</li>
        <li>imageUrl, sku</li>
        <li>group, tags[]</li>
        <li>inventory, requiresShipping</li>
      </ul>
    </div>
    <div class="compare-mid">
      <div class="compare-mid-arrow">→</div>
      Phase 4a
    </div>
    <div class="compare-side compare-side--good">
      <h5>After Phase 4a</h5>
      <ul>
        <li>name, description, price, currency</li>
        <li>imageUrl, sku</li>
        <li>group, tags[]</li>
        <li><strong>brand</strong> ← NEW</li>
        <li><strong>productType</strong> ← NEW</li>
        <li><strong>metadata: Map&lt;string,string&gt;</strong> ← NEW</li>
        <li>inventory, requiresShipping</li>
      </ul>
    </div>
  </div>
  <div style="margin-top:0.8em">
    <div class="stage-t" style="margin-bottom:0.4em">Filterable axes (storefront SDK + dashboard list):</div>
    <div class="row row-wrap">
      <div class="stage"><code>tags[]</code><div class="stage-b">ANY-of match</div></div>
      <div class="stage"><code>groups[]</code><div class="stage-b">ANY-of match</div></div>
      <div class="stage stage--accent"><code>brands[]</code><div class="stage-b">ANY-of (NEW)</div></div>
      <div class="stage stage--accent"><code>productTypes[]</code><div class="stage-b">ANY-of (NEW)</div></div>
      <div class="stage stage--accent"><code>metadata{}</code><div class="stage-b">AND across keys (NEW)</div></div>
      <div class="stage"><code>ids[]</code><div class="stage-b">exact set</div></div>
      <div class="stage"><code>websiteId</code><div class="stage-b">single match</div></div>
    </div>
  </div>
</div>

**`brand` vs `productType` vs `group`:**

| Field | What it describes | Example |
|---|---|---|
| `brand` | Who makes the product | "Nike", "Apple" |
| `productType` | What the product is | "shirt", "ebook", "subscription" |
| `group` | Merchant's collection bucketing | "Summer 2026", "Sale items" |
| `tags[]` | Cross-cutting tags | `["new-arrival", "limited-edition"]` |
| `metadata` | Long-tail attributes | `{ color: "red", size: "M", material: "cotton" }` |

`metadata` is the escape hatch — capped at 50 entries / 200 chars per key+value via schema validator. Prevents schema sprawl while leaving room for everything ecommerce-y.

---

## 8. Ozura Website Builder deploy — credential surface delta

<div class="dgrm">
  <div class="dgrm-cap">OWB Worker credential surface — before vs. after</div>
  <div class="compare">
    <div class="compare-side compare-side--bad">
      <h5>Before — _worker.js had:</h5>
      <ul>
        <li><code>MERCHANT_ID</code></li>
        <li><code>MERCHANT_NAME</code></li>
        <li><code>VAULT_API_KEY</code> — token-vault</li>
        <li><code>OZURA_API_KEY</code> — PayAPI<br/>(refund + charge power)</li>
        <li><code>CHECKOUT_API_URL</code></li>
        <li><code>BACKEND_API_URL</code></li>
        <li><code>CHECKOUT_APPEARANCE</code> blob</li>
      </ul>
    </div>
    <div class="compare-mid">
      <div class="compare-mid-arrow">→</div>
      Phase 3b refactor<br/>−733 net lines<br/>−95 lines iframe overlay
    </div>
    <div class="compare-side compare-side--good">
      <h5>After — _worker.js has only:</h5>
      <ul>
        <li><code>STOREFRONT_API_KEY</code><br/>(oz_sf_, scoped read+cart-link)</li>
        <li><code>STOREFRONT_API</code> base URL</li>
        <li><code>SITE_URL</code> (public)</li>
      </ul>
    </div>
  </div>
  <div style="margin-top:0.8em">
    <div class="stage-t" style="margin-bottom:0.4em">Phase 3e Worker-gen smoke (automated):</div>
    <div class="row">
      <div class="stage stage--good">
        <div class="stage-t">✓ 16/16 banned credential refs absent</div>
        <div class="stage-b">vaultApiKey, ozuraApiKey, MERCHANT_ID, MERCHANT_NAME, X-API-KEY, X-OZURA-API-KEY, embedMode, parentOrigin, checkoutAppearance, /api/sessions/create, …</div>
      </div>
      <div class="stage stage--good">
        <div class="stage-t">✓ 7/7 required new patterns present</div>
        <div class="stage-b">STOREFRONT_API_KEY, Bearer auth, /api/storefront/cart-links, /api/storefront/products, CORS preserved, successUrl → ?checkout=success</div>
      </div>
    </div>
  </div>
</div>

**Companion changes:**
- `cart-script.ts` dropped iframe overlay (~95 lines) — checkout is now full-page redirect to `stag-checkout.ozura.com`
- `ProductsPanel.tsx` is read-only on products (the SDK has no `catalog:write` scope)
- Filter UI: dropdowns for group / brand / productType, AND-combined server-side, default-selects all matching

---

## 9. Heads up — Seba (transactions / QR codes / payment links)

Things from this sprint that touch your areas:

1. **`PaymentLink` and `Order` both gained `items[]`** for multi-product carts. Storefront SDK cart-links populate it. Anywhere you display "the product" for a payment link or transaction, check whether it's a single-product or multi-item cart. The dashboard's order detail view already handles both.
2. **`PaymentLink.source` enum gained `"cart"`** alongside `"standalone"` and `"product"`. SDK-minted links use `"cart"`. The Payment Links list filter shows all three. Your QR-code feature on payment links applies equally to all three sources.
3. **Auto-regen on product edit** — name / price / currency / inventory edits regenerate the `source: "product"` payment links and bump `checkoutLinkUrl`. The merchant's old URL is now stale; the dashboard surfaces a toast about this. **If your QR is encoding the link URL: refresh on update**. The new URL is in the regen response payload (`linksRegenerated > 0` flag + the refreshed product).
4. **Refund flow** replaced the old "cancel" path. Order rows have `refundedAmount` (`number`) and `refundedAt` (`Date`). Full + partial refunds via PayAPI `cardRefund`, optional restock per line, plus a "customer kept the items" bookkeeping flag on the Refund row.
5. **Frontend transactions page** — your transaction-filter work is on the same `development` branch. The new Orders page (`src/components/dashboard/orders/`) is the merchant-facing companion to that — ping me if there's overlap to consolidate.
6. **`@ozura/ui@0.15.30`** added `OzuraStatusPill` (with 6 tones), `OzuraCopyField`, `OzuraResponsiveDialog`, `OzuraListTable`. The dashboard uses them across orders / payment links / settings. If you're touching adjacent UI, check `npm ls @ozura/ui` (should be `^0.15.30` already).

---

## 10. Heads up — Gabe (recurring charges / bullmq)

The strategic call we made that's directly relevant to anything queue-driven:

**For v1, we did NOT add new webhook delivery infrastructure. We chose redirect-as-event + polling instead.**

<div class="dgrm">
  <div class="dgrm-cap">v1 polling vs. v2 webhooks</div>
  <div class="compare">
    <div class="compare-side compare-side--good">
      <h5>v1 (now) — polling</h5>
      <ul>
        <li>Order created → /checkout-return wraps successUrl</li>
        <li>Order updates → polling cursor on updatedAt</li>
        <li>No queue, no scheduler</li>
        <li>Compound index <code>(merchantId, updatedAt, _id)</code></li>
      </ul>
    </div>
    <div class="compare-mid">
      <div class="compare-mid-arrow">→</div>
      if product needs<br/>sub-minute delivery
    </div>
    <div class="compare-side">
      <h5>v2 (deferred) — webhooks</h5>
      <ul>
        <li>Per-merchant webhook subscriptions</li>
        <li>Delivery queue (bullmq territory)</li>
        <li>Retries, DLQ, signed payloads, replay</li>
      </ul>
    </div>
  </div>
</div>

Concretely:

1. **Order created event** = the browser hop through `/checkout-return`. Backend writes the Order during the redirect; the merchant's `successUrl` handler is the de-facto "order created" notification with all relevant fields in the query string.
2. **Order status changes** (paid → fulfilled, paid → refunded) ride the polling endpoint. Cadence: 5–15 min. Cursor on `updatedAt` ascending. Idempotent on `transactionId`.
3. **What this means for recurring-charges work:**
   - If your branch needs to notify SDK consumers of a recurring charge, the cheapest path is to write the charge as an `Order` and let it ride the same `listOrders` cursor. Free pickup, same idempotency contract.
   - If recurring-charges *itself* needs a queue (scheduling next charge, retry on failure), that's still your area. **Nothing in this sprint touches that.**
   - If the product eventually wants webhook delivery for recurring events, **bullmq is the right foundation for v2**. We just deliberately didn't build it for v1.
4. **Backend `Order` shape** — `src/models/Order.ts`. Fields: `transactionId`, `amount`, `currency`, `status` (`paid` | `fulfilled` | `refunded`), `paidAt`, `fulfilledAt?`, `refundedAt?`, `refundedAmount?`, `productName?`, `productImageUrl?`, `items?`, `paymentLinkCode?`. The `(merchantId, updatedAt, _id)` compound index drives polling — tested and live on `dev-api.ozura.com`.
5. **Backend recurring controller was DELETED** in this sprint (the unused `src/controllers/recurring.controller.ts` and `recurring.route.ts`). If your branch was tracking it, that's gone — branch off the new layout. Fresh recurring work should live alongside `payment.controller` / `paymentLink.controller` not as a separate file, IMO.

---

## 11. How to test against `dev-api.ozura.com`

### One-liner SDK smoke

```bash
mkdir /tmp/sf-smoke && cd /tmp/sf-smoke && npm init -y >/dev/null && npm i @ozura/storefront-sdk

# Mint a key from dev-dashboard.ozura.com → Settings → API Keys → Storefront, then:
node --input-type=module -e "
  import('@ozura/storefront-sdk').then(async ({ OzuraStorefront }) => {
    const ozura = new OzuraStorefront({ apiKey: 'oz_sf_<your_plaintext>' });
    console.log('products:', await ozura.getProducts({ limit: 3 }));
    console.log('orders:',   await ozura.listOrders({ limit: 3 }));
  });
"
```

Default `baseUrl` is `https://dev-api.ozura.com` — no override needed.

### Full payment round-trip

```ts
const cart = await ozura.createCart({
  items: [{ name: "Tee", qty: 1, unitPrice: 19.99 }],
  successUrl: "https://httpbin.org/anything?my-marker=x",
});
// Open cart.url in a browser, pay with 4111 1111 1111 1111 / 12/30 / 123
// Returns to httpbin.org/anything?my-marker=x&success=true&transactionId=…
const order = await ozura.verifyOrder("<transactionId from URL>");
console.log(order.status); // "paid"
```

---

## 12. Ozura Website Builder filter UI — what it looks like for merchants

<div class="dgrm">
  <div class="dgrm-cap">OWB filter UI — merchant flow</div>
  <div class="row">
    <div class="stage stage--accent">
      <div class="stage-t">Merchant in OWB builder</div>
      <div class="stage-b">opens Products panel</div>
    </div>
    <div class="arrow">→</div>
    <div class="stage">
      <div class="stage-t">Filter dropdowns</div>
      <div class="stage-b">Group ▾  ·  Brand ▾  ·  Product type ▾<br/>distinct values from /products/*</div>
    </div>
    <div class="arrow">→</div>
    <div class="stage">
      <div class="stage-t">Backend filter</div>
      <div class="stage-b"><code>/api/products?group=&amp;brand=&amp;productType=</code><br/>AND combined</div>
    </div>
  </div>
  <div class="arrow-down">↓</div>
  <div class="row">
    <div class="stage">
      <div class="stage-t">Catalog list (default-selected)</div>
      <div class="stage-b">checkboxes — merchant unchecks unwanted</div>
    </div>
    <div class="arrow">→</div>
    <div class="stage">
      <div class="stage-t">Add → local OWB site</div>
      <div class="stage-b">brand + productType propagate through</div>
    </div>
    <div class="arrow">→</div>
    <div class="stage stage--good">
      <div class="stage-t">Deploy</div>
      <div class="stage-b">_worker.js with oz_sf_ only</div>
    </div>
  </div>
</div>

Merchant flow:
1. **Catalog values come from**: `GET /products/groups`, `GET /products/brands`, `GET /products/product-types` (all JWT-authed). Dropdowns hide themselves if the merchant has no values for that axis (clean empty-state).
2. **Filter intersection is server-side AND** — `?group=Summer&brand=Nike&productType=shirt` returns only products matching all three.
3. **Default-selects the result** so "all of brand=Nike" is one click. Merchants uncheck what they don't want before adding.

---

## 13. Repos + PRs touched

| Repo | PRs |
|---|---|
| `ozurapay-backend-v2` | #33 (orders shipping), #34 (orders/cart/refunds bundle), #35 (storefront key website binding), #36 (Product brand/type/metadata), #38 (listProducts filters) |
| `ozurapay-frontend-v2` | #54 (settings/orders/products UI bundle), #55 (product form metadata), #57 (Source pill + revoke warning) |
| `ozura-web-builder` | #2 (Worker refactor) + 3 direct main pushes (Phase 3c, 3d, 4d) |
| `ozura-storefront-sdk` | New repo at github.com/Ozura-Inc/ozura-storefront-sdk. Initial commit + 0.2.0 publish. |
| `ozura-ui` | Direct main push to 0.15.30 with the new primitives |

---

## 14. Deliberately not done (out of scope by direction)

- Promotion to staging or production. `dev-api.ozura.com` is the canonical surface; the SDK package's default base URL points there.
- Webhook delivery infrastructure (deferred to v2 — see §10 for the polling substitute).
- Replit-specific integration work — waiting on direction. The contract (storefront key + SDK + redirect-back) is what carries over verbatim.
- Production-scoped storefront keys. Sandbox-only via `resolveCredentials("sandbox")` in `storefront.controller.ts:198`. Production keys arrive when we promote.
- "Source: Replit" / "Source: Cursor" pills. Only the OWB-bound flow auto-mints with `websiteId`; manual mint stays untagged. Add taxonomies as we onboard new SDK consumers.

---

## 15. Open questions / pushback

If anything in here doesn't fit how your branch is shaped, ping Max or me — easier to redirect now than after the next merge.
