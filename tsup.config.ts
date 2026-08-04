import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["bin/convit.ts"],
  format: ["esm"], // Since package is "type": "module"
  target: "node22",
  clean: true,
  minify: true,
  treeshake: true,
  outDir: "dist",
  // Optional commitlint interop (P3-T4): never bundle @commitlint/load. It is an
  // optionalDependency, dynamic-imported and resolved from the user's project at
  // runtime — bundling it would bloat the lean single bin and break the
  // project-local `extends` resolution. Keeps dist ~49KB for everyone.
  external: ["@commitlint/load"],
  // Ensure the shebang is preserved
  banner: {
    js: "#!/usr/bin/env node",
  },
});
