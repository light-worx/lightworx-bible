const esbuild = require("esbuild");
const isProduction = process.argv[2] === "production";

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  external: ["obsidian", "electron"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: isProduction ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  loader: { ".wasm": "binary" },
}).catch(() => process.exit(1));