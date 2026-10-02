import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  getKoshPlatformStore,
  type StoredKoshPlatformResource
} from "./kosh-platform-store.js";
import {
  getKoshStore,
  type StoredKoshRepository
} from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const repositoryRoot = resolve(
  process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos"
);

type JsonBody = Record<string, unknown>;
type CodeLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "cpp"
  | "java"
  | "go"
  | "rust";

export type KoshCodeSymbol = {
  id: string;
  path: string;
  language: CodeLanguage;
  name: string;
  qualifiedName: string;
  kind: string;
  line: number;
  column: number;
  signature: string;
  containerName: string | null;
};

export type KoshCodeReference = {
  id: string;
  path: string;
  language: CodeLanguage;
  symbolName: string;
  line: number;
  column: number;
  context: string;
};

export type KoshCodeOwnerRule = {
  pattern: string;
  owners: string[];
  sourcePath: string;
  sourceLine: number;
};

export type KoshCodeIndex = {
  id: string;
  repositoryId: string;
  refName: string;
  commitSha: string;
  baseIndexId: string | null;
  mode: "full" | "delta";
  changedPaths: string[];
  state: string;
  fileCount: number;
  symbolCount: number;
  referenceCount: number;
  languages: string[];
  errorText: string;
  symbols: KoshCodeSymbol[];
  references: KoshCodeReference[];
  owners: KoshCodeOwnerRule[];
  createdAt: string;
  updatedAt: string;
};

type ParsedDefinition = {
  name: string;
  kind: string;
  line: number;
  column: number;
  signature: string;
  containerName: string | null;
};

const extensionLanguage = new Map<string, CodeLanguage>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".c", "cpp"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".h", "cpp"],
  [".hh", "cpp"],
  [".hpp", "cpp"],
  [".hxx", "cpp"],
  [".java", "java"],
  [".go", "go"],
  [".rs", "rust"]
]);

const ignoredIdentifiers = new Set([
  "and","as","async","await","break","case","catch","class","const","continue",
  "def","default","delete","do","else","enum","export","extends","false","finally",
  "fn","for","from","func","function","if","implements","import","in","interface",
  "let","match","mod","new","nil","none","null","of","package","pass","private",
  "protected","public","record","return","self","static","struct","super","switch",
  "this","throw","trait","true","try","type","typeof","undefined","use","var",
  "void","while","with","yield"
]);

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins?.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 128 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function repositoryPath(repository: StoredKoshRepository) {
  const path = resolve(
    repositoryRoot,
    repository.namespace,
    repository.slug + ".git"
  );
  const prefix = repositoryRoot.endsWith(sep)
    ? repositoryRoot
    : repositoryRoot + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_repository_path"), { status: 400 });
  }
  return path;
}

async function git(
  gitDir: string,
  args: string[],
  maxBuffer = 16 * 1024 * 1024
) {
  try {
    const result = await execFileAsync("git", ["--git-dir", gitDir, ...args], {
      timeout: 30_000,
      maxBuffer,
      encoding: "utf8"
    });
    return String(result.stdout);
  } catch (error) {
    throw Object.assign(new Error("git_command_failed"), {
      status: 500,
      cause: error
    });
  }
}

async function resolveCommit(
  repository: StoredKoshRepository,
  requestedRef: string
) {
  const gitDir = repositoryPath(repository);
  const ref = requestedRef.trim() || repository.defaultBranch;
  if (ref.length > 300 || ref.includes("\0")) {
    throw Object.assign(new Error("invalid_ref"), { status: 400 });
  }

  const candidates = /^[0-9a-f]{7,40}$/i.test(ref)
    ? [ref]
    : ["refs/heads/" + ref, "refs/tags/" + ref];

  for (const candidate of candidates) {
    try {
      const result = await execFileAsync(
        "git",
        ["--git-dir", gitDir, "rev-parse", "--verify", candidate + "^{commit}"],
        { timeout: 10_000, encoding: "utf8" }
      );
      const sha = String(result.stdout).trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
    } catch {
      // Try the next explicit namespace.
    }
  }

  throw Object.assign(new Error("ref_not_found"), { status: 404 });
}

function languageForPath(path: string): CodeLanguage | null {
  return extensionLanguage.get(extname(path).toLowerCase()) ?? null;
}

function maxFiles() {
  const configured = Number(process.env.KOSH_CODE_INDEX_MAX_FILES ?? 3000);
  return Number.isFinite(configured)
    ? Math.max(100, Math.min(20000, Math.floor(configured)))
    : 3000;
}

