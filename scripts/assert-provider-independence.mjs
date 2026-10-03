import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const blockedFragments = [
  ["open", "ai"].join(""),
  ["chat", "gpt"].join(""),
  ["api", ".", "open", "ai", ".com"].join(""),
  ["OPEN", "AI", "_API_KEY"].join("")
].map((value) => value.toLowerCase());

const allowedExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".yml", ".yaml", ".toml", ".rs",
  ".html", ".css", ".scss", ".env", ".txt"
]);

const skippedDirectories = new Set([
  ".git", "node_modules", ".next", "dist", "out", "target",
  "coverage", "build", ".vercel", ".turbo"
]);

const self = "scripts/assert-provider-independence.mjs";
const allowedExternalIntegrationPrefixes = [
  "apps/kosh-plugin/",
  "plugins/kosh/"
];
const allowedExternalIntegrationFiles = new Set([
  "docs/KOSH_CHATGPT_WEB_APP.md"
]);
const violations = [];

function isApprovedExternalIntegration(repoPath) {
  return (
    allowedExternalIntegrationFiles.has(repoPath) ||
    allowedExternalIntegrationPrefixes.some((prefix) => repoPath.startsWith(prefix))
  );
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const repoPath = relative(root, absolute).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) await walk(absolute);
      continue;
    }

    if (repoPath === self || isApprovedExternalIntegration(repoPath)) continue;
    if (
      !allowedExtensions.has(extname(entry.name).toLowerCase()) &&
      !entry.name.startsWith("package")
    ) {
      continue;
    }

    let content;
    try {
      content = (await readFile(absolute, "utf8")).toLowerCase();
    } catch {
      continue;
    }

    for (const fragment of blockedFragments) {
      if (content.includes(fragment)) {
        violations.push(repoPath);
        break;
      }
    }
  }
}

await walk(root);

if (violations.length) {
  console.error("Provider-independence check failed. Disallowed external assistant linkage found in:");
  for (const file of violations.sort()) console.error(" - " + file);
  process.exit(1);
}

console.log("Provider-independence check passed outside approved isolated plugin surfaces.");
