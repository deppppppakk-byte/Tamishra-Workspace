export type FormFieldType =
  | "short-text"
  | "paragraph"
  | "multiple-choice"
  | "checkboxes"
  | "dropdown"
  | "number"
  | "date"
  | "rating";

export type FormField = {
  id: string;
  type: FormFieldType;
  label: string;
  description: string;
  required: boolean;
  options: string[];
  min?: number;
  max?: number;
};

export type TamishraForm = {
  id: string;
  title: string;
  description: string;
  fields: FormField[];
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
};

export type FormResponse = {
  id: string;
  formId: string;
  submittedAt: string;
  answers: Record<string, string | string[]>;
};

export type FormsSnapshot = {
  version: 1;
  forms: TamishraForm[];
  responses: FormResponse[];
  deleted: Record<string, string>;
};

export const TMFORM_EXTENSION = ".tmfm";
export const TMFORM_MIME_TYPE = "application/vnd.tamishra.form";
export const TMFORM_FORMAT_VERSION = 1;
export const TMFORM_MAGIC = "TMFM\n";

type NativeEnvelope = {
  checksum: string;
  payload: {
    format: "Tamishra Form";
    version: number;
    exportedAt: string;
    form: TamishraForm;
    responses: FormResponse[];
  };
};

export function createFormsSnapshot(): FormsSnapshot {
  return { version: 1, forms: [], responses: [], deleted: {} };
}

export function createForm(title = "Untitled form"): TamishraForm {
  const now = new Date().toISOString();
  return {
    id: createId("form"),
    title,
    description: "",
    fields: [
      createField("short-text", "Question")
    ],
    createdAt: now,
    updatedAt: now,
    trashedAt: null
  };
}

export function createField(
  type: FormFieldType,
  label = "Question"
): FormField {
  const options =
    type === "multiple-choice" || type === "checkboxes" || type === "dropdown"
      ? ["Option 1", "Option 2"]
      : [];
  return {
    id: createId("field"),
    type,
    label,
    description: "",
    required: false,
    options,
    ...(type === "rating" ? { min: 1, max: 5 } : {})
  };
}

export function upsertForm(snapshot: FormsSnapshot, form: TamishraForm) {
  return {
    ...snapshot,
    forms: [
      { ...form, updatedAt: new Date().toISOString() },
      ...snapshot.forms.filter((item) => item.id !== form.id)
    ]
  };
}

export function normalizeFormsSnapshot(value: unknown): FormsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createFormsSnapshot();
  }

  const candidate = value as Partial<FormsSnapshot>;
  const forms = Array.isArray(candidate.forms)
    ? candidate.forms.filter((form): form is TamishraForm =>
        Boolean(
          form &&
          typeof form === "object" &&
          typeof form.id === "string" &&
          typeof form.title === "string" &&
          Array.isArray(form.fields) &&
          typeof form.updatedAt === "string"
        )
      )
    : [];

  const responses = Array.isArray(candidate.responses)
    ? candidate.responses.filter((response): response is FormResponse =>
        Boolean(
          response &&
          typeof response === "object" &&
          typeof response.id === "string" &&
          typeof response.formId === "string" &&
          typeof response.submittedAt === "string" &&
          response.answers &&
          typeof response.answers === "object"
        )
      )
    : [];

  const deleted =
    candidate.deleted &&
    typeof candidate.deleted === "object" &&
    !Array.isArray(candidate.deleted)
      ? Object.fromEntries(
          Object.entries(candidate.deleted).filter(
            ([id, deletedAt]) =>
              id.length > 0 && typeof deletedAt === "string"
          )
        )
      : {};

  return {
    version: 1,
    forms: forms.filter((form) => !(form.id in deleted)),
    responses: responses.filter((response) => !(response.formId in deleted)),
    deleted
  };
}

