import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/bot.ts"],
  outDir: "./dist",
  dts: false,
  format: ["esm"],
  clean: true,
  splitting: false,
  sourcemap: true,
})
