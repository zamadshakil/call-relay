import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "web",
  // The Vite root is cloud/web, while deployment configuration is kept in
  // cloud/.env.<mode>. Point Vite at that directory explicitly so a staging
  // build does not silently compile empty Firebase credentials.
  envDir: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