function maxFileBytes() {
  const configured = Number(process.env.KOSH_CODE_INDEX_MAX_FILE_KB ?? 512);
  const kb = Number.isFinite(configured)
    ? Math.max(32, Math.min(4096, configured))
    : 512;
  return Math.floor(kb * 1024);
}

function maxReferencesPerFile() {
  const configured = Number(
    process.env.KOSH_CODE_INDEX_MAX_REFERENCES_PER_FILE ?? 750
  );
  return Number.isFinite(configured)
    ? Math.max(100, Math.min(5000, Math.floor(configured)))
    : 750;
}

async function listSupportedFiles(
  repository: StoredKoshRepository,
  commitSha: string
) {
  const output = await git(
    repositoryPath(repository),
    ["ls-tree", "-r", "--name-only", commitSha],
    32 * 1024 * 1024
  );
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => languageForPath(path))
    .slice(0, maxFiles());
}

async function changedCodePaths(
  repository: StoredKoshRepository,
  baseSha: string,
  commitSha: string
) {
  const output = await git(
    repositoryPath(repository),
    ["diff", "--name-only", baseSha, commitSha, "--"],
    16 * 1024 * 1024
  );
  return [...new Set(
    output
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((path) => languageForPath(path))
  )];
}

async function readBlob(
  repository: StoredKoshRepository,
  commitSha: string,
  path: string
) {
  if (
    path.length > 2048 ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }

  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", repositoryPath(repository), "show", commitSha + ":" + path],
      {
        timeout: 15_000,
        maxBuffer: maxFileBytes(),
        encoding: "utf8"
      }
    );
    const text = String(result.stdout);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

function definitionsForLine(
  language: CodeLanguage,
  line: string,
  lineNumber: number
): ParsedDefinition[] {
  const patterns: Array<{ kind: string; expression: RegExp }> = [];

  if (language === "typescript" || language === "javascript") {
    patterns.push(
      { kind: "class", expression: /\bclass\s+([A-Za-z_$][\w$]*)/ },
      { kind: "interface", expression: /\binterface\s+([A-Za-z_$][\w$]*)/ },
      { kind: "type", expression: /\btype\s+([A-Za-z_$][\w$]*)\s*=/ },
      { kind: "enum", expression: /\benum\s+([A-Za-z_$][\w$]*)/ },
      { kind: "function", expression: /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/ },
      {
        kind: "function",
        expression: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
      }
    );
  } else if (language === "python") {
    patterns.push(
      { kind: "class", expression: /^\s*class\s+([A-Za-z_]\w*)/ },
      { kind: "function", expression: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ }
    );
  } else if (language === "cpp") {
    patterns.push(
      { kind: "class", expression: /\b(?:class|struct)\s+([A-Za-z_]\w*)/ },
      { kind: "enum", expression: /\benum(?:\s+class)?\s+([A-Za-z_]\w*)/ },
      {
        kind: "function",
        expression: /^\s*(?:[\w:<>,~*&]+\s+)+([A-Za-z_~]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:\{|$)/
      }
    );
  } else if (language === "java") {
    patterns.push(
      { kind: "class", expression: /\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/ },
      {
        kind: "method",
        expression: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native)\s+)*(?:[\w<>\[\],.?]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?\{?\s*$/
      }
    );
  } else if (language === "go") {
    patterns.push(
      { kind: "type", expression: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|\w+)/ },
      { kind: "function", expression: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/ }
    );
  } else if (language === "rust") {
    patterns.push(
      { kind: "struct", expression: /\bstruct\s+([A-Za-z_]\w*)/ },
      { kind: "enum", expression: /\benum\s+([A-Za-z_]\w*)/ },
      { kind: "trait", expression: /\btrait\s+([A-Za-z_]\w*)/ },
      { kind: "function", expression: /\bfn\s+([A-Za-z_]\w*)\s*[<(]/ }
    );
  }

  const found: ParsedDefinition[] = [];
  for (const pattern of patterns) {
    const match = pattern.expression.exec(line);
    const name = match?.[1];
    if (!name) continue;
    found.push({
      name,
      kind: pattern.kind,
      line: lineNumber,
      column: Math.max(1, line.indexOf(name) + 1),
      signature: line.trim().slice(0, 400),
      containerName: null
    });
  }
  return found;
}

function parseFile(path: string, language: CodeLanguage, text: string) {
  const symbols: KoshCodeSymbol[] = [];
  const references: KoshCodeReference[] = [];
  const lines = text.split(/\r?\n/);
  let container: { name: string; indent: number } | null = null;
  let referenceBudget = maxReferencesPerFile();

  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset] ?? "";
    const lineNumber = offset + 1;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;

    if (container && line.trim() && indent <= container.indent) {
      container = null;
    }

    const definitions = definitionsForLine(language, line, lineNumber);
    for (const definition of definitions) {
      const containerName = container?.name ?? null;
      symbols.push({
        id: randomUUID(),
        path,
        language,
        name: definition.name,
        qualifiedName: containerName
          ? containerName + "." + definition.name
          : definition.name,
        kind: definition.kind,
        line: definition.line,
        column: definition.column,
        signature: definition.signature,
        containerName
      });

      if (
        definition.kind === "class" ||
        definition.kind === "interface" ||
        definition.kind === "struct" ||
        definition.kind === "trait"
      ) {
        container = { name: definition.name, indent };
      }
    }

    if (referenceBudget <= 0) continue;
    const expression = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(line)) && referenceBudget > 0) {
      const name = match[0];
      if (
        name.length < 2 ||
        ignoredIdentifiers.has(name.toLowerCase()) ||
        /^\d/.test(name)
      ) {
        continue;
      }
      references.push({
        id: randomUUID(),
        path,
        language,
        symbolName: name,
        line: lineNumber,
        column: match.index + 1,
        context: line.trim().slice(0, 400)
      });
      referenceBudget -= 1;
    }
  }

  return { symbols, references };
}

