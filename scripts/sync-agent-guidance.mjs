#!/usr/bin/env node
/**
 * Reads AGENTS.md and emits src/agent-guidance.ts that exports the
 * markdown as the AGENT_GUIDANCE_SDK string constant. Other repos
 * (dashboard prompt generator, Conjure codegen) import the constant so
 * canonical SDK guidance lives in one place.
 *
 * Run: `npm run sync:agents` (and check the resulting file in).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function main() {
  const md = await fs.readFile(path.join(ROOT, "AGENTS.md"), "utf-8");
  // Escape backticks and ${ for safe template-literal embedding.
  const escaped = md.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const out = `/**
 * Generated from AGENTS.md by scripts/sync-agent-guidance.mjs.
 * DO NOT EDIT BY HAND — edit AGENTS.md and re-run \`npm run sync:agents\`.
 *
 * This is the canonical guidance for AI agents using the storefront SDK.
 * Consumers (Conjure codegen system prompt, dashboard's IntegratePromptGenerator)
 * import this constant so there is exactly one source of truth.
 */
export const AGENT_GUIDANCE_SDK = \`${escaped}\`;
`;
  await fs.writeFile(path.join(ROOT, "src", "agent-guidance.ts"), out, "utf-8");
  console.log(`wrote src/agent-guidance.ts (${out.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
