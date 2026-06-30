import fs from "node:fs";
import path from "node:path";

const apiBase = process.argv[2];
if (!apiBase || !/^https:\/\//.test(apiBase)) {
  console.error("Usage: node scripts/configure-extension.mjs https://your-domain.vercel.app");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const files = ["extension-config.js", "background.js", "license-gate.js", "manifest.json"];

function replaceAll(file, from, to) {
  const full = path.join(root, file);
  const text = fs.readFileSync(full, "utf8");
  fs.writeFileSync(full, text.split(from).join(to));
}

for (const file of files) {
  replaceAll(file, "https://unlimitedprompts.lovable.app", apiBase.replace(/\/$/, ""));
}

console.log(`Extension configured for ${apiBase.replace(/\/$/, "")}`);
