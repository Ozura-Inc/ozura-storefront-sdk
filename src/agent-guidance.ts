/**
 * Generated from AGENTS.md by scripts/sync-agent-guidance.mjs.
 * DO NOT EDIT BY HAND — edit AGENTS.md and re-run `npm run sync:agents`.
 *
 * This is the canonical guidance for AI agents using the storefront SDK.
 * Consumers (Conjure codegen system prompt, dashboard's IntegratePromptGenerator)
 * import this constant so there is exactly one source of truth.
 */
export const AGENT_GUIDANCE_SDK = `# Instructions for AI agents using \`@ozura/storefront-sdk\`

If you're an AI agent (Claude Code, Cursor, Replit AI, Aider, Continue, etc.) generating code that uses this SDK, follow these rules. They reflect the canonical patterns for the \`docs.ozura.com\` checkout — sites that follow them work with no surprises.

## TL;DR

When you generate a storefront, **always**:
1. Use the right **key flavor** for the runtime (see § Key flavors below).
2. Call \`getProducts()\` server-side at request time (SSR) when using a \`oz_sf_…\` key. For browser-side product reads, use a separate \`oz_sfp_…\` (public) key — same SDK, different prefix.
3. Mint cart links in **iframe mode** with \`embedMode: "iframe"\` + \`parentOrigin: <bare origin>\` + an \`appearance\` object derived from the site's design tokens.
4. Render the returned URL inside an iframe overlay, **not** as a full-page redirect.
5. Listen for the documented postMessage events from the iframe — origin-guard the listener.

Anything else makes the merchant's customer leave the storefront mid-purchase, which is what the iframe pattern exists to avoid.

## Key flavors

The SDK accepts two key prefixes. Pick based on where the code lives:

| Prefix | Where | Methods that work | Methods that 403 |
|---|---|---|---|
| \`oz_sf_…\` | Server only | \`getProducts\`, \`createCart\`, \`listOrders\`, \`verifyOrder\` | — |
| \`oz_sfp_…\` | Browser-safe | \`getProducts\` only | \`createCart\`, \`listOrders\`, \`verifyOrder\` (server-enforced) |

**Never bundle an \`oz_sf_…\` key into browser code.** It carries cart-link-create scope; a leaked browser bundle = anyone can mint cart links to URLs they control and charge cards against the merchant's processor. The SDK warns on construction; the harm is real.

**\`oz_sfp_…\` keys are safe to bundle.** Worst case if leaked: an attacker reads a catalog that's already public on the deployed storefront. Per-site key, granular revocation.

Most generated apps need **both**:
- Server route uses \`OZURA_STOREFRONT_KEY\` (\`oz_sf_…\`) to mint cart links + verify orders
- Browser bundle uses \`NEXT_PUBLIC_OZURA_PUBLIC_KEY\` (\`oz_sfp_…\`) for live catalog reads, IF the merchant wants client-side refreshes (otherwise the server route handles all product fetches via SSR and the public key isn't needed).

Inspect the flavor with \`instance.keyFlavor\` — \`"server" | "public"\`. Useful when you want to expose a single "checkout" client to both contexts and branch internally.

---

## The canonical createCart call

\`\`\`ts
import { OzuraStorefront } from "@ozura/storefront-sdk";

const ozura = new OzuraStorefront({
  apiKey: process.env.OZURA_STOREFRONT_KEY!,    // never bundle into browser
  baseUrl: process.env.OZURA_API_BASE,           // optional override
});

const cart = await ozura.createCart({
  items: lines.map((l) => ({
    productId: l.productId,
    name: l.name,
    qty: l.qty,
    unitPrice: l.unitPrice,
    imageUrl: l.imageUrl,
  })),
  successUrl: \`\${origin}/cart/success\`,
  cancelUrl:  \`\${origin}/cart/cancel\`,
  errorUrl:   \`\${origin}/cart/error\`,

  // ─── REQUIRED for iframe embedding ─────────────────────────────────
  embedMode: "iframe",
  parentOrigin: origin,                          // bare origin, no trailing slash

  // ─── REQUIRED for brand consistency ─────────────────────────────────
  appearance: {
    primaryColor: tokens.accent,                 // e.g. "#b8542a"
    primaryHoverColor: tokens.accentHover,
    backgroundColor: tokens.surface,             // e.g. "#faf6ef"
    textColor: tokens.ink,
    buttonBackgroundColor: tokens.ink,
    buttonHoverColor: tokens.accent,
    buttonTextColor: tokens.surface,
    inputBackgroundColor: tokens.surface,
    inputBorderColor: tokens.line,
    inputFocusBorderColor: tokens.accent,
    borderRadius: tokens.radius,                 // "none" | "sm" | "base" | "lg" | "xl" | "full"
    fontFamily: tokens.bodyFont,                 // e.g. "Inter"
    showMerchantName: true,
  },
});

// cart.url ships frame-ancestors *  →  safe to embed
\`\`\`

**Always derive \`appearance\` from the site's design tokens** (the CSS custom properties on \`:root\`, the theme schema, the brand config — wherever the site's color + type system lives). Hardcoding \`appearance\` is acceptable only if the storefront has exactly one immutable theme.

## Iframe overlay pattern (the parent page side)

\`\`\`tsx
// Render once in your layout
<div id="checkout-overlay" hidden>
  <iframe id="checkout-frame" src="about:blank" allow="payment *; clipboard-write" />
</div>

// On checkout button click:
async function startCheckout(items) {
  const res = await fetch("/api/cart/checkout", { method: "POST", body: JSON.stringify({ items }) });
  const { url } = await res.json();
  document.getElementById("checkout-frame").src = url;
  document.getElementById("checkout-overlay").hidden = false;
}

// Listen for the documented events from inside the iframe
window.addEventListener("message", (ev) => {
  // Origin guard — only accept messages from Ozura's checkout origin
  if (!/^https:\\/\\/(.+\\.)?ozura\\.com$/.test(ev.origin) &&
      !ev.origin.startsWith("http://localhost:")) {
    return;
  }
  switch (ev.data?.type) {
    case "CHECKOUT_READY":     /* iframe loaded, hide spinner */ break;
    case "PAYMENT_SUCCESS":    /* close iframe, clear cart, show confirmation */ break;
    case "PAYMENT_ERROR":      /* close iframe, show error */ break;
    case "CHECKOUT_CANCELLED": /* close iframe, keep cart */ break;
    case "CHECKOUT_ERROR":     /* close iframe, show error */ break;
    case "CHECKOUT_EXPIRED":   /* close iframe, prompt retry */ break;
  }
});
\`\`\`

The full event catalog and payload shapes are at https://docs.ozura.com/guides/payments/checkout/integration-modes.

## Rendering catalog listings on the page

**Don't loop over a static products array at build time.** Cards baked into HTML can't reflect a merchant's curation changes (or an integrator's preview override) without a redeploy. Instead, emit an empty grid shell + an in-page \`<template>\` for one card; the deployed site's runtime (\`/ozura-storefront.js\`, auto-injected) clones the template once per product fetched at page load.

\`\`\`html
<section data-oz-product-grid>
  <template data-oz-product-card>
    <article class="product-card">
      <img data-oz-bind="imageUrl" alt="">
      <h3 data-oz-bind="name"></h3>
      <p data-oz-bind="price" data-oz-format="currency"></p>
      <a data-oz-bind-href="/products/\${slug}">View details</a>
      <button data-add-to-cart
              data-oz-bind-attr="product-id:_id,product-name:name,product-price:price,product-image:imageUrl,product-currency:currency,product-requires-shipping:requiresShipping">
        Add to cart
      </button>
    </article>
  </template>
  <div data-oz-grid-empty>No products yet.</div>
</section>
\`\`\`

**Grid filter mini-syntax** in the \`data-oz-product-grid\` value:

| Value | Renders | Endpoint |
|---|---|---|
| \`""\` or \`"all"\` | every curated product | \`GET /api/products\` |
| \`"tag:oz-grid-<slug>"\` | the merchant's named grid \`<slug>\`, in their drag-ordered sequence | \`GET /api/grids/<slug>\` |
| \`"tag:featured"\` | products carrying the \`featured\` tag (free-form, no ordering) | \`GET /api/products?tags=featured\` |
| \`"tags:a,b,c"\` | products carrying ANY of these tags | \`GET /api/products?tags=a,b,c\` |
| \`"group:hats"\` | products in the \`hats\` group | \`GET /api/products?groups=hats\` |
| \`"groups:a,b"\` | products in ANY of these groups | \`GET /api/products?groups=a,b\` |

The runtime issues **one fetch per \`data-oz-product-grid\` container** (each grid is independent). You can put multiple grids on a page — a homepage featured strip emitting \`tag:oz-grid-featured\` AND a \`/shop\` page emitting a default \`data-oz-product-grid\` are both first-class.

### Named grids — the \`oz-grid-\` prefix

Merchants manage "named grids" in the dashboard (Featured, Bestsellers, Holiday Sale, etc.). Each grid has a stable \`slug\` and surfaces as the tag \`oz-grid-<slug>\` on products. When your template emits \`data-oz-product-grid="tag:oz-grid-featured"\`, the runtime hits \`GET /api/grids/featured\`, which returns the merchant's chosen products **in their chosen order**. Free-form tags (\`tag:summer-2026\`) skip the Grid metadata path and just filter the catalog — useful for ad-hoc collections but no drag-to-order.

When a storefront has multiple product-listing surfaces (homepage strip + \`/shop\` + \`/sale\` etc.), emit a **distinct grid filter per surface**. Don't reuse the same tag for "all". The merchant-facing rename happens on the Grid's display name; templates reference the slug, which never changes, so renames don't break your markup.

### Pagination (large catalogs)

The catalog endpoint caps responses at **100 products per request** (default 50). The grid endpoint follows the same cap. You pick how listings handle catalogs that exceed the cap:

| Strategy | Where it lives | When to use |
|---|---|---|
| **Single-page, no pagination** | Default. Just emit one grid. | < 50 products; one-glance browsing. |
| **Paginated grid (\`?page=\`)** | Use \`data-oz-page-size="N"\` + \`<button data-oz-load-more>\`. Runtime appends pages on click. | 50–500 products; "Load more" UX. |
| **Multiple themed sections** | Multiple grids on one page (\`tag:oz-grid-bestsellers\`, \`tag:oz-grid-new\`, etc.). | Editorial homepage; lets the merchant curate strips of <50 each. |
| **Server-side pagination via routes** | Emit \`/shop\`, \`/shop/page/2\`, etc. via Astro \`getStaticPaths\` driven by \`src/data/products.ts\`. | SEO-critical pagination; full SSR control. |

For "Load more" mode, the runtime handles the request:

\`\`\`html
<section data-oz-product-grid data-oz-page-size="20">
  <template data-oz-product-card>…</template>
  <button data-oz-load-more>Load more</button>
  <div data-oz-grid-empty>No products yet.</div>
</section>
\`\`\`

The runtime fetches the first 20, hides \`[data-oz-load-more]\` when fewer than 20 came back or the next page is empty, and appends cards on each click. Page-size caps at 100; the server-side enforced limit always wins.

For very large catalogs (500+), prefer **multiple themed grids** over one giant paginated list — it's better UX for the customer and gives the merchant a curation tool that actually scales. The agent should propose this in onboarding rather than emitting one massive \`<section data-oz-product-grid>\`.

**Bind attribute reference** (used on elements inside \`<template data-oz-product-card>\`):

- \`data-oz-bind="fieldName"\` — sets the element's \`textContent\`, or its \`src\` if it's \`<img>\`. Field names come from the catalog: \`_id\`, \`name\`, \`description\`, \`price\`, \`currency\`, \`imageUrl\`, \`tags\`, \`group\`, \`sku\`, \`brand\`, \`productType\`, \`slug\`, \`requiresShipping\`, etc.
- \`data-oz-bind-attr="attrName:fieldName,attrName:fieldName,..."\` — multi-attribute binding. Each attribute gets prefixed with \`data-\` (so \`product-id:_id\` writes \`data-product-id="<the id>"\`).
- \`data-oz-bind-href="/path/with/\${slug}"\` — templated href. Tokens are \`\${fieldName}\` substituted from the product.
- \`data-oz-format="currency"\` — optional. Renders the bound value as \`<CURRENCY> 0.00\`.

**Cart wiring is unchanged.** Keep using \`data-add-to-cart\` on the button. The bind attrs above stamp the \`data-product-*\` fields the existing cart drawer reads; no changes to the cart code path.

### Override channels (for previews)

When you (the agent) want to show a *draft* selection without saving to the backend — e.g. "show me what this site would look like if I picked these 3 products" — drive the same grid with an override:

1. \`window.__OZURA_PRODUCT_OVERRIDE = ["id1", "id2", ...]\` (or full product objects) — set *before* \`/ozura-storefront.js\` initializes. Useful when you control the parent frame.
2. \`window.postMessage({ type: "ozura:catalog-preview", productIds: [...] }, "*")\` — for cross-origin parents. The runtime is origin-gated to \`dashboard.ozura.com\`, dev variants, Vercel preview deployments, and localhost.
3. \`?ozPreviewProducts=id1,id2,id3\` URL param on the page itself — stateless shareable preview links.

The runtime hydrates id-only arrays via a single \`/api/products?ids=\` call, so you can pass IDs without fleshing them out yourself.

This is the contract Replit (and any other agentic playground) uses to "preview before commit": the SDK pushes a productIds array to the rendered page; the merchant approves; the integration code then calls the backend's catalog-curation endpoint to persist.

### PDPs (product detail pages)

PDPs at \`/products/<slug>\` stay server-rendered via Astro's \`getStaticPaths\` — they're useful for SEO and direct linking. The deploy pipeline writes a \`src/data/products.ts\` containing the curated catalog; reference it from \`getStaticPaths\` to enumerate which PDPs to build. **Don't** loop over \`products.ts\` for listings on the homepage etc. — those go through \`data-oz-product-grid\`. The static \`products.ts\` is for the build-time route enumeration only.

## Server-side only — do NOT bundle this SDK into the browser

The constructor takes an \`oz_sf_…\` storefront key. That key carries scopes including \`cart-link:create\` and (potentially) \`orders:read\` — you cannot safely expose it to a browser. The SDK warns on misuse but the only correct pattern is:

- **Hosted-server flow (Astro SSR / Next.js server action / Cloudflare Worker / Express route):** fine. The agent's generated server-side route uses the SDK, the browser calls that route.
- **Pure-client SPA fetching directly from the SDK:** ❌ never. If you need browser-side product reads, pair this SDK with a thin proxy route on your server, or wait for \`@ozura/storefront-browser\` (separate package, read-only scope, browser-safe key).

## Recurring / subscription products

If \`getProducts()\` returns a product with \`recurring\` set (e.g. \`interval: "monthly"\`, \`setupFee\`, \`initialAmount\`), render it as a subscription in your UI:

\`\`\`tsx
{product.recurring ? \`$\${product.price} / \${product.recurring.interval}\` : \`$\${product.price}\`}
\`\`\`

When that product hits the cart, pass the \`recurring\` sub-doc through on the \`CartItemInput\`:

\`\`\`ts
items: [{
  productId: p._id,
  name: p.name,
  qty: 1,
  unitPrice: p.price,
  recurring: p.recurring,                        // ← pass through
}]
\`\`\`

Mixing recurring + one-off items in a single cart is not supported in v1. Split into separate \`createCart\` calls.

## Shipping (physical goods)

Pass \`collectShippingAddress: true\` on \`createCart\` whenever any item in the cart is physical. The Ozura product model has a \`requiresShipping\` boolean per item; the right pattern is \`products.some(p => p.requiresShipping)\`:

\`\`\`ts
const cart = await ozura.createCart({
  items,
  collectShippingAddress: items.some((i) => i.requiresShipping === true),
  embedMode: "iframe",
  parentOrigin: origin,
  // …
});
\`\`\`

Forgetting this is the most common quiet bug — a customer buys two t-shirts and the order lands with no address. The checkout iframe will skip the address step entirely if \`collectShippingAddress\` isn't set, and **there's no later prompt for it**.

For carts that mix physical + digital, set the flag if *any* item needs shipping. Backends that store per-line shipping requirements can refine this later, but the cart-level boolean is what the iframe reads.

## Confirmation pages — \`/cart/success\`, \`/cart/cancel\`, \`/cart/error\`

\`createCart\` requires you to provide \`successUrl\` / \`cancelUrl\` / \`errorUrl\`. The iframe redirects the customer to one of these after checkout. Each page should:

1. **postMessage the documented event up to \`window.parent\`** so any iframe overlay listening for it closes and updates state — \`PAYMENT_SUCCESS\`, \`CHECKOUT_CANCELLED\`, \`CHECKOUT_ERROR\` respectively.
2. **Render a real confirmation message** as a fallback for cases where the iframe ends up rendered standalone (mis-config, deep link). At minimum: a thank-you message on success ("A copy of the receipt is on its way to your inbox"), neutral copy on cancel, and an error explanation on error. Never leave the iframe rendering a blank page or your homepage — customers won't know if their card was charged.

Minimal success page:

\`\`\`html
<!doctype html>
<title>Thank you</title>
<h1>Order received.</h1>
<p>A copy of the receipt is on its way to your inbox.</p>
<a href="/">Back to the shop</a>
<script>
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "PAYMENT_SUCCESS" }, "*");
  }
</script>
\`\`\`

If you skip these pages, the iframe redirect lands on a 404 or the homepage and the overlay never closes — users think payment failed even when it succeeded.

## Order verification (after PAYMENT_SUCCESS)

The iframe's \`PAYMENT_SUCCESS\` payload includes a \`paymentData.transactionId\`. **Always verify it server-side** before fulfilling — the postMessage is from a browser, never trust it directly:

\`\`\`ts
const order = await ozura.verifyOrder(transactionId);
if (order.status === "paid") {
  // safe to fulfill
}
\`\`\`

## What NOT to do

- ❌ Don't ship the SDK key in the browser bundle.
- ❌ Don't \`window.location = cart.url\` — use the iframe overlay.
- ❌ Don't omit \`parentOrigin\` when \`embedMode\` is set; the server returns 400.
- ❌ Don't make up postMessage event names (\`ozura:checkout:success\`, \`payment.complete\`, etc.); only the documented \`CHECKOUT_READY\` / \`PAYMENT_SUCCESS\` / \`PAYMENT_ERROR\` / \`CHECKOUT_CANCELLED\` / \`CHECKOUT_ERROR\` / \`CHECKOUT_EXPIRED\` events fire.
- ❌ Don't bake products into HTML at build time and skip runtime fetches — merchants edit catalogs in the dashboard and expect the storefront to reflect that without redeploy.
- ❌ Don't trust \`transactionId\` from the postMessage to fulfill — verify via \`verifyOrder()\` first.
- ❌ Don't omit \`collectShippingAddress\` when the cart contains physical items — the iframe skips the address step and the order lands with no shipping data.
- ❌ Don't leave \`/cart/success\` / \`/cart/cancel\` / \`/cart/error\` as 404s or homepage redirects — customers can't tell if payment went through and the overlay never closes.

## Where to look

- **API reference:** the TypeScript types in \`src/index.ts\` are the authoritative contract. Read them first.
- **Integration docs:** https://docs.ozura.com/guides/payments/checkout/integration-modes
- **Appearance reference:** https://docs.ozura.com/guides/payments/checkout/appearance-reference
- **Examples:** see the \`feat/rebuild-v2-spike\` branch of \`Ozura-Inc/ozura-web-builder\` — full Astro storefront wired against this SDK with the canonical patterns above.
`;