export function mergeFormsSnapshots(
  local: FormsSnapshot,
  remote: FormsSnapshot
): FormsSnapshot {
  const deleted: Record<string, string> = {
    ...remote.deleted,
    ...local.deleted
  };
  for (const [id, deletedAt] of Object.entries(remote.deleted)) {
    const localDeletedAt = deleted[id];
    if (!localDeletedAt || deletedAt.localeCompare(localDeletedAt) > 0) {
      deleted[id] = deletedAt;
    }
  }

  const forms = new Map<string, TamishraForm>();
  for (const form of [...remote.forms, ...local.forms]) {
    if (deleted[form.id]) continue;
    const current = forms.get(form.id);
    if (!current || form.updatedAt.localeCompare(current.updatedAt) >= 0) {
      forms.set(form.id, form);
    }
  }

  const responses = new Map<string, FormResponse>();
  for (const response of [...remote.responses, ...local.responses]) {
    if (deleted[response.formId]) continue;
    const current = responses.get(response.id);
    if (
      !current ||
      response.submittedAt.localeCompare(current.submittedAt) >= 0
    ) {
      responses.set(response.id, response);
    }
  }

  return {
    version: 1,
    forms: Array.from(forms.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    ),
    responses: Array.from(responses.values()).sort((left, right) =>
      right.submittedAt.localeCompare(left.submittedAt)
    ),
    deleted
  };
}

export function addResponse(
  snapshot: FormsSnapshot,
  formId: string,
  answers: Record<string, string | string[]>
) {
  const response: FormResponse = {
    id: createId("response"),
    formId,
    submittedAt: new Date().toISOString(),
    answers
  };
  return {
    snapshot: {
      ...snapshot,
      responses: [response, ...snapshot.responses]
    },
    response
  };
}

export function validateAnswers(
  form: TamishraForm,
  answers: Record<string, string | string[]>
) {
  const errors: Record<string, string> = {};

  for (const field of form.fields) {
    if (!field.required) continue;
    const value = answers[field.id];
    const empty =
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    if (empty) errors[field.id] = "This question is required.";
  }

  return errors;
}

export function responsesToMatrix(
  form: TamishraForm,
  responses: FormResponse[]
) {
  const ordered = responses
    .filter((response) => response.formId === form.id)
    .slice()
    .sort((left, right) =>
      left.submittedAt.localeCompare(right.submittedAt)
    );

  const header = [
    "Response ID",
    "Submitted at",
    ...form.fields.map((field) => field.label || "Question")
  ];

  const rows = ordered.map((response) => [
    response.id,
    response.submittedAt,
    ...form.fields.map((field) => {
      const value = response.answers[field.id];
      return Array.isArray(value) ? value.join("; ") : String(value ?? "");
    })
  ]);

  return [header, ...rows];
}

export function responsesToCsv(
  form: TamishraForm,
  responses: FormResponse[]
) {
  const escape = (value: string) =>
    '"' + value.replaceAll('"', '""') + '"';
  const header = [
    "Submitted at",
    ...form.fields.map((field) => field.label || "Question")
  ];
  const rows = responses
    .filter((response) => response.formId === form.id)
    .map((response) => [
      response.submittedAt,
      ...form.fields.map((field) => {
        const value = response.answers[field.id];
        return Array.isArray(value) ? value.join("; ") : String(value ?? "");
      })
    ]);

  return [header, ...rows]
    .map((row) => row.map((value) => escape(String(value))).join(","))
    .join("\n");
}

export function serializeTamishraForm(
  form: TamishraForm,
  responses: FormResponse[] = []
) {
  const payload: NativeEnvelope["payload"] = {
    format: "Tamishra Form",
    version: TMFORM_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    form,
    responses: responses.filter((response) => response.formId === form.id)
  };
  const envelope: NativeEnvelope = {
    checksum: fnv1a32(stableJson(payload)),
    payload
  };
  return new TextEncoder().encode(TMFORM_MAGIC + JSON.stringify(envelope));
}

export function parseTamishraForm(input: ArrayBuffer | Uint8Array) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.startsWith(TMFORM_MAGIC)) {
    throw new Error("This is not a Tamishra .tmfm form.");
  }

  let envelope: NativeEnvelope;
  try {
    envelope = JSON.parse(text.slice(TMFORM_MAGIC.length)) as NativeEnvelope;
  } catch {
    throw new Error("The Tamishra form is damaged or unreadable.");
  }

  if (
    envelope?.payload?.format !== "Tamishra Form" ||
    envelope.payload.version > TMFORM_FORMAT_VERSION ||
    !envelope.payload.form?.id
  ) {
    throw new Error("Unsupported Tamishra form format.");
  }

  if (fnv1a32(stableJson(envelope.payload)) !== envelope.checksum) {
    throw new Error("The Tamishra form failed its integrity check.");
  }

  return envelope.payload;
}

export function tamishraFormFilename(title: string) {
  const safe =
    title
      .trim()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "form";
  return safe + TMFORM_EXTENSION;
}

function createId(prefix: string) {
  const random =
    typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${random}`;
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
