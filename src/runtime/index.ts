/**
 * Runtime subpath entry — re-exports the storefront catalog renderer so
 * consumers can `import { STOREFRONT_RUNTIME_SCRIPT, getV2StorefrontScript }
 * from "@ozura/storefront-sdk/runtime"`.
 *
 * The SAME source also gets emitted as a plain `dist/runtime/storefront.js`
 * file at build time (see `scripts/emit-runtime.mjs`) so external agents
 * can link the asset via jsDelivr without importing the SDK at all.
 */

export {
  STOREFRONT_RUNTIME_SCRIPT,
  getV2StorefrontScript,
} from "./storefront.js";
