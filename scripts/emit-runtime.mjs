#!/usr/bin/env node
/**
 * Build step that writes the storefront runtime script as a flat
 * `dist/runtime/storefront.js` file so it can be served verbatim via
 * jsDelivr / unpkg / any CDN that mirrors npm.
 *
 * The same string is also exported from `@ozura/storefront-sdk/runtime`
 * for SSR consumers that want to inline the script into their build
 * output rather than depend on a network fetch at page load.
 *
 * Why a separate emit step instead of letting tsup handle it: tsup
 * outputs JS modules (ESM/CJS), but we need a raw browser-targeted
 * IIFE script. The runtime is already plain ES5-ish JS embedded in a
 * TS template literal — we just unwrap and write it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STOREFRONT_RUNTIME_SCRIPT } from "../dist/runtime/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outFile = join(__dirname, "..", "dist", "runtime", "storefront.js");

// The string export wraps the IIFE in leading/trailing newlines from
// the template literal. Trim the outer whitespace but keep the
// internal formatting so it stays readable when curl'd.
const body = STOREFRONT_RUNTIME_SCRIPT.trim();

// Add a tiny header comment so anyone fetching the file directly knows
// what they're looking at without having to read package.json.
const banner = `/*! @ozura/storefront-sdk runtime — drop this into your HTML to render data-oz-product-grid containers from the Ozura backend. */`;

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${banner}\n${body}\n`, "utf8");

console.log(
  `[emit-runtime] wrote ${outFile} (${body.length} bytes)`,
);
