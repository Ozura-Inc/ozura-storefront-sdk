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

## Where to look

- **API reference:** the TypeScript types in \`src/index.ts\` are the authoritative contract. Read them first.
- **Integration docs:** https://docs.ozura.com/guides/payments/checkout/integration-modes
- **Appearance reference:** https://docs.ozura.com/guides/payments/checkout/appearance-reference
- **Examples:** see the \`feat/rebuild-v2-spike\` branch of \`Ozura-Inc/ozura-web-builder\` — full Astro storefront wired against this SDK with the canonical patterns above.
`;
