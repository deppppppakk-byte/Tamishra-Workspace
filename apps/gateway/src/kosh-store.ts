import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  ensureKoshRepositoryPersistence,
  scheduleKoshRepositoryPersistence
} from "./kosh-repository-persistence.js";

export type KoshVisibility = "private" | "internal" | "public";
export type KoshRepositoryState = "ready" | "provisioning" | "error";

export type StoredKoshRepository = {
  id: string;
  namespace: string;
  slug: string;
  name: string;
  description: string;
  visibility: KoshVisibility;
  defaultBranch: string;
  state: KoshRepositoryState;
  cloneHttpUrl: string;
  createdAt: string;
  updatedAt: string;
};

type CreateRepositoryInput = Omit<StoredKoshRepository, "id" | "createdAt" | "updatedAt">;

export interface KoshStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  list(): Promise<StoredKoshRepository[]>;
  get(namespace: string, slug: string): Promise<StoredKoshRepository | null>;
  create(input: CreateRepositoryInput): Promise<StoredKoshRepository>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryKoshStore implements KoshStore {
  readonly kind = "ephemeral-memory" as const;
  private records = new Map<string, StoredKoshRepository>();

  async ready() {}

  async list() {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async get(namespace: string, slug: string) {
    const value = this.records.get(namespace + "/" + slug);
    return value ? clone(value) : null;
  }

  async create(input: CreateRepositoryInput) {
    const key = input.namespace + "/" + input.slug;
    if (this.records.has(key)) {
      throw Object.assign(new Error("repository_exists"), { status: 409 });
    }

    const now = new Date().toISOString();
    const record: StoredKoshRepository = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.records.set(key, record);
    return clone(record);
  }
}

function rowToRepository(row: Record<string, unknown>): StoredKoshRepository {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ""),
    visibility: String(row.visibility) as KoshVisibility,
    defaultBranch: String(row.default_branch ?? "main"),
    state: String(row.state ?? "ready") as KoshRepositoryState,
    cloneHttpUrl: String(row.clone_http_url ?? ""),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

class PostgresKoshStore implements KoshStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`
      CREATE TABLE IF NOT EXISTS kosh_repositories (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'private',
        default_branch TEXT NOT NULL DEFAULT 'main',
        state TEXT NOT NULL DEFAULT 'ready',
        clone_http_url TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(namespace, slug),
        CHECK (visibility IN ('private', 'internal', 'public')),
        CHECK (state IN ('ready', 'provisioning', 'error'))
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS kosh_repositories_updated_idx
      ON kosh_repositories(updated_at DESC)
    `;

    this.initialized = true;
  }

  async list() {
    await this.ready();
    const rows = await this.sql`
      SELECT id, namespace, slug, name, description, visibility,
             default_branch, state, clone_http_url, created_at, updated_at
      FROM kosh_repositories
      ORDER BY updated_at DESC
      LIMIT 500
    `;
    return rows.map((row) => rowToRepository(row as Record<string, unknown>));
  }

  async get(namespace: string, slug: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT id, namespace, slug, name, description, visibility,
             default_branch, state, clone_http_url, created_at, updated_at
      FROM kosh_repositories
      WHERE namespace = ${namespace} AND slug = ${slug}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    // The live Git repository stays Git-native on the server. PostgreSQL keeps
    // a durable Git bundle snapshot so free/ephemeral server filesystems can be
    // reconstructed after a restart without Google Drive.
    await ensureKoshRepositoryPersistence(this.sql, namespace, slug);
    scheduleKoshRepositoryPersistence(this.sql, namespace, slug);
    return rowToRepository(row);
  }

  async create(input: CreateRepositoryInput) {
    await this.ready();
    try {
      const id = randomUUID();
      const rows = await this.sql`
        INSERT INTO kosh_repositories (
          id, namespace, slug, name, description, visibility,
          default_branch, state, clone_http_url, created_at, updated_at
        )
        VALUES (
          ${id}, ${input.namespace}, ${input.slug}, ${input.name},
          ${input.description}, ${input.visibility}, ${input.defaultBranch},
          ${input.state}, ${input.cloneHttpUrl}, NOW(), NOW()
        )
        RETURNING id, namespace, slug, name, description, visibility,
                  default_branch, state, clone_http_url, created_at, updated_at
      `;
      scheduleKoshRepositoryPersistence(this.sql, input.namespace, input.slug);
      return rowToRepository(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw Object.assign(new Error("repository_exists"), { status: 409 });
      }
      throw error;
    }
  }
}

let singleton: KoshStore | null = null;

export function getKoshStore(): KoshStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshStore(postgres(databaseUrl, { max: 5, prepare: false }))
    : new MemoryKoshStore();
  return singleton;
}

export function createKoshStore(): KoshStore {
  return getKoshStore();
}
