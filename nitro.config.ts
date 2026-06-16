import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  preset: "node-server",
  srcDir: "server",
  compatibilityDate: "2026-01-01",
  externals: {
    // pnpm2nix serves node_modules from the read-only Nix store. Nitro's
    // node-externals plugin copyFile's each external into
    // .output/server/node_modules/<pkg>/ preserving the source mode
    // (read-only), then overwrites its package.json with a stripped version —
    // which fails with EACCES on the read-only copy. chmod:true tells Nitro to
    // chmod each copy right after copyFile so the rewrite succeeds. No-op for a
    // normal (writable) `pnpm build`. The Agent SDK (CLI subprocess + native
    // sharp) is externalized automatically as a node_modules dep.
    chmod: true,
  },
});
