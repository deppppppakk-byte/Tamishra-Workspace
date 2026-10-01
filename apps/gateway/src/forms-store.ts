import postgres from "postgres";

export type StoredForm = {
  id: string;
  ownerUserId: string;
  revision: number;
  payload: Record<string, unknown>;
  status: string;
  updatedAt: string;
};

export type StoredFormResponse = {
  id: string;
  formId: string;
  submittedAt: string;
  answers: Record<string, unknown>;
};

export interface FormsStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  getOwnerForm(ownerUserId: string, formId: string): Promise<StoredForm | null>;
  putOwnerForm(
    ownerUserId: string,
    formId: string,
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ): Promise<StoredForm>;
  getPublicForm(formId: string): Promise<StoredForm | null>;
  listResponses(ownerUserId: string, formId: string): Promise<StoredFormResponse[]>;
  countResponses(formId: string): Promise<number>;
  addResponse(formId: string, answers: Record<string, unknown>): Promise<StoredFormResponse>;
}

function createId(prefix: string) {
  const random =
    typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + "_" + random;
}

function formStatus(payload: Record<string, unknown>) {
  const status = String(payload.status ?? "draft");
  return status === "published" || status === "closed" ? status : "draft";
}

class MemoryFormsStore implements FormsStore {
  readonly kind = "ephemeral-memory" as const;
  private forms = new Map<string, StoredForm>();
  private responses = new Map<string, StoredFormResponse[]>();

  async ready() {}

  async getOwnerForm(ownerUserId: string, formId: string) {
    const item = this.forms.get(formId);
    return item?.ownerUserId === ownerUserId ? structuredClone(item) : null;
  }

  async putOwnerForm(
    ownerUserId: string,
    formId: string,
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ) {
    const current = this.forms.get(formId);
    if (current && current.ownerUserId !== ownerUserId) {
      throw Object.assign(new Error("form_not_owned"), { status: 403 });
    }
    if (
      expectedRevision !== undefined &&
      expectedRevision !== null &&
      (current?.revision ?? 0) !== expectedRevision
    ) {
      throw Object.assign(new Error("revision_conflict"), {
        status: 409,
        currentRevision: current?.revision ?? 0
      });
    }

    const stored: StoredForm = {
      id: formId,
      ownerUserId,
      revision: (current?.revision ?? 0) + 1,
      payload: structuredClone(payload),
      status: formStatus(payload),
      updatedAt: new Date().toISOString()
    };
    this.forms.set(formId, stored);
    return structuredClone(stored);
  }

  async getPublicForm(formId: string) {
    const item = this.forms.get(formId);
    if (!item || item.status === "draft") return null;
    return structuredClone(item);
  }

  async listResponses(ownerUserId: string, formId: string) {
    const form = this.forms.get(formId);
    if (!form || form.ownerUserId !== ownerUserId) return [];
    return structuredClone(this.responses.get(formId) ?? []);
  }

  async countResponses(formId: string) {
    return this.responses.get(formId)?.length ?? 0;
  }

  async addResponse(formId: string, answers: Record<string, unknown>) {
    const response: StoredFormResponse = {
      id: createId("response"),
      formId,
      submittedAt: new Date().toISOString(),
      answers: structuredClone(answers)
    };
    this.responses.set(formId, [response, ...(this.responses.get(formId) ?? [])]);
    return structuredClone(response);
  }
}

