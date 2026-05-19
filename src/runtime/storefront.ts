/**
 * Storefront catalog renderer — drop-in script for any Ozura-wired site.
 *
 * Lives in the SDK so external agents (Replit / Lovable / Bolt / etc.) can
 * link the prebuilt asset via CDN at
 * `https://cdn.jsdelivr.net/npm/@ozura/storefront-sdk@<ver>/dist/runtime/storefront.js`
 * AND Conjure's deploy pipeline can inline the same source via
 * `import { STOREFRONT_RUNTIME_SCRIPT, getV2StorefrontScript } from "@ozura/storefront-sdk/runtime"`.
 * One source of truth, two delivery shapes.
 *
 * Replaces the prior approach where Astro statically baked product cards
 * from a build-time products.ts. Now the agent emits empty grid shells
 * with an in-page <template> defining one card; this script clones the
 * template once per product fetched from the SDK at page load.
 *
 * Why: curation changes (merchant picks/unpicks products in Manage
 * Catalog, an external agent like Replit previews a custom selection)
 * reflect on iframe reload without redeploying. There are no static
 * cards to filter; the runtime renders fresh against whatever set the
 * caller (live API or override) returned.
 *
 * v2 (multi-grid): each `data-oz-product-grid` on the page resolves to
 * its OWN fetch — no more "fetch everything, filter client-side". The
 * routing table:
 *
 *   ""              → GET /api/products                 (all curated)
 *   "all"           → GET /api/products
 *   "tag:oz-grid-x" → GET /api/grids/x                  (named grid; uses Grid.productOrder)
 *   "tag:foo"       → GET /api/products?tags=foo        (free-form tag)
 *   "tags:a,b"      → GET /api/products?tags=a,b
 *   "group:hats"    → GET /api/products?groups=hats
 *   "groups:a,b"    → GET /api/products?groups=a,b
 *
 * Render contract:
 *
 *   <section data-oz-product-grid="tag:oz-grid-featured">
 *     <template data-oz-product-card>
 *       <article class="card">
 *         <img data-oz-bind="imageUrl" alt="">
 *         <h3 data-oz-bind="name"></h3>
 *         <p data-oz-bind="price" data-oz-format="currency"></p>
 *         <a data-oz-bind-href="/products/${slug}">View</a>
 *         <button data-add-to-cart
 *                 data-oz-bind-attr="product-id:_id,product-name:name,product-price:price,product-image:imageUrl,product-currency:currency,product-requires-shipping:requiresShipping">
 *           Add to cart
 *         </button>
 *       </article>
 *     </template>
 *     <div data-oz-grid-empty>No products yet.</div>
 *   </section>
 *
 * Override channels — when present, the runtime skips the curated-set
 * fetch and renders the override products instead. Priority order:
 *
 *   1. window.__OZURA_PRODUCT_OVERRIDE = [{ _id, name, ... }, ...]
 *      or [id1, id2, id3] — set by a parent frame BEFORE this script runs.
 *      Applies to ALL grids on the page (no per-grid targeting from the
 *      window channel; this stays compatible with v1 SDK consumers).
 *
 *   2. postMessage({ type: "ozura:catalog-preview", productIds: [...], gridSlug?: "featured" })
 *      Origin-gated like the theme bridge. When `gridSlug` is set, only
 *      that grid re-renders; otherwise all grids on the page re-render
 *      against the override (useful for the dashboard's "All products"
 *      curation preview).
 *
 *   3. ?ozPreviewProducts=id1,id2,id3 URL param — applies to all grids.
 *
 * The cart wiring is unchanged — ozura-cart.js still binds
 * [data-add-to-cart] clicks. The bind attributes above stamp the
 * needed data-product-* fields onto the button so the cart picks them
 * up without any agent-side changes.
 */
/**
 * The full storefront runtime script as a string. Inline this into
 * server-rendered HTML, or `import` it from
 * `@ozura/storefront-sdk/runtime` and stamp into your build output.
 *
 * For an externally-hostable copy (CDN-friendly), the same content is
 * emitted as a flat `.js` file in this package's
 * `dist/runtime/storefront.js` — jsDelivr serves it at
 * `https://cdn.jsdelivr.net/npm/@ozura/storefront-sdk@<ver>/dist/runtime/storefront.js`.
 */
