export type FormFieldType =
  | "short-text"
  | "paragraph"
  | "email"
  | "phone"
  | "number"
  | "date"
  | "time"
  | "multiple-choice"
  | "checkboxes"
  | "dropdown"
  | "yes-no"
  | "rating";

export type FormStatus = "draft" | "published" | "closed";

export type FormLogicOperator = "equals" | "not-equals" | "contains" | "is-empty" | "is-not-empty";

export type FormVisibilityRule = {
  fieldId: string;
  operator: FormLogicOperator;
  value?: string;
};

export type FormFieldValidation = {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
};

export type FormField = {
  id: string;
  type: FormFieldType;
  label: string;
  description: string;
  placeholder: string;
  required: boolean;
  options: string[];
  min?: number;
  max?: number;
  validation?: FormFieldValidation;
  visibility?: FormVisibilityRule | null;
};

export type FormTheme = {
  accent: string;
  surface: "clean" | "soft" | "glass";
  density: "comfortable" | "compact";
};

export type FormSettings = {
  collectEmail: boolean;
  allowMultipleSubmissions: boolean;
  responseLimit: number | null;
  confirmationMessage: string;
};

export type TamishraForm = {
  id: string;
  title: string;
  description: string;
  fields: FormField[];
  status: FormStatus;
  theme: FormTheme;
  settings: FormSettings;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  closedAt: string | null;
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

const defaultTheme: FormTheme = {
  accent: "#315cf4",
  surface: "clean",
  density: "comfortable"
};

const defaultSettings: FormSettings = {
  collectEmail: false,
  allowMultipleSubmissions: true,
  responseLimit: null,
  confirmationMessage: "Thanks. Your response has been recorded."
};

export function createFormsSnapshot(): FormsSnapshot {
  return { version: 1, forms: [], responses: [] };
}

export function normalizeForm(input: Partial<TamishraForm>): TamishraForm {
  const now = new Date().toISOString();
  const fields = Array.isArray(input.fields) ? input.fields.map(normalizeField) : [];
  return {
    id: input.id || createId("form"),
    title: input.title ?? "Untitled form",
    description: input.description ?? "",
    fields: fields.length ? fields : [createField("short-text", "Question")],
    status: input.status ?? "draft",
    theme: {
      ...defaultTheme,
      ...(input.theme ?? {})
    },
    settings: {
      ...defaultSettings,
      ...(input.settings ?? {})
    },
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    publishedAt: input.publishedAt ?? null,
    closedAt: input.closedAt ?? null,
    trashedAt: input.trashedAt ?? null
  };
}

export function createForm(title = "Untitled form"): TamishraForm {
  const now = new Date().toISOString();
  return normalizeForm({
    id: createId("form"),
    title,
    description: "",
    fields: [createField("short-text", "Question")],
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    closedAt: null,
    trashedAt: null
  });
}

export function createField(type: FormFieldType, label = "Question"): FormField {
  const choice = type === "multiple-choice" || type === "checkboxes" || type === "dropdown";
  const yesNo = type === "yes-no";
  return normalizeField({
    id: createId("field"),
    type,
    label,
    description: "",
    placeholder: "",
    required: false,
    options: choice ? ["Option 1", "Option 2"] : yesNo ? ["Yes", "No"] : [],
    ...(type === "rating" ? { min: 1, max: 5 } : {})
  });
}

export function normalizeField(input: Partial<FormField>): FormField {
  const type = input.type ?? "short-text";
  const choice = type === "multiple-choice" || type === "checkboxes" || type === "dropdown";
  const yesNo = type === "yes-no";
  return {
    id: input.id || createId("field"),
    type,
    label: input.label ?? "Question",
    description: input.description ?? "",
    placeholder: input.placeholder ?? "",
    required: Boolean(input.required),
    options: Array.isArray(input.options)
      ? input.options.map(String)
      : choice
        ? ["Option 1", "Option 2"]
        : yesNo
          ? ["Yes", "No"]
          : [],
    min: input.min,
    max: input.max,
    validation: input.validation ? { ...input.validation } : undefined,
    visibility: input.visibility ? { ...input.visibility } : null
  };
}

export function createTemplateForm(
  template: "registration" | "feedback" | "site-inspection" | "quiz"
): TamishraForm {
  const form = createForm(
    template === "registration"
      ? "Registration"
      : template === "feedback"
        ? "Feedback"
        : template === "site-inspection"
          ? "Site inspection"
          : "Quick assessment"
  );

  const fields: FormField[] =
    template === "registration"
      ? [
          createField("short-text", "Full name"),
          { ...createField("email", "Email"), required: true },
          createField("phone", "Phone"),
          createField("dropdown", "Department")
        ]
      : template === "feedback"
        ? [
            { ...createField("rating", "Overall rating"), required: true },
            createField("multiple-choice", "How was your experience?"),
            createField("paragraph", "What should we improve?")
          ]
        : template === "site-inspection"
          ? [
              { ...createField("short-text", "Site / Area"), required: true },
              { ...createField("date", "Inspection date"), required: true },
              createField("yes-no", "Is the item acceptable?"),
              createField("paragraph", "Observation / corrective action")
            ]
          : [
              { ...createField("multiple-choice", "Question 1"), required: true },
              { ...createField("multiple-choice", "Question 2"), required: true },
              createField("paragraph", "Additional remarks")
            ];

  if (template === "registration") {
    fields[3].options = ["Engineering", "Operations", "Finance", "Other"];
  }
  if (template === "feedback") {
    fields[1].options = ["Excellent", "Good", "Average", "Needs improvement"];
  }
  if (template === "quiz") {
    fields[0].options = ["Option A", "Option B", "Option C", "Option D"];
    fields[1].options = ["Option A", "Option B", "Option C", "Option D"];
  }

  return {
    ...form,
    fields,
    description:
      template === "site-inspection"
        ? "Capture field observations with a structured Tamishra form."
        : ""
  };
}

export function setFormStatus(form: TamishraForm, status: FormStatus): TamishraForm {
  const now = new Date().toISOString();
  return {
    ...form,
    status,
    updatedAt: now,
    publishedAt: status === "published" ? form.publishedAt ?? now : form.publishedAt,
    closedAt: status === "closed" ? now : null
  };
}

export function upsertForm(snapshot: FormsSnapshot, form: TamishraForm) {
  return {
    ...snapshot,
    forms: [
      { ...normalizeForm(form), updatedAt: new Date().toISOString() },
      ...snapshot.forms.filter((item) => item.id !== form.id)
    ]
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

export function isFieldVisible(
  field: FormField,
  answers: Record<string, string | string[]>
) {
  const rule = field.visibility;
  if (!rule?.fieldId) return true;
  const raw = answers[rule.fieldId];
  const value = Array.isArray(raw) ? raw.join(", ") : String(raw ?? "");
  const expected = rule.value ?? "";

  switch (rule.operator) {
    case "equals":
      return value === expected;
    case "not-equals":
      return value !== expected;
    case "contains":
      return value.toLowerCase().includes(expected.toLowerCase());
    case "is-empty":
      return value.trim() === "";
    case "is-not-empty":
      return value.trim() !== "";
    default:
      return true;
  }
}

export function validateAnswers(
  form: TamishraForm,
  answers: Record<string, string | string[]>
) {
  const errors: Record<string, string> = {};

  for (const field of form.fields) {
    if (!isFieldVisible(field, answers)) continue;

    const value = answers[field.id];
    const empty =
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);

    if (field.required && empty) {
      errors[field.id] = "This question is required.";
      continue;
    }
    if (empty || Array.isArray(value)) continue;

    const text = String(value);
    const validation = field.validation ?? {};

    if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      errors[field.id] = "Enter a valid email address.";
      continue;
    }

    if (field.type === "number") {
      const number = Number(text);
      if (!Number.isFinite(number)) {
        errors[field.id] = "Enter a valid number.";
        continue;
      }
      const min = validation.min ?? field.min;
      const max = validation.max ?? field.max;
      if (typeof min === "number" && number < min) {
        errors[field.id] = "Value must be at least " + min + ".";
        continue;
      }
      if (typeof max === "number" && number > max) {
        errors[field.id] = "Value must be at most " + max + ".";
        continue;
      }
    }

    if (typeof validation.minLength === "number" && text.length < validation.minLength) {
      errors[field.id] = "Use at least " + validation.minLength + " characters.";
      continue;
    }
    if (typeof validation.maxLength === "number" && text.length > validation.maxLength) {
      errors[field.id] = "Use no more than " + validation.maxLength + " characters.";
    }
  }

  return errors;
}

export function responsesToCsv(form: TamishraForm, responses: FormResponse[]) {
  const escape = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  const header = [
    "Response ID",
    "Submitted at",
    ...form.fields.map((field) => field.label || "Question")
  ];
  const rows = responses
    .filter((response) => response.formId === form.id)
    .map((response) => [
      response.id,
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
    form: normalizeForm(form),
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

  return {
    ...envelope.payload,
    form: normalizeForm(envelope.payload.form)
  };
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
  return prefix + "_" + random;
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
    return "[" + value.map((item) => stableJson(item)).join(",") + "]";
  }
  return "{" + Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item))
    .join(",") + "}";
}