const codeOwnerCandidates = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS"
];

async function parseOwners(
  repository: StoredKoshRepository,
  commitSha: string
) {
  for (const sourcePath of codeOwnerCandidates) {
    const text = await readBlob(repository, commitSha, sourcePath);
    if (text == null) continue;
    const rules: KoshCodeOwnerRule[] = [];
    for (const [offset, rawLine] of text.split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/).filter(Boolean);
      const pattern = parts.shift() ?? "";
      const owners = parts.filter((value) => value.startsWith("@"));
      if (!pattern || !owners.length) continue;
      rules.push({
        pattern,
        owners,
        sourcePath,
        sourceLine: offset + 1
      });
    }
    return rules;
  }
  return [];
}

function globPattern(pattern: string) {
  let source = pattern.trim().replace(/^\/+/, "");
  const anchored = !source.startsWith("**/");
  source = source
    .replace(/[.+^$(){}|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  if (pattern.endsWith("/")) source += ".*";
  return new RegExp((anchored ? "^" : "(?:^|.*/)") + source + "$");
}

export function ownersForKoshCodePath(
  path: string,
  rules: KoshCodeOwnerRule[]
) {
  let owners: string[] = [];
  for (const rule of rules) {
    try {
      if (globPattern(rule.pattern).test(path)) owners = rule.owners;
    } catch {
      // Ignore malformed CODEOWNERS rules.
    }
  }
  return owners;
}

function payloadArray<T>(
  payload: Record<string, unknown>,
  key: string
): T[] {
  const value = payload[key];
  return Array.isArray(value) ? value as T[] : [];
}

function resourceToIndex(
  resource: StoredKoshPlatformResource
): KoshCodeIndex {
  const payload = resource.payload;
  return {
    id: resource.id,
    repositoryId: resource.repositoryId ?? "",
    refName: String(payload.refName ?? resource.key),
    commitSha: String(payload.commitSha ?? resource.key),
    baseIndexId: payload.baseIndexId ? String(payload.baseIndexId) : null,
    mode: payload.mode === "delta" ? "delta" : "full",
    changedPaths: payloadArray<string>(payload, "changedPaths"),
    state: resource.state,
    fileCount: Number(payload.fileCount ?? 0),
    symbolCount: Number(payload.symbolCount ?? 0),
    referenceCount: Number(payload.referenceCount ?? 0),
    languages: payloadArray<string>(payload, "languages"),
    errorText: String(payload.errorText ?? ""),
    symbols: payloadArray<KoshCodeSymbol>(payload, "symbols"),
    references: payloadArray<KoshCodeReference>(payload, "references"),
    owners: payloadArray<KoshCodeOwnerRule>(payload, "owners"),
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt
  };
}

async function listCodeIndexes(repositoryId: string) {
  await platformStore.ready();
  return (await platformStore.listResources("code_index", repositoryId))
    .map(resourceToIndex)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function codeIndexById(id: string) {
  const resource = await platformStore.getResource(id);
  if (!resource || resource.type !== "code_index") return null;
  return resourceToIndex(resource);
}

async function codeIndexForCommit(
  repositoryId: string,
  commitSha: string
) {
  return (await listCodeIndexes(repositoryId)).find(
    (item) => item.commitSha === commitSha
  ) ?? null;
}

export async function latestKoshCodeIndex(repositoryId: string) {
  return (await listCodeIndexes(repositoryId)).find(
    (item) => item.state === "ready"
  ) ?? null;
}

async function indexChain(index: KoshCodeIndex) {
  const chain: KoshCodeIndex[] = [];
  const seen = new Set<string>();
  let current: KoshCodeIndex | null = index;

  while (current && !seen.has(current.id) && chain.length < 20) {
    chain.push(current);
    seen.add(current.id);
    current = current.baseIndexId
      ? await codeIndexById(current.baseIndexId)
      : null;
  }
  return chain;
}

async function effectiveSymbols(
  index: KoshCodeIndex,
  query = "",
  kind = "",
  language = "",
  limit = 1000
) {
  const output: KoshCodeSymbol[] = [];
  const shadowed = new Set<string>();
  const q = query.toLowerCase();

  for (const layer of await indexChain(index)) {
    for (const item of layer.symbols) {
      if (shadowed.has(item.path)) continue;
      if (
        q &&
        !item.name.toLowerCase().includes(q) &&
        !item.qualifiedName.toLowerCase().includes(q)
      ) {
        continue;
      }
      if (kind && item.kind !== kind) continue;
      if (language && item.language !== language) continue;
      output.push(item);
      if (output.length >= limit) return output;
    }
    for (const path of layer.changedPaths) shadowed.add(path);
  }

  return output;
}

async function effectiveReferences(
  index: KoshCodeIndex,
  symbolName = "",
  limit = 5000
) {
  const output: KoshCodeReference[] = [];
  const shadowed = new Set<string>();
  const q = symbolName.toLowerCase();

  for (const layer of await indexChain(index)) {
    for (const item of layer.references) {
      if (shadowed.has(item.path)) continue;
      if (q && item.symbolName.toLowerCase() !== q) continue;
      output.push(item);
      if (output.length >= limit) return output;
    }
    for (const path of layer.changedPaths) shadowed.add(path);
  }

  return output;
}

async function effectiveOwners(index: KoshCodeIndex) {
  for (const layer of await indexChain(index)) {
    if (layer.owners.length) return layer.owners;
  }
  return [];
}

function publicIndex(index: KoshCodeIndex) {
  const { symbols, references, owners, ...summary } = index;
  return summary;
}

async function audit(
  repositoryId: string,
  actor: { id: string; displayName: string } | null,
  eventType: string,
  index: KoshCodeIndex
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor?.id ?? null,
    actorName: actor?.displayName ?? "Kosh",
    eventType,
    resourceType: "code_index",
    resourceId: index.id,
    metadata: {
      refName: index.refName,
      commitSha: index.commitSha,
      mode: index.mode,
      fileCount: index.fileCount,
      symbolCount: index.symbolCount,
      referenceCount: index.referenceCount
    }
  });
}

export async function indexKoshRepositoryCode(
  repository: StoredKoshRepository,
  refName: string
) {
  await platformStore.ready();
  const commitSha = await resolveCommit(repository, refName);
  const existing = await codeIndexForCommit(repository.id, commitSha);
  if (existing?.state === "ready") return existing;

  const previous = await latestKoshCodeIndex(repository.id);
  const allFiles = await listSupportedFiles(repository, commitSha);
  const allFileSet = new Set(allFiles);
  const chainDepth = previous ? (await indexChain(previous)).length : 0;

  let mode: "full" | "delta" =
    previous && chainDepth < 16 ? "delta" : "full";
  let changedPaths = allFiles;

  if (mode === "delta" && previous) {
    changedPaths = await changedCodePaths(
      repository,
      previous.commitSha,
      commitSha
    );
    if (
      changedPaths.length >
      Math.max(1500, Math.floor(allFiles.length * 0.6))
    ) {
      mode = "full";
      changedPaths = allFiles;
    }
  }

  const initialPayload = {
    refName,
    commitSha,
    baseIndexId: mode === "delta" ? previous?.id ?? null : null,
    mode,
    changedPaths,
    fileCount: 0,
    symbolCount: 0,
    referenceCount: 0,
    languages: [],
    errorText: "",
    symbols: [],
    references: [],
    owners: []
  };

  const resource = existing
    ? await platformStore.updateResource(existing.id, {
        state: "indexing",
        payload: initialPayload
      })
    : await platformStore.createResource({
        repositoryId: repository.id,
        namespace: repository.namespace,
        type: "code_index",
        key: commitSha,
        name: "Code index " + commitSha.slice(0, 12),
        state: "indexing",
        payload: initialPayload,
        createdByUserId: "kosh-code-intelligence",
        createdByName: "Kosh Code Intelligence"
      });

  if (!resource) {
    throw Object.assign(new Error("code_index_not_found"), { status: 404 });
  }

  const targetPaths =
    mode === "full"
      ? allFiles
      : changedPaths.filter((path) => allFileSet.has(path));

  const symbols: KoshCodeSymbol[] = [];
  const references: KoshCodeReference[] = [];

  try {
    for (const path of targetPaths) {
      const language = languageForPath(path);
      if (!language) continue;
      const text = await readBlob(repository, commitSha, path);
      if (text == null) continue;
      const parsed = parseFile(path, language, text);
      symbols.push(...parsed.symbols);
      references.push(...parsed.references);
    }

    const owners = await parseOwners(repository, commitSha);
    let symbolCount = symbols.length;
    let referenceCount = references.length;

    if (mode === "delta" && previous) {
      const changed = new Set(changedPaths);
      const [oldSymbols, oldReferences] = await Promise.all([
        effectiveSymbols(previous, "", "", "", 100000),
        effectiveReferences(previous, "", 150000)
      ]);
      symbolCount =
        previous.symbolCount -
        oldSymbols.filter((item) => changed.has(item.path)).length +
        symbols.length;
      referenceCount =
        previous.referenceCount -
        oldReferences.filter((item) => changed.has(item.path)).length +
        references.length;
    }

    const languages = [...new Set(
      allFiles
        .map((path) => languageForPath(path))
        .filter((value): value is CodeLanguage => Boolean(value))
    )].sort();

    const updated = await platformStore.updateResource(resource.id, {
      state: "ready",
      payload: {
        ...initialPayload,
        fileCount: allFiles.length,
        symbolCount: Math.max(0, symbolCount),
        referenceCount: Math.max(0, referenceCount),
        languages,
        symbols,
        references,
        owners
      }
    });

    if (!updated) {
      throw Object.assign(new Error("code_index_not_found"), { status: 404 });
    }
    return resourceToIndex(updated);
  } catch (error) {
    await platformStore.updateResource(resource.id, {
      state: "failed",
      payload: {
        ...initialPayload,
        errorText:
          error instanceof Error
            ? error.message.slice(0, 2000)
            : "code_index_failed"
      }
    });
    throw error;
  }
}

async function selectedIndex(
  repository: StoredKoshRepository,
  commitSha: string
) {
  const index = commitSha
    ? await codeIndexForCommit(repository.id, commitSha)
    : await latestKoshCodeIndex(repository.id);

  if (!index || index.state !== "ready") {
    throw Object.assign(
      new Error(commitSha ? "code_index_not_found" : "code_index_required"),
      { status: commitSha ? 404 : 409 }
    );
  }
  return index;
}

export function triggerKoshCodeIndexAfterPush(
  repository: StoredKoshRepository,
  actor: { id: string; displayName: string },
  changedBranches: string[]
) {
  if (
    process.env.KOSH_CODE_INDEX_ON_PUSH?.trim().toLowerCase() === "false"
  ) {
    return;
  }

  for (const branch of [...new Set(changedBranches)].slice(0, 3)) {
    void indexKoshRepositoryCode(repository, branch)
      .then((index) =>
        audit(repository.id, actor, "code_index_push_completed", index)
      )
      .catch(() => undefined);
  }
}

export async function handleKoshCodeIntelligenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/code-intelligence(?:\/(.*))?$/
  );
  if (!match) return false;

  const identity = await resolveKoshIdentity(
    request,
    request.method === "GET" ? "repo:read" : "repo:write"
  );
  if (!identity) {
    sendJson(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "") &&
    origin &&
    !allowedOrigins.has(origin)
  ) {
    sendJson(
      response,
      403,
      { error: "origin_not_allowed" },
      origin,
      allowedOrigins
    );
    return true;
  }

  try {
    await platformStore.ready();
    const repository = await repositoryStore.get(match[1], match[2]);
    if (!repository) {
      throw Object.assign(new Error("repository_not_found"), { status: 404 });
    }

    const tail = match[3] ?? "";

    if (request.method === "GET" && tail === "") {
      const indexes = await listCodeIndexes(repository.id);
      const latest = indexes.find((item) => item.state === "ready") ?? null;
      sendJson(
        response,
        200,
        {
          latest: latest ? publicIndex(latest) : null,
          indexes: indexes.slice(0, 20).map(publicIndex),
          persistence: platformStore.kind,
          supportedLanguages: [
            "typescript",
            "javascript",
            "python",
            "cpp",
            "java",
            "go",
            "rust"
          ],
          pushIndexing:
            process.env.KOSH_CODE_INDEX_ON_PUSH?.trim().toLowerCase() !== "false"
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "POST" && tail === "index") {
      const body = await readJson(request);
      const refName = clean(body.ref, 300) || repository.defaultBranch;
      const index = await indexKoshRepositoryCode(repository, refName);
      await audit(
        repository.id,
        {
          id: identity.user.id,
          displayName: identity.user.displayName
        },
        "code_index_completed",
        index
      );
      sendJson(response, 201, publicIndex(index), origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && tail === "indexes") {
      sendJson(
        response,
        200,
        {
          indexes: (await listCodeIndexes(repository.id))
            .slice(0, 100)
            .map(publicIndex)
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    const commit = clean(url.searchParams.get("commit"), 64);
    const index = await selectedIndex(repository, commit);

    if (request.method === "GET" && tail === "symbols") {
      const query = clean(url.searchParams.get("q"), 200);
      const kind = clean(url.searchParams.get("kind"), 80);
      const language = clean(url.searchParams.get("language"), 80);
      const limit = Math.max(
        1,
        Math.min(2000, Number(url.searchParams.get("limit")) || 300)
      );
      const [symbols, ownerRules] = await Promise.all([
        effectiveSymbols(index, query, kind, language, limit),
        effectiveOwners(index)
      ]);
      sendJson(
        response,
        200,
        {
          index: publicIndex(index),
          symbols: symbols.map((item) => ({
            ...item,
            owners: ownersForKoshCodePath(item.path, ownerRules)
          }))
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "GET" && tail === "definition") {
      const name = clean(url.searchParams.get("name"), 200);
      const path = clean(url.searchParams.get("path"), 2048);
      if (!name) {
        throw Object.assign(new Error("symbol_name_required"), { status: 400 });
      }
      const ownerRules = await effectiveOwners(index);
      const candidates = (await effectiveSymbols(index, name, "", "", 200))
        .filter(
          (item) =>
            item.name === name ||
            item.qualifiedName === name ||
            item.qualifiedName.endsWith("." + name)
        )
        .sort((a, b) => {
          if (path && a.path === path && b.path !== path) return -1;
          if (path && b.path === path && a.path !== path) return 1;
          return a.path.localeCompare(b.path) || a.line - b.line;
        });
      const definition = candidates[0] ?? null;
      sendJson(
        response,
        200,
        {
          index: publicIndex(index),
          definition: definition
            ? {
                ...definition,
                owners: ownersForKoshCodePath(definition.path, ownerRules)
              }
            : null,
          candidates: candidates.slice(0, 20)
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "GET" && tail === "references") {
      const name = clean(url.searchParams.get("name"), 200);
      if (!name) {
        throw Object.assign(new Error("symbol_name_required"), { status: 400 });
      }
      const limit = Math.max(
        1,
        Math.min(5000, Number(url.searchParams.get("limit")) || 500)
      );
      sendJson(
        response,
        200,
        {
          index: publicIndex(index),
          references: await effectiveReferences(index, name, limit)
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "GET" && tail === "owners") {
      const path = clean(url.searchParams.get("path"), 2048);
      if (!path) {
        throw Object.assign(new Error("path_required"), { status: 400 });
      }
      const rules = await effectiveOwners(index);
      sendJson(
        response,
        200,
        {
          index: publicIndex(index),
          path,
          owners: ownersForKoshCodePath(path, rules),
          rules
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    sendJson(
      response,
      404,
      { error: "code_intelligence_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 500
        : 500;
    sendJson(
      response,
      status,
      {
        error:
          error instanceof Error
            ? error.message
            : "code_intelligence_error"
      },
      origin,
      allowedOrigins
    );
    return true;
  }
}
