import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["bin/convit.ts"],
  format: ["esm"], // Since package is "type": "module"
  target: "node18",
  clean: true,
  minify: true,
  treeshake: true,
  outDir: "dist",
  // Ensure the shebang is preserved
  banner: {
    js: "#!/usr/bin/env node",
  },
});