class PostgresFormsStore implements FormsStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql.unsafe(
      "CREATE TABLE IF NOT EXISTS workspace_forms (" +
      "form_id TEXT PRIMARY KEY, " +
      "owner_user_id TEXT NOT NULL, " +
      "revision BIGINT NOT NULL DEFAULT 0, " +
      "payload JSONB NOT NULL DEFAULT '{}'::jsonb, " +
      "status TEXT NOT NULL DEFAULT 'draft', " +
      "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await this.sql.unsafe(
      "CREATE INDEX IF NOT EXISTS workspace_forms_owner_idx " +
      "ON workspace_forms (owner_user_id, updated_at DESC)"
    );
    await this.sql.unsafe(
      "CREATE TABLE IF NOT EXISTS workspace_form_responses (" +
      "response_id TEXT PRIMARY KEY, " +
      "form_id TEXT NOT NULL REFERENCES workspace_forms(form_id) ON DELETE CASCADE, " +
      "answers JSONB NOT NULL DEFAULT '{}'::jsonb, " +
      "submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await this.sql.unsafe(
      "CREATE INDEX IF NOT EXISTS workspace_form_responses_form_idx " +
      "ON workspace_form_responses (form_id, submitted_at DESC)"
    );

    this.initialized = true;
  }

  private rowToForm(row: Record<string, unknown>): StoredForm {
    return {
      id: String(row.form_id),
      ownerUserId: String(row.owner_user_id),
      revision: Number(row.revision ?? 0),
      payload:
        row.payload && typeof row.payload === "object"
          ? row.payload as Record<string, unknown>
          : {},
      status: String(row.status ?? "draft"),
      updatedAt: new Date(String(row.updated_at)).toISOString()
    };
  }

  async getOwnerForm(ownerUserId: string, formId: string) {
    await this.ready();
    const rows = await this.sql.unsafe(
      "SELECT form_id, owner_user_id, revision, payload, status, updated_at " +
      "FROM workspace_forms WHERE form_id = $1 AND owner_user_id = $2 LIMIT 1",
      [formId, ownerUserId]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? this.rowToForm(row) : null;
  }

  async putOwnerForm(
    ownerUserId: string,
    formId: string,
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ) {
    await this.ready();
    const currentRows = await this.sql.unsafe(
      "SELECT owner_user_id, revision FROM workspace_forms WHERE form_id = $1 LIMIT 1",
      [formId]
    );
    const current = currentRows[0] as Record<string, unknown> | undefined;

    if (current && String(current.owner_user_id) !== ownerUserId) {
      throw Object.assign(new Error("form_not_owned"), { status: 403 });
    }

    const currentRevision = Number(current?.revision ?? 0);
    if (
      expectedRevision !== undefined &&
      expectedRevision !== null &&
      currentRevision !== expectedRevision
    ) {
      throw Object.assign(new Error("revision_conflict"), {
        status: 409,
        currentRevision
      });
    }

    const rows = await this.sql.unsafe(
      "INSERT INTO workspace_forms " +
      "(form_id, owner_user_id, revision, payload, status, created_at, updated_at) " +
      "VALUES ($1, $2, 1, $3::jsonb, $4, NOW(), NOW()) " +
      "ON CONFLICT (form_id) DO UPDATE SET " +
      "revision = workspace_forms.revision + 1, payload = EXCLUDED.payload, " +
      "status = EXCLUDED.status, updated_at = NOW() " +
      "WHERE workspace_forms.owner_user_id = $2 " +
      "RETURNING form_id, owner_user_id, revision, payload, status, updated_at",
      [formId, ownerUserId, JSON.stringify(payload), formStatus(payload)]
    );

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("form_not_owned"), { status: 403 });
    return this.rowToForm(row);
  }

  async getPublicForm(formId: string) {
    await this.ready();
    const rows = await this.sql.unsafe(
      "SELECT form_id, owner_user_id, revision, payload, status, updated_at " +
      "FROM workspace_forms WHERE form_id = $1 AND status IN ('published','closed') LIMIT 1",
      [formId]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? this.rowToForm(row) : null;
  }

  async listResponses(ownerUserId: string, formId: string) {
    await this.ready();
    const owned = await this.getOwnerForm(ownerUserId, formId);
    if (!owned) return [];

    const rows = await this.sql.unsafe(
      "SELECT response_id, form_id, answers, submitted_at " +
      "FROM workspace_form_responses WHERE form_id = $1 ORDER BY submitted_at DESC",
      [formId]
    );

    return rows.map((row) => ({
      id: String(row.response_id),
      formId: String(row.form_id),
      submittedAt: new Date(String(row.submitted_at)).toISOString(),
      answers:
        row.answers && typeof row.answers === "object"
          ? row.answers as Record<string, unknown>
          : {}
    }));
  }

  async countResponses(formId: string) {
    await this.ready();
    const rows = await this.sql.unsafe(
      "SELECT COUNT(*)::bigint AS count FROM workspace_form_responses WHERE form_id = $1",
      [formId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async addResponse(formId: string, answers: Record<string, unknown>) {
    await this.ready();
    const responseId = createId("response");
    const rows = await this.sql.unsafe(
      "INSERT INTO workspace_form_responses (response_id, form_id, answers, submitted_at) " +
      "VALUES ($1, $2, $3::jsonb, NOW()) " +
      "RETURNING response_id, form_id, answers, submitted_at",
      [responseId, formId, JSON.stringify(answers)]
    );
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.response_id),
      formId: String(row.form_id),
      submittedAt: new Date(String(row.submitted_at)).toISOString(),
      answers:
        row.answers && typeof row.answers === "object"
          ? row.answers as Record<string, unknown>
          : {}
    };
  }
}

export function createFormsStore(): FormsStore {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!databaseUrl) return new MemoryFormsStore();
  return new PostgresFormsStore(postgres(databaseUrl, { max: 5, prepare: false }));
}