export const STOREFRONT_RUNTIME_SCRIPT: string = `
(function() {
  if (window.__OZURA_STOREFRONT_BOOTED) return;
  window.__OZURA_STOREFRONT_BOOTED = true;

  /** Origins allowed to drive previews via postMessage. */
  var ALLOWED_PREVIEW_ORIGINS = [
    /^https:\\/\\/(dev-)?dashboard\\.ozura\\.com$/,
    /^https:\\/\\/[a-z0-9-]+-ozura(-inc)?\\.vercel\\.app$/,
    /^http:\\/\\/localhost:\\d+$/,
    /^http:\\/\\/127\\.0\\.0\\.1:\\d+$/,
  ];

  var GRID_TAG_PREFIX = "oz-grid-";

  /* ── Filter parsing ──────────────────────────────────────────────
   * The data-oz-product-grid="…" value is parsed into a small object
   * with tags + groups arrays. Unrecognized prefixes are ignored
   * (forward-compat — future filters like price:lt:50 wouldn't break
   * a site rendering on an older runtime). */
  function parseFilter(raw) {
    if (!raw || raw === "all") return {};
    var out = {};
    var parts = raw.split(/[;\\s]+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      var idx = p.indexOf(":");
      if (idx <= 0) {
        // Bare token = grid slug shorthand (e.g. data-oz-product-grid="shop-catalog").
        // Routes to /api/grids/<slug> via the named-grid recognition in
        // routeForFilter. This is the form the codegen agent emits;
        // without this branch the runtime falls through to /api/products
        // (unscoped) and the merchant's grid curation + pageSize override
        // are silently ignored.
        out.tags = (out.tags || []).concat(["oz-grid-" + p]);
        continue;
      }
      var key = p.slice(0, idx).trim();
      var val = p.slice(idx + 1).trim();
      if (!val) continue;
      if (key === "tag" || key === "tags") {
        out.tags = (out.tags || []).concat(val.split(",").map(function(s) { return s.trim(); }).filter(Boolean));
      } else if (key === "group" || key === "groups") {
        out.groups = (out.groups || []).concat(val.split(",").map(function(s) { return s.trim(); }).filter(Boolean));
      }
    }
    return out;
  }

  /* ── Routing ─────────────────────────────────────────────────────
   * Returns { url, gridSlug?, baseUrl } describing where to fetch
   * products for a parsed filter. baseUrl excludes pagination params
   * so pagination can append ?page=N onto it. Named-grid recognition
   * has to be unambiguous: exactly one tag, starts with oz-grid-, no
   * group constraints. */
  function routeForFilter(filter, bust, pageSize, page) {
    var common = [];
    if (bust) common.push("_r=" + encodeURIComponent(bust));
    if (pageSize) common.push("limit=" + encodeURIComponent(pageSize));
    if (page && page > 1) common.push("page=" + encodeURIComponent(page));

    function withQs(base) {
      return common.length ? base + "?" + common.join("&") : base;
    }

    if (!filter.tags && !filter.groups) {
      return { baseUrl: "/api/products", url: withQs("/api/products") };
    }
    if (
      filter.tags &&
      filter.tags.length === 1 &&
      filter.tags[0].indexOf(GRID_TAG_PREFIX) === 0 &&
      !filter.groups
    ) {
      var slug = filter.tags[0].slice(GRID_TAG_PREFIX.length);
      var base = "/api/grids/" + encodeURIComponent(slug);
      return { gridSlug: slug, baseUrl: base, url: withQs(base) };
    }
    var parts = common.slice();
    if (filter.tags) parts.push("tags=" + encodeURIComponent(filter.tags.join(",")));
    if (filter.groups) parts.push("groups=" + encodeURIComponent(filter.groups.join(",")));
    var url = "/api/products" + (parts.length ? "?" + parts.join("&") : "");
    return { baseUrl: "/api/products", url: url };
  }

  /* ── Card rendering ──────────────────────────────────────────────
   * Clone the grid's <template data-oz-product-card>, walk every
   * data-oz-bind*, replace fields. Returns a DocumentFragment ready
   * to append. */
  function renderCard(template, product) {
    var node = template.content.firstElementChild.cloneNode(true);
    var binds = node.querySelectorAll("[data-oz-bind]");
    if (node.matches("[data-oz-bind]")) binds = Array.prototype.concat.call([node], Array.prototype.slice.call(binds));
    for (var i = 0; i < binds.length; i++) {
      var el = binds[i];
      var field = el.getAttribute("data-oz-bind");
      var v = product[field];
      if (v === undefined || v === null) v = "";
      var fmt = el.getAttribute("data-oz-format");
      if (fmt === "currency") {
        var n = Number(v);
        if (!isNaN(n)) v = (product.currency || "USD") + " " + n.toFixed(2);
      }
      var tag = el.tagName;
      if (tag === "IMG") el.setAttribute("src", String(v));
      else el.textContent = String(v);
    }
    var attrBinds = node.querySelectorAll("[data-oz-bind-attr]");
    if (node.matches("[data-oz-bind-attr]")) attrBinds = Array.prototype.concat.call([node], Array.prototype.slice.call(attrBinds));
    for (var j = 0; j < attrBinds.length; j++) {
      var aEl = attrBinds[j];
      var spec = aEl.getAttribute("data-oz-bind-attr");
      if (!spec) continue;
      var pairs = spec.split(",");
      for (var k = 0; k < pairs.length; k++) {
        var pair = pairs[k].split(":");
        if (pair.length !== 2) continue;
        var attrName = "data-" + pair[0].trim();
        var fName = pair[1].trim();
        var av = product[fName];
        if (av === undefined || av === null) av = "";
        aEl.setAttribute(attrName, String(av));
      }
    }
    var hrefBinds = node.querySelectorAll("[data-oz-bind-href]");
    if (node.matches("[data-oz-bind-href]")) hrefBinds = Array.prototype.concat.call([node], Array.prototype.slice.call(hrefBinds));
    for (var h = 0; h < hrefBinds.length; h++) {
      var hEl = hrefBinds[h];
      var tpl = hEl.getAttribute("data-oz-bind-href") || "";
      var resolved = tpl.replace(/\\$\\{([a-zA-Z_][a-zA-Z0-9_]*)\\}/g, function(_, k) {
        var rv = product[k];
        return rv === undefined || rv === null ? "" : String(rv);
      });
      hEl.setAttribute("href", resolved);
    }
    return node;
  }

  /** Fallback path for sites that don't emit <template data-oz-product-card>
   *  + data-oz-bind attributes. Walks the cloned card by DOM convention:
   *  first <img>, first heading, .price-classed element, /products/ links,
   *  [data-add-to-cart]. Covers the older agent emit pattern (and merchants
   *  who write their own card HTML without the bind contract). */
  function softBindCard(card, product) {
    try {
      var img = card.querySelector("img");
      if (img) {
        if (product.imageUrl) img.setAttribute("src", product.imageUrl);
        img.setAttribute("alt", product.name || "");
      }
      var heading = card.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading) {
        var headingLink = heading.querySelector("a");
        if (headingLink) headingLink.textContent = product.name || "";
        else heading.textContent = product.name || "";
      }
      var desc = card.querySelector(
        "[class*='description'], [class*='Description']"
      );
      if (desc && typeof product.description === "string") {
        desc.textContent = product.description;
      }
      var priceEl = card.querySelector("[class*='price'], [class*='Price']");
      if (priceEl) {
        var formatted;
        try {
          formatted = new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: product.currency || "USD",
          }).format(Number(product.price));
        } catch (_) {
          formatted = (product.currency || "USD") + " " + (product.price ?? "");
        }
        priceEl.textContent = formatted;
      }
      var slug = product.slug || (product._id ? String(product._id) : "");
      if (slug) {
        var links = card.querySelectorAll("a[href*='/products/']");
        for (var i = 0; i < links.length; i++) {
          links[i].setAttribute("href", "/products/" + slug);
        }
      }
      var addBtn = card.querySelector("[data-add-to-cart]");
      if (addBtn) {
        if (product._id) addBtn.setAttribute("data-product-id", String(product._id));
        if (product.name) addBtn.setAttribute("data-product-name", product.name);
        if (product.price !== undefined && product.price !== null)
          addBtn.setAttribute("data-product-price", String(product.price));
        if (product.currency) addBtn.setAttribute("data-product-currency", product.currency);
        if (product.imageUrl) addBtn.setAttribute("data-product-image", product.imageUrl);
        if (product.requiresShipping !== undefined)
          addBtn.setAttribute(
            "data-product-requires-shipping",
            String(!!product.requiresShipping),
          );
      }
    } catch (_) { /* defensive — never throw out of render */ }
    return card;
  }

  /** Locate or synthesize a card template for this grid. Returns
   *  { template, soft } where soft=true means the template was cloned
   *  from the first hardcoded product card (legacy agent output) and the
   *  caller should bind via softBindCard. Returns null if neither a
   *  proper <template> nor a clonable hardcoded card exists. */
  function resolveCardTemplate(grid) {
    var t = grid.querySelector("template[data-oz-product-card]");
    if (t) return { template: t, soft: false };
    // Soft-template fallback: find the first direct child of the grid
    // that looks like a product card (contains [data-add-to-cart]).
    // Walk up from the button so we capture the full card wrapper, not
    // just the button.
    var addBtn = grid.querySelector("[data-add-to-cart]");
    if (!addBtn) return null;
    var node = addBtn;
    while (node && node.parentNode !== grid) {
      node = node.parentNode;
    }
    if (!node || node.parentNode !== grid) return null;
    var clone = node.cloneNode(true);
    return { template: clone, soft: true };
  }

  function renderGrid(grid, products, appendOnly) {
    var resolved = resolveCardTemplate(grid);
    if (!resolved) return;
    var template = resolved.template;
    var soft = resolved.soft;
    var empty = grid.querySelector("[data-oz-grid-empty]");
    // Only clear the existing children when we actually have
    // replacements. Two reasons:
    //
    //   1. Soft-template (agent emitted hardcoded <article> placeholders
    //      with real seed-product data, no <template>). If the grid's
    //      backend record is empty (Featured grid not seeded yet, etc.),
    //      we'd clear the agent's perfectly good placeholders and
    //      replace them with nothing — blank section. Keep them.
    //
    //   2. Bind-template (proper <template> + data-oz-bind=...). Same
    //      principle: an empty API response shouldn't nuke whatever
    //      structural fallback the agent put in.
    //
    // Pagination state changes (e.g. page 1 → page 2) ALWAYS have
    // replacements, so this guard never blocks the page-replace path.
    var willHaveReplacements = !!(products && products.length > 0);
    if (!appendOnly && willHaveReplacements) {
      // Clear ALL non-structural children of the grid, not just the
      // ones we tagged with [data-oz-rendered]. Keep only the proper
      // template (when present) + the empty-state + pagination nav +
      // (legacy) load-more button. The soft-template path doesn't keep
      // the template node (it's a runtime clone, not in the DOM).
      var keep = [];
      if (!soft) keep.push(template);
      if (empty) keep.push(empty);
      var nav = grid.querySelector("[data-oz-pagination]");
      if (nav) keep.push(nav);
      var legacyBtn = grid.querySelector("[data-oz-load-more]");
      if (legacyBtn) keep.push(legacyBtn);
      var children = Array.prototype.slice.call(grid.children);
      for (var c = 0; c < children.length; c++) {
        var keepIt = false;
        for (var k = 0; k < keep.length; k++) {
          if (keep[k] === children[c]) { keepIt = true; break; }
        }
        if (!keepIt) children[c].remove();
      }
    }
    if (!products || products.length === 0) {
      if (!appendOnly && empty) empty.style.display = "";
      return;
    }
    if (empty) empty.style.display = "none";

    // Pick a render strategy + an anchor.
    //
    // Bind path (soft=false): the agent emitted <template data-oz-bind=...>.
    // anchor = the <template> node in the DOM. New cards insert after it
    // (or after the last rendered card when appending).
    //
    // Soft path (soft=true): the template is a runtime clone — NOT in the
    // DOM, so it has no parentNode + insertBefore would throw. anchor =
    // the grid container; we append each card directly.
    var anchor;
    if (soft) {
      anchor = null;
      if (appendOnly) {
        var rendered = grid.querySelectorAll("[data-oz-rendered]");
        if (rendered.length > 0) anchor = rendered[rendered.length - 1];
      }
    } else {
      anchor = template;
      if (appendOnly) {
        var renderedT = grid.querySelectorAll("[data-oz-rendered]");
        if (renderedT.length > 0) anchor = renderedT[renderedT.length - 1];
      }
    }

    for (var i = 0; i < products.length; i++) {
      var card;
      if (soft) {
        card = template.cloneNode(true);
        softBindCard(card, products[i]);
      } else {
        card = renderCard(template, products[i]);
      }
      if (!card) continue;
      card.setAttribute("data-oz-rendered", "1");
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(card, anchor.nextSibling);
      } else {
        // No anchor yet (soft-path, first card of this render). Insert
        // BEFORE the pagination nav / empty-state so cards land in the
        // visible grid area, not after the bottom controls. Falls back
        // to appendChild when no nav/empty exists.
        var insertBefore = grid.querySelector("[data-oz-pagination]")
          || grid.querySelector("[data-oz-grid-empty]")
          || null;
        if (insertBefore) {
          grid.insertBefore(card, insertBefore);
        } else {
          grid.appendChild(card);
        }
      }
      anchor = card;
    }
  }

  /* ── Pagination state ─────────────────────────────────────────────
   * Per-grid: track which page we're on + whether more pages exist
   * + the page size pulled from data-oz-page-size. Drives the
   * pagination nav. */
  function getPageSize(grid) {
    var raw = grid.getAttribute("data-oz-page-size");
    if (!raw) return 0;
    var n = parseInt(raw, 10);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(100, Math.max(1, n));
  }

  /** Page-number window for the pagination nav. Always shows first +
   *  last, the current + its neighbors, and ellipses where there are
   *  gaps. e.g. on page 5 of 12: [1] ... [4] [5] [6] ... [12]. Avoids a
   *  60-button strip for catalogs with many pages while keeping the
   *  current position obvious. */
  function paginationWindow(current, total) {
    if (total <= 7) {
      var all = [];
      for (var k = 1; k <= total; k++) all.push(k);
      return all;
    }
    var pages = [1];
    var start = Math.max(2, current - 1);
    var end = Math.min(total - 1, current + 1);
    if (start > 2) pages.push("...");
    for (var i = start; i <= end; i++) pages.push(i);
    if (end < total - 1) pages.push("...");
    pages.push(total);
    return pages;
  }

  /** Build / refresh the auto-injected pagination strip below the grid.
   *  Replaces the older "Load more" button approach — clicking a page
   *  number REPLACES the rendered cards and scrolls the grid into view
   *  at the top, so the merchant gets a clear "I'm on a new page" cue
   *  instead of cards silently appending below the fold. */
  function renderPagination(grid, entry) {
    var nav = grid.querySelector("[data-oz-pagination]");
    var needed = entry.pageSize && entry.totalPages > 1;
    if (!nav && needed) {
      nav = document.createElement("nav");
      nav.setAttribute("data-oz-pagination", "");
      nav.className = "oz-pagination";
      nav.setAttribute("aria-label", "Pagination");
      nav.style.cssText =
        "display:flex;flex-wrap:wrap;align-items:center;justify-content:center;" +
        "gap:6px;margin:32px auto 0;padding-top:8px;font:inherit;";
      grid.appendChild(nav);
    }
    if (!nav) return;
    if (!needed) {
      nav.style.display = "none";
      return;
    }
    nav.style.display = "";

    // Rebuild every render so the current-page highlight + window stay
    // accurate. Cheap — at most ~9 buttons.
    nav.innerHTML = "";

    var makeBtn = function(label, targetPage, opts) {
      opts = opts || {};
      var b = document.createElement("button");
      b.setAttribute("type", "button");
      b.className = "oz-pagination-btn" + (opts.current ? " oz-pagination-btn-current" : "");
      b.textContent = label;
      var current = opts.current === true;
      var disabled = opts.disabled === true;
      // Subtle highlight for the current page — bold + tinted background +
      // accent border. Doesn't invert the text color (the previous attempt
      // had currentColor resolve AFTER the white text override, so the
      // current button rendered white-on-white).
      b.style.cssText =
        "min-width:36px;padding:6px 10px;font:inherit;cursor:" +
        (disabled ? "not-allowed" : "pointer") + ";" +
        "background:" + (current ? "rgba(0,0,0,0.08)" : "transparent") + ";" +
        "color:inherit;" +
        "border:1px solid " + (current ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,.15)") + ";" +
        "border-radius:6px;opacity:" + (disabled ? "0.4" : "1") + ";" +
        "font-weight:" + (current ? "700" : "400") + ";" +
        "transition:background .12s ease, border-color .12s ease;";
      if (disabled || current) {
        b.setAttribute("disabled", "disabled");
      } else {
        b.addEventListener("click", function() { goToPage(grid, entry, targetPage); });
      }
      if (current) b.setAttribute("aria-current", "page");
      return b;
    };

    var current = entry.page;
    var total = entry.totalPages;

    nav.appendChild(makeBtn("← Prev", current - 1, {
      disabled: current <= 1,
    }));

    var win = paginationWindow(current, total);
    for (var i = 0; i < win.length; i++) {
      var v = win[i];
      if (v === "...") {
        var span = document.createElement("span");
        span.textContent = "…";
        span.style.cssText = "padding:0 4px;opacity:0.6;";
        nav.appendChild(span);
      } else {
        nav.appendChild(
          makeBtn(String(v), v, { current: v === current }),
        );
      }
    }

    nav.appendChild(makeBtn("Next →", current + 1, {
      disabled: current >= total,
    }));

    // Range label: "Showing 25–48 of 111" — tells the merchant exactly
    // what window of the catalog they're looking at.
    var fromN = (current - 1) * entry.pageSize + 1;
    var toN = Math.min(entry.total, current * entry.pageSize);
    var status = document.createElement("span");
    status.className = "oz-pagination-status";
    status.style.cssText =
      "width:100%;text-align:center;margin-top:6px;font-size:0.8em;opacity:0.7;";
    status.textContent = "Showing " + fromN + "–" + toN + " of " + entry.total;
    nav.appendChild(status);
  }

  /** Write the page number into the URL so refresh + back/forward work
   *  as merchants expect. Single-grid-per-page assumption: we use one
   *  shared ?page= param; if a future page has two paginated grids,
   *  they'll trample each other (acceptable trade — a real catalog
   *  page has one grid). "replace" is used by the popstate handler so
   *  we don't churn history when navigating via back/forward. */
  function syncUrlPage(page, mode) {
    try {
      var url = new URL(window.location.href);
      if (page <= 1) {
        url.searchParams.delete("page");
      } else {
        url.searchParams.set("page", String(page));
      }
      var newUrl = url.pathname + (url.search ? url.search : "") + url.hash;
      if (mode === "replace") {
        window.history.replaceState({ ozPage: page }, "", newUrl);
      } else {
        window.history.pushState({ ozPage: page }, "", newUrl);
      }
    } catch (_) { /* SSR / older browsers — silently ignore */ }
  }

  function readUrlPage() {
    try {
      var p = new URLSearchParams(window.location.search);
      var n = parseInt(p.get("page") || "", 10);
      if (!isFinite(n) || n < 1) return 1;
      return n;
    } catch (_) { return 1; }
  }

  function goToPage(grid, entry, targetPage, opts) {
    opts = opts || {};
    if (entry.loading) return;
    if (!entry.totalPages || targetPage < 1 || targetPage > entry.totalPages) return;
    if (targetPage === entry.page) return;
    entry.loading = true;
    var route = routeForFilter(entry.filter, getBust(), entry.pageSize, targetPage);
    fetch(route.url, { credentials: "omit" })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        var prods = data.products || (data.data && data.data.products) || [];
        // appendOnly=false → REPLACE existing cards. The merchant
        // expects "I'm on page 3 now," not "page 3 stacks on top of
        // page 2." Replace + scroll gives the clear feedback signal.
        renderGrid(grid, prods, false);
        var pg = data.pagination || {};
        entry.page = pg.page || targetPage;
        entry.hasMore = !!pg.hasMore;
        if (typeof pg.total === "number") entry.total = pg.total;
        if (typeof pg.limit === "number" && pg.limit > 0) entry.pageSize = pg.limit;
        entry.totalPages = entry.pageSize
          ? Math.max(1, Math.ceil(entry.total / entry.pageSize))
          : 1;
        renderPagination(grid, entry);
        // Reflect the new page in the URL so refresh and back/forward
        // do the right thing. opts.fromPopState=true means we got here
        // BECAUSE of a popstate event; in that case the URL is already
        // correct and pushing again would dirty history.
        if (!opts.fromPopState) {
          syncUrlPage(entry.page, "push");
        }
        // Scroll the grid top into view so the new page is visible
        // immediately — anchors the "I went to a new page" feedback.
        try {
          grid.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (e) { /* older Safari: ignore */ }
      })
      .catch(function() { /* leave page state untouched; user can retry */ })
      .then(function() { entry.loading = false; });
  }

  function urlOverrideIds() {
    try {
      var p = new URLSearchParams(window.location.search);
      var v = p.get("ozPreviewProducts");
      if (!v) return null;
      var arr = v.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
      return arr.length ? arr : null;
    } catch (_) {
      return null;
    }
  }

  function getBust() {
    try {
      var p = new URLSearchParams(window.location.search);
      return p.get("_r") || "";
    } catch (_) {
      return "";
    }
  }

  /** Hydrate ID list → product objects via /api/products?ids=. */
  function hydrate(input) {
    if (!Array.isArray(input)) return Promise.resolve([]);
    if (input.length === 0) return Promise.resolve([]);
    if (typeof input[0] === "object" && input[0] && input[0].name) {
      return Promise.resolve(input);
    }
    var ids = input.filter(function(x) { return typeof x === "string"; }).join(",");
    if (!ids) return Promise.resolve([]);
    return fetch("/api/products?ids=" + encodeURIComponent(ids), { credentials: "omit" })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return [];
        return data.products || (data.data && data.data.products) || [];
      })
      .catch(function() { return []; });
  }

  /** Fetch products for ONE grid container. Returns Promise<{products, pagination?}>. */
  function fetchForGrid(filter, pageSize, page) {
    var route = routeForFilter(filter, getBust(), pageSize, page);
    return fetch(route.url, { credentials: "omit" })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return { products: [], pagination: null };
        return {
          products: data.products || (data.data && data.data.products) || [],
          pagination: data.pagination || null,
        };
      })
      .catch(function() { return { products: [], pagination: null }; });
  }

  /** Cache of last-rendered products keyed by the grid element's index in
   *  document order — used when a postMessage override comes through with
   *  a gridSlug so we know which grid to re-render. */
  var gridIndex = [];

  function snapshotGrids() {
    var nodes = document.querySelectorAll("[data-oz-product-grid]");
    gridIndex = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var filter = parseFilter(el.getAttribute("data-oz-product-grid"));
      var route = routeForFilter(filter, "");
      gridIndex.push({
        el: el,
        filter: filter,
        gridSlug: route.gridSlug || null,
        pageSize: getPageSize(el),
        page: 1,
        hasMore: false,
        total: 0,
        totalPages: 0,
        loading: false,
      });
    }
  }

  function renderAllFromOverride(products) {
    snapshotGrids();
    for (var i = 0; i < gridIndex.length; i++) {
      renderGrid(gridIndex[i].el, products);
    }
  }

  function renderEachLive() {
    snapshotGrids();
    // Read the initial page from the URL (e.g. /shop?page=3) so deep
    // links land on the right page. Applied to the FIRST grid only;
    // pages with multiple paginated grids (rare) would need scoped
    // params, which we punt on.
    var initialPage = readUrlPage();
    var firstGridConsumed = false;
    for (var i = 0; i < gridIndex.length; i++) {
      (function(entry, isFirst) {
        var startPage = isFirst && initialPage > 1 ? initialPage : 1;
        fetchForGrid(entry.filter, entry.pageSize, startPage).then(function(out) {
          renderGrid(entry.el, out.products);
          var pg = out.pagination || {};
          entry.page = pg.page || startPage;
          entry.hasMore = !!pg.hasMore;
          entry.total = typeof pg.total === "number" ? pg.total : out.products.length;
          // Adopt the resolved page size from the server. The server
          // may have overridden our HTML-attribute value with the
          // merchant's per-grid Manage Catalog setting; subsequent
          // page navigations must use the same size or we'd skip rows
          // or duplicate them across pages.
          if (typeof pg.limit === "number" && pg.limit > 0) {
            entry.pageSize = pg.limit;
          }
          entry.totalPages = entry.pageSize
            ? Math.max(1, Math.ceil(entry.total / entry.pageSize))
            : 1;
          if (entry.pageSize) renderPagination(entry.el, entry);
          // If the URL had ?page=N but N is out of range now (catalog
          // shrunk between bookmarks), normalize the URL back to the
          // actual served page so refresh stays consistent.
          if (isFirst && initialPage > 1 && entry.page !== initialPage) {
            syncUrlPage(entry.page, "replace");
          }
        });
      })(gridIndex[i], !firstGridConsumed);
      if (gridIndex[i].pageSize) firstGridConsumed = true;
    }
  }

  // Browser back/forward: pull the page out of the new URL and
  // navigate the first paginated grid to it. Without this the URL
  // changes but the visible page doesn't.
  if (typeof window !== "undefined" && !window.__OZURA_POPSTATE_BOUND) {
    window.__OZURA_POPSTATE_BOUND = true;
    window.addEventListener("popstate", function() {
      var target = readUrlPage();
      for (var i = 0; i < gridIndex.length; i++) {
        var entry = gridIndex[i];
        if (entry.pageSize && entry.totalPages > 1) {
          goToPage(entry.el, entry, target, { fromPopState: true });
          break;
        }
      }
    });
  }

  function bootRender() {
    if (window.__OZURA_PRODUCT_OVERRIDE) {
      hydrate(window.__OZURA_PRODUCT_OVERRIDE).then(renderAllFromOverride);
      return;
    }
    var urlIds = urlOverrideIds();
    if (urlIds) {
      hydrate(urlIds).then(renderAllFromOverride);
      return;
    }
    renderEachLive();
  }

  /* ── postMessage preview channel ─────────────────────────────────
   * Accepted shapes:
   *   { type: "ozura:catalog-preview", productIds: [...] }
   *     → re-render every grid against the override
   *   { type: "ozura:catalog-preview", productIds: [...], gridSlug: "featured" }
   *     → re-render only the grid bound to oz-grid-<gridSlug>
   *   { type: "ozura:catalog-preview", clear: true }
   *     → drop the override, refetch each grid live (used by Manage
   *       Catalog dialog on unmount). */
  window.addEventListener("message", function(ev) {
    var origin = ev.origin || "";
    var ok = false;
    for (var i = 0; i < ALLOWED_PREVIEW_ORIGINS.length; i++) {
      if (ALLOWED_PREVIEW_ORIGINS[i].test(origin)) { ok = true; break; }
    }
    if (!ok) return;
    var data = ev.data;
    if (!data || data.type !== "ozura:catalog-preview") return;
    if (data.clear === true) {
      renderEachLive();
      return;
    }
    var override = data.productIds || data.products || null;
    if (!Array.isArray(override)) return;

    if (typeof data.gridSlug === "string" && data.gridSlug.length > 0) {
      snapshotGrids();
      var targetSlug = data.gridSlug;
      hydrate(override).then(function(prods) {
        for (var i = 0; i < gridIndex.length; i++) {
          if (gridIndex[i].gridSlug === targetSlug) {
            renderGrid(gridIndex[i].el, prods);
          }
        }
      });
      return;
    }
    hydrate(override).then(renderAllFromOverride);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootRender);
  } else {
    bootRender();
  }
})();
`;

/**
 * Back-compat function form. Conjure's deploy pipeline imports this
 * name — keep the export shape stable so we don't have to touch the
 * backend at the same moment as a runtime change.
 *
 * @deprecated Prefer `STOREFRONT_RUNTIME_SCRIPT` directly.
 */
export function getV2StorefrontScript(): string {
  return STOREFRONT_RUNTIME_SCRIPT;
}
