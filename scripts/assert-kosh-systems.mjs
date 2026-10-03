import { readFile } from "node:fs/promises";

const files = {
  core: "packages/kosh-core/src/index.ts",
  gateway: "apps/gateway/src/kosh-systems.ts",
  index: "apps/gateway/src/index.ts",
  ui: "apps/web/src/app/apps/kosh/systems/page.tsx",
  docs: "docs/KOSH_SYSTEMS.md"
};

const content = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, path]) => [key, await readFile(path, "utf8")])
  )
);

function requireText(file, text, label = text) {
  if (!content[file].includes(text)) {
    throw new Error(`Kosh systems contract check failed: missing ${label} in ${files[file]}`);
  }
}

const activeModules = [
  "merge-queue",
  "advanced-projects",
  "release-management",
  "storage",
  "disaster-recovery",
  "observability",
  "administration",
  "extensions"
];

for (const id of activeModules) {
  const pattern = new RegExp(`id:\\s*[\"']${id}[\"'][\\s\\S]{0,420}?status:\\s*[\"']active[\"']`);
  if (!pattern.test(content.core)) {
    throw new Error(`Kosh systems contract check failed: ${id} is not active in kosh-core`);
  }
}

const repositoryRoutes = [
  "/merge-queue",
  "/projects",
  "/deployments",
  "/storage",
  "/recovery",
  "/observability"
];
for (const route of repositoryRoutes) requireText("gateway", route, `repository systems route ${route}`);

const globalRoutes = [
  "/v1/kosh/systems/observability",
  "/v1/kosh/systems/admin",
  "/v1/kosh/systems/extensions"
];
for (const route of globalRoutes) requireText("gateway", route, `global systems route ${route}`);

requireText("index", "handleKoshSystemsRequest", "gateway systems handler wiring");
requireText("gateway", "pre_restore_safety", "pre-restore safety backup");
requireText("gateway", "bundle", "Git bundle recovery verification");
requireText("gateway", "interactive_session_required", "interactive admin/extension mutation gate");
requireText("gateway", "repository.merge", "merge queue permission gate");
requireText("gateway", "releases.manage", "deployment permission gate");

const uiControls = [
  "Process queue",
  "Pause",
  "Resume",
  "Priority",
  "Field",
  "Iteration",
  "Promote",
  "Rollback",
  "Create restore point",
  "Administration",
  "Register disabled"
];
for (const control of uiControls) requireText("ui", control, `Systems UI control ${control}`);

const docSections = [
  "## 1. Merge Queue",
  "## 2. Advanced Project Management",
  "## 3. Release & Deployment Management",
  "## 4. Storage Layer",
  "## 5. Disaster Recovery",
  "## 6. Observability",
  "## 7. Administration",
  "## 8. Extension SDK"
];
for (const section of docSections) requireText("docs", section, section);

console.log("Kosh systems contract check passed: 8 active systems, guarded routes, recovery safety and operations UI are present.");
