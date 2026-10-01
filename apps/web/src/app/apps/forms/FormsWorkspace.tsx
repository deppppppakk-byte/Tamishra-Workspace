"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addResponse,
  createField,
  createForm,
  createFormPage,
  createFormsSnapshot,
  createTemplateForm,
  getFieldsForPage,
  getNextPageId,
  isFieldVisible,
  normalizeForm,
  parseTamishraForm,
  responsesToCsv,
  serializeTamishraForm,
  setFormStatus,
  tamishraFormFilename,
  TMFORM_MIME_TYPE,
  validateAnswers,
  type FormField,
  type FormFieldType,
  type FormLogicOperator,
  type FormResponse,
  type FormsSnapshot,
  type TamishraForm
} from "@tamishra/forms-core";
import {
  permanentlyDeleteWorkspaceFile,
  trashWorkspaceFile,
  upsertWorkspaceFile
} from "@tamishra/file-core";
import { consumeNativeFileHandoff } from "../../../lib/native-file-handoff";
import { mutateWorkspaceFileIndex } from "../../../lib/workspace-files";
import { workspaceApi } from "../../../lib/workspace-api";
import styles from "./forms.module.css";

const STORAGE_KEY = "tamishra.forms.snapshot.v1";
type Mode = "build" | "logic" | "preview" | "responses" | "settings";
type View = "forms" | "templates" | "trash";
type TemplateKey = "registration" | "feedback" | "site-inspection" | "quiz";

const fieldLabels: Record<FormFieldType, string> = {
  "short-text": "Short text",
  paragraph: "Long text",
  email: "Email",
  phone: "Phone",
  number: "Number",
  date: "Date",
  time: "Time",
  "multiple-choice": "Single choice",
  checkboxes: "Multiple choice",
  dropdown: "Dropdown",
  "yes-no": "Yes / No",
  rating: "Rating"
};

const fieldGroups: Array<{ name: string; items: FormFieldType[] }> = [
  { name: "Text", items: ["short-text", "paragraph", "email", "phone"] },
  { name: "Choice", items: ["multiple-choice", "checkboxes", "dropdown", "yes-no", "rating"] },
  { name: "Data", items: ["number", "date", "time"] }
];

const templates: Array<{ key: TemplateKey; title: string; description: string }> = [
  { key: "registration", title: "Registration", description: "Name, email, phone and department." },
  { key: "feedback", title: "Feedback", description: "Rating, experience and improvement notes." },
  { key: "site-inspection", title: "Site inspection", description: "Field-ready inspection and observations." },
  { key: "quiz", title: "Quick assessment", description: "A clean starting point for assessments." }
];

const logicOperators: Array<{ value: FormLogicOperator; label: string }> = [
  { value: "equals", label: "equals" },
  { value: "not-equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "is-empty", label: "is empty" },
  { value: "is-not-empty", label: "is not empty" }
];

function loadSnapshot(): FormsSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createFormsSnapshot();
    const parsed = JSON.parse(raw) as Partial<FormsSnapshot>;
    return {
      version: 1,
      forms: Array.isArray(parsed.forms) ? parsed.forms.map((form) => normalizeForm(form)) : [],
      responses: Array.isArray(parsed.responses) ? parsed.responses : []
    };
  } catch {
    return createFormsSnapshot();
  }
}

function copyField(field: FormField): FormField {
  const next = createField(field.type, field.label);
  return {
    ...next,
    description: field.description,
    placeholder: field.placeholder,
    required: field.required,
    options: [...field.options],
    min: field.min,
    max: field.max,
    validation: field.validation ? { ...field.validation } : undefined,
    visibility: field.visibility ? { ...field.visibility } : null
  };
}

function downloadText(filename: string, value: string, type: string) {
  const blob = new Blob([value], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function InputPreview({
  field,
  value,
  error,
  onChange
}: {
  field: FormField;
  value: string | string[] | undefined;
  error?: string;
  onChange: (value: string | string[]) => void;
}) {
  const textValue = Array.isArray(value) ? "" : String(value ?? "");
  const className = error ? styles.inputError : "";

  if (field.type === "paragraph") {
    return (
      <textarea
        className={className}
        value={textValue}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (field.type === "multiple-choice" || field.type === "yes-no") {
    return (
      <div className={styles.choiceList}>
        {field.options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={field.id}
              checked={textValue === option}
              onChange={() => onChange(option)}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    );
  }

  if (field.type === "checkboxes") {
    const values = Array.isArray(value) ? value : [];
    return (
      <div className={styles.choiceList}>
        {field.options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={values.includes(option)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...values, option]
                    : values.filter((item) => item !== option)
                )
              }
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    );
  }

  if (field.type === "dropdown") {
    return (
      <select className={className} value={textValue} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select an option</option>
        {field.options.map((option) => <option key={option}>{option}</option>)}
      </select>
    );
  }

  if (field.type === "rating") {
    const min = field.min ?? 1;
    const max = field.max ?? 5;
    return (
      <div className={styles.ratingRow}>
        {Array.from({ length: Math.max(1, max - min + 1) }, (_, index) => min + index).map((rating) => (
          <button
            type="button"
            className={textValue === String(rating) ? styles.ratingActive : ""}
            key={rating}
            onClick={() => onChange(String(rating))}
          >
            {rating}
          </button>
        ))}
      </div>
    );
  }

  const type =
    field.type === "email"
      ? "email"
      : field.type === "phone"
        ? "tel"
        : field.type === "number"
          ? "number"
          : field.type === "date"
            ? "date"
            : field.type === "time"
              ? "time"
              : "text";

  return (
    <input
      className={className}
      type={type}
      value={textValue}
      placeholder={field.placeholder}
      min={field.type === "number" ? field.validation?.min ?? field.min : undefined}
      max={field.type === "number" ? field.validation?.max ?? field.max : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export default function FormsWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<FormsSnapshot>(() => createFormsSnapshot());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [previewHistory, setPreviewHistory] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>("build");
  const [view, setView] = useState<View>("forms");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Local-first");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const selectedForm = useMemo(
    () => snapshot.forms.find((form) => form.id === selectedId) ?? null,
    [snapshot.forms, selectedId]
  );

  const selectedField = useMemo(
    () => selectedForm?.fields.find((field) => field.id === selectedFieldId) ?? null,
    [selectedForm, selectedFieldId]
  );

  const selectedPage = useMemo(
    () => selectedForm?.pages.find((page) => page.id === selectedPageId) ?? selectedForm?.pages[0] ?? null,
    [selectedForm, selectedPageId]
  );

  const builderFields = useMemo(
    () => selectedForm && selectedPage ? getFieldsForPage(selectedForm, selectedPage.id) : [],
    [selectedForm, selectedPage]
  );

  const previewPage = useMemo(
    () => selectedForm?.pages.find((page) => page.id === previewPageId) ?? selectedForm?.pages[0] ?? null,
    [selectedForm, previewPageId]
  );

  const previewFields = useMemo(
    () =>
      selectedForm && previewPage
        ? getFieldsForPage(selectedForm, previewPage.id).filter((field) => isFieldVisible(field, answers))
        : [],
    [selectedForm, previewPage, answers]
  );

  const formResponses = useMemo(
    () =>
      selectedForm
        ? snapshot.responses.filter((response) => response.formId === selectedForm.id)
        : [],
    [snapshot.responses, selectedForm]
  );

  const visibleForms = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return snapshot.forms
      .filter((form) => (view === "trash" ? form.trashedAt : !form.trashedAt))
      .filter((form) =>
        !normalized
          ? true
          : [form.title, form.description, form.status].join(" ").toLowerCase().includes(normalized)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [snapshot.forms, query, view]);

  const selectForm = (id: string) => {
    const form = snapshot.forms.find((item) => item.id === id);
    const firstPage = form?.pages[0] ?? null;
    setSelectedId(id);
    setSelectedPageId(firstPage?.id ?? null);
    setPreviewPageId(firstPage?.id ?? null);
    setPreviewHistory([]);
    setSelectedFieldId(firstPage ? getFieldsForPage(form!, firstPage.id)[0]?.id ?? null : null);
    setAnswers({});
    setErrors({});
    history.replaceState(null, "", "/apps/forms?form=" + encodeURIComponent(id));
  };

  const createNewForm = (template?: TemplateKey) => {
    const form = template ? createTemplateForm(template) : createForm();
    setSnapshot((current) => ({ ...current, forms: [form, ...current.forms] }));
    setView("forms");
    setMode("build");
    setSelectedId(form.id);
    setSelectedPageId(form.pages[0]?.id ?? null);
    setPreviewPageId(form.pages[0]?.id ?? null);
    setPreviewHistory([]);
    setSelectedFieldId(form.fields[0]?.id ?? null);
    history.replaceState(null, "", "/apps/forms?form=" + encodeURIComponent(form.id));
    setStatus(template ? "Template created" : "New form");
  };

  const updateForm = (id: string, patch: Partial<TamishraForm>) => {
    const now = new Date().toISOString();
    setSnapshot((current) => ({
      ...current,
      forms: current.forms.map((form) =>
        form.id === id ? normalizeForm({ ...form, ...patch, updatedAt: now }) : form
      )
    }));
  };

  const updateField = (fieldId: string, patch: Partial<FormField>) => {
    if (!selectedForm) return;
    updateForm(selectedForm.id, {
      fields: selectedForm.fields.map((field) =>
        field.id === fieldId ? { ...field, ...patch } : field
      )
    });
  };

  const addField = (type: FormFieldType) => {
    if (!selectedForm || !selectedPage) return;
    const field = createField(type, fieldLabels[type]);
    updateForm(selectedForm.id, {
      fields: [...selectedForm.fields, field],
      pages: selectedForm.pages.map((page) =>
        page.id === selectedPage.id
          ? { ...page, fieldIds: [...page.fieldIds, field.id] }
          : page
      )
    });
    setSelectedFieldId(field.id);
  };

  const addPage = () => {
    if (!selectedForm) return;
    const page = createFormPage("Page " + (selectedForm.pages.length + 1));
    updateForm(selectedForm.id, { pages: [...selectedForm.pages, page] });
    setSelectedPageId(page.id);
    setSelectedFieldId(null);
  };

  const updatePage = (pageId: string, patch: Partial<TamishraForm["pages"][number]>) => {
    if (!selectedForm) return;
    updateForm(selectedForm.id, {
      pages: selectedForm.pages.map((page) =>
        page.id === pageId ? { ...page, ...patch } : page
      )
    });
  };

  const deletePage = (pageId: string) => {
    if (!selectedForm || selectedForm.pages.length <= 1) return;
    const page = selectedForm.pages.find((item) => item.id === pageId);
    if (!page) return;
    const remainingPages = selectedForm.pages.filter((item) => item.id !== pageId);
    const remainingFields = selectedForm.fields.filter((field) => !page.fieldIds.includes(field.id));
    updateForm(selectedForm.id, {
      fields: remainingFields,
      pages: remainingPages.map((item) => ({
        ...item,
        defaultNextPageId: item.defaultNextPageId === pageId ? null : item.defaultNextPageId,
        branchRules: item.branchRules.filter((rule) => rule.targetPageId !== pageId)
      }))
    });
    setSelectedPageId(remainingPages[0]?.id ?? null);
    setSelectedFieldId(remainingPages[0] ? getFieldsForPage({ ...selectedForm, fields: remainingFields, pages: remainingPages }, remainingPages[0].id)[0]?.id ?? null : null);
  };

  const moveField = (fieldId: string, direction: -1 | 1) => {
    if (!selectedForm) return;
    const index = selectedForm.fields.findIndex((field) => field.id === fieldId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= selectedForm.fields.length) return;
    const fields = [...selectedForm.fields];
    [fields[index], fields[target]] = [fields[target], fields[index]];
    updateForm(selectedForm.id, { fields });
  };

  const duplicateField = (fieldId: string) => {
    if (!selectedForm) return;
    const index = selectedForm.fields.findIndex((field) => field.id === fieldId);
    if (index < 0) return;
    const duplicate = copyField(selectedForm.fields[index]);
    const fields = [...selectedForm.fields];
    fields.splice(index + 1, 0, duplicate);
    updateForm(selectedForm.id, {
      fields,
      pages: selectedForm.pages.map((page) =>
        page.fieldIds.includes(fieldId)
          ? {
              ...page,
              fieldIds: page.fieldIds.flatMap((id) => id === fieldId ? [id, duplicate.id] : [id])
            }
          : page
      )
    });
    setSelectedFieldId(duplicate.id);
  };

  const deleteField = (fieldId: string) => {
    if (!selectedForm) return;
    const fields = selectedForm.fields.filter((field) => field.id !== fieldId);
    const pages = selectedForm.pages.map((page) => ({
      ...page,
      fieldIds: page.fieldIds.filter((id) => id !== fieldId),
      branchRules: page.branchRules.filter((rule) => rule.sourceFieldId !== fieldId)
    }));
    updateForm(selectedForm.id, { fields, pages });
    const currentPageFields = selectedPage
      ? getFieldsForPage({ ...selectedForm, fields, pages }, selectedPage.id)
      : fields;
    setSelectedFieldId(currentPageFields[0]?.id ?? null);
  };

  const importNativeBytes = (bytes: ArrayBuffer | Uint8Array) => {
    const payload = parseTamishraForm(bytes);
    const form = normalizeForm({
      ...payload.form,
      trashedAt: null,
      updatedAt: new Date().toISOString()
    });
    setSnapshot((current) => ({
      ...current,
      forms: [form, ...current.forms.filter((item) => item.id !== form.id)],
      responses: [...payload.responses, ...current.responses.filter((item) => item.formId !== form.id)]
    }));
    setView("forms");
    setMode("build");
    setSelectedId(form.id);
    setSelectedPageId(form.pages[0]?.id ?? null);
    setPreviewPageId(form.pages[0]?.id ?? null);
    setPreviewHistory([]);
    setSelectedFieldId(form.fields[0]?.id ?? null);
    setStatus(".tmfm opened · integrity verified");
  };

  useEffect(() => {
    const restored = loadSnapshot();
    setSnapshot(restored);
    const requestedId = new URLSearchParams(location.search).get("form");
    const active =
      (requestedId && restored.forms.find((form) => form.id === requestedId)) ||
      restored.forms.find((form) => !form.trashedAt) ||
      null;
    setSelectedId(active?.id ?? null);
    setSelectedPageId(active?.pages[0]?.id ?? null);
    setPreviewPageId(active?.pages[0]?.id ?? null);
    setSelectedFieldId(active?.fields[0]?.id ?? null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;

    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("startup_tmfm"))
      .then((raw) => {
        if (cancelled || !raw) return;
        importNativeBytes(new TextEncoder().encode(raw));
        setStatus(".tmfm opened from desktop");
      })
      .catch(() => {
        if (!cancelled) setStatus("Startup .tmfm could not be opened");
      });

    return () => {
      cancelled = true;
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const request = sessionStorage.getItem("tamishra.workspace.create");
    if (request === "forms") {
      sessionStorage.removeItem("tamishra.workspace.create");
      createNewForm();
      return;
    }

    void consumeNativeFileHandoff()
      .then((handoff) => {
        if (!handoff || !handoff.name.toLowerCase().endsWith(".tmfm")) return;
        importNativeBytes(handoff.bytes);
      })
      .catch(() => setStatus("Workspace form could not be opened"));
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    setStatus("Saving…");

    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));

      mutateWorkspaceFileIndex((index) => {
        let next = index;
        for (const form of snapshot.forms) {
          if (form.trashedAt) continue;
          next = upsertWorkspaceFile(next, {
            id: "forms:" + form.id,
            title: form.title || "Untitled form",
            kind: "forms",
            appHref: "/apps/forms?form=" + encodeURIComponent(form.id),
            nativeExtension: ".tmfm",
            nativeMime: TMFORM_MIME_TYPE,
            sourceId: form.id,
            sizeBytes: new Blob([
              JSON.stringify({
                form,
                responses: snapshot.responses.filter((response) => response.formId === form.id)
              })
            ]).size,
            storage: "local",
            updatedAt: form.updatedAt,
            lastOpenedAt: form.id === selectedId ? new Date().toISOString() : form.updatedAt
          });
        }
        return next;
      });

      setStatus("Saved locally");
    }, 450);

    return () => window.clearTimeout(timer);
  }, [snapshot, loaded, selectedId]);

  const saveFormToCloud = async (form: TamishraForm) => {
    const result = await workspaceApi<{
      persistence: "postgres" | "ephemeral-memory";
      revision: number;
      updatedAt: string;
      form: TamishraForm;
    }>("/v1/forms/" + encodeURIComponent(form.id), {
      method: "PUT",
      body: JSON.stringify({ form })
    });
    setStatus(
      result.persistence === "postgres"
        ? "Published to Workspace cloud"
        : "Published to development memory"
    );
    return result;
  };

  const changePublishedState = async (target: "published" | "closed") => {
    if (!selectedForm) return;
    const next = setFormStatus(selectedForm, target);
    setStatus(target === "published" ? "Publishing…" : "Updating public form…");
    try {
      await saveFormToCloud(next);
      updateForm(selectedForm.id, next);
    } catch (error) {
      setStatus(
        error instanceof Error && (error as Error & { status?: number }).status === 401
          ? "Sign in to publish this form"
          : "Could not update the public form"
      );
    }
  };

  const loadCloudResponses = async () => {
    if (!selectedForm || selectedForm.status === "draft") return;
    try {
      const result = await workspaceApi<{
        persistence: "postgres" | "ephemeral-memory";
        responses: Array<{
          id: string;
          formId: string;
          submittedAt: string;
          answers: Record<string, unknown>;
        }>;
      }>("/v1/forms/" + encodeURIComponent(selectedForm.id) + "/responses");

      const remote: FormResponse[] = result.responses.map((response) => ({
        id: response.id,
        formId: response.formId,
        submittedAt: response.submittedAt,
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.map(String) : String(value ?? "")
          ])
        )
      }));

      setSnapshot((current) => ({
        ...current,
        responses: [
          ...remote,
          ...current.responses.filter(
            (response) =>
              response.formId !== selectedForm.id ||
              !remote.some((item) => item.id === response.id)
          )
        ]
      }));
      setStatus("Cloud responses synced");
    } catch {
      setStatus("Cloud responses unavailable");
    }
  };

  const validatePreviewPage = () => {
    if (!selectedForm || !previewPage) return false;
    const pageForm = { ...selectedForm, fields: previewFields };
    const nextErrors = validateAnswers(pageForm, answers);

    if (
      selectedForm.settings.collectEmail &&
      previewPage.id === selectedForm.pages[0]?.id
    ) {
      const rawEmail = answers.__respondentEmail;
      const email = Array.isArray(rawEmail) ? "" : String(rawEmail ?? "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        nextErrors.__respondentEmail = "Enter a valid respondent email.";
      }
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setStatus("Complete required or invalid fields");
      return false;
    }
    return true;
  };

  const submitPreview = () => {
    if (!selectedForm || selectedForm.status === "closed") return;
    if (
      selectedForm.settings.responseLimit !== null &&
      formResponses.length >= selectedForm.settings.responseLimit
    ) {
      setStatus("Response limit reached");
      return;
    }
    if (!selectedForm.settings.allowMultipleSubmissions && formResponses.length > 0) {
      setStatus("Multiple submissions are disabled for this local form");
      return;
    }

    setSnapshot((current) => addResponse(current, selectedForm.id, answers).snapshot);
    setAnswers({});
    setErrors({});
    setPreviewHistory([]);
    setPreviewPageId(selectedForm.pages[0]?.id ?? null);
    setStatus(selectedForm.settings.confirmationMessage);
    setMode("responses");
  };

  const advancePreview = () => {
    if (!selectedForm || !previewPage || !validatePreviewPage()) return;
    const nextPageId = getNextPageId(selectedForm, previewPage.id, answers);
    if (!nextPageId) {
      submitPreview();
      return;
    }
    setPreviewHistory((current) => [...current, previewPage.id]);
    setPreviewPageId(nextPageId);
    setErrors({});
  };

  const backPreview = () => {
    const previous = previewHistory[previewHistory.length - 1];
    if (!previous) return;
    setPreviewHistory((current) => current.slice(0, -1));
    setPreviewPageId(previous);
    setErrors({});
  };

  const exportNative = () => {
    if (!selectedForm) return;
    const bytes = serializeTamishraForm(selectedForm, formResponses);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: TMFORM_MIME_TYPE });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = tamishraFormFilename(selectedForm.title);
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(".tmfm exported");
  };

  const exportCsv = () => {
    if (!selectedForm) return;
    downloadText(
      (selectedForm.title || "form").replace(/[^a-z0-9-_]+/gi, "-") + "-responses.csv",
      responsesToCsv(selectedForm, formResponses),
      "text/csv;charset=utf-8"
    );
    setStatus("Responses CSV exported");
  };

  const trashSelected = () => {
    if (!selectedForm) return;
    updateForm(selectedForm.id, { trashedAt: new Date().toISOString() });
    mutateWorkspaceFileIndex((index) => trashWorkspaceFile(index, "forms:" + selectedForm.id));
    setSelectedId(null);
    setSelectedFieldId(null);
  };

  const restoreSelected = () => {
    if (!selectedForm) return;
    updateForm(selectedForm.id, { trashedAt: null });
    mutateWorkspaceFileIndex((index) =>
      upsertWorkspaceFile(index, {
        id: "forms:" + selectedForm.id,
        title: selectedForm.title || "Untitled form",
        kind: "forms",
        appHref: "/apps/forms?form=" + encodeURIComponent(selectedForm.id),
        nativeExtension: ".tmfm",
        nativeMime: TMFORM_MIME_TYPE,
        sourceId: selectedForm.id,
        storage: "local"
      })
    );
    setView("forms");
    setStatus("Form restored");
  };

  const deleteForever = () => {
    if (!selectedForm || !window.confirm("Permanently delete this form and its responses?")) return;
    const id = selectedForm.id;
    setSnapshot((current) => ({
      ...current,
      forms: current.forms.filter((form) => form.id !== id),
      responses: current.responses.filter((response) => response.formId !== id)
    }));
    mutateWorkspaceFileIndex((index) => permanentlyDeleteWorkspaceFile(index, "forms:" + id));
    setSelectedId(null);
    setSelectedFieldId(null);
  };

  const copyWorkspaceLink = async () => {
    if (!selectedForm) return;
    if (selectedForm.status === "draft") {
      setStatus("Publish the form before sharing a public link");
      return;
    }
    const basePath = location.pathname.split("/apps/forms")[0];
    const href =
      location.origin +
      basePath +
      "/forms/respond?form=" +
      encodeURIComponent(selectedForm.id);
    try {
      await navigator.clipboard.writeText(href);
      setStatus("Public response link copied");
    } catch {
      setStatus("Could not copy public link");
    }
  };

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>← Tamishra Workspace</Link>
        <button className={styles.newButton} onClick={() => createNewForm()}>+ New form</button>

        <nav>
          <button className={view === "forms" ? styles.active : ""} onClick={() => setView("forms")}>
            <span>My forms</span>
            <b>{snapshot.forms.filter((form) => !form.trashedAt).length}</b>
          </button>
          <button className={view === "templates" ? styles.active : ""} onClick={() => setView("templates")}>
            <span>Templates</span>
            <b>{templates.length}</b>
          </button>
          <button className={view === "trash" ? styles.active : ""} onClick={() => setView("trash")}>
            <span>Trash</span>
            <b>{snapshot.forms.filter((form) => form.trashedAt).length}</b>
          </button>
        </nav>

        <div className={styles.sideInfo}>
          <strong>.tmfm</strong>
          <span>Tamishra native form package</span>
          <small>Local-first · integrity checked</small>
        </div>
      </aside>

      <section className={styles.listPane}>
        <div className={styles.search}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search forms" />
          <button onClick={() => inputRef.current?.click()}>Open</button>
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".tmfm,application/vnd.tamishra.form"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void file.arrayBuffer().then(importNativeBytes).catch((error) =>
                setStatus(error instanceof Error ? error.message : "Could not open form")
              );
            }}
          />
        </div>

        {view === "templates" ? (
          <div className={styles.templateList}>
            {templates.map((template) => (
              <button key={template.key} onClick={() => createNewForm(template.key)}>
                <span className={styles.templateIcon}>{template.title.slice(0, 1)}</span>
                <strong>{template.title}</strong>
                <p>{template.description}</p>
                <small>Create from template →</small>
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.formList}>
            {visibleForms.map((form) => (
              <button
                key={form.id}
                className={selectedId === form.id ? styles.selected : ""}
                onClick={() => selectForm(form.id)}
              >
                <div className={styles.formListTop}>
                  <strong>{form.title || "Untitled form"}</strong>
                  <span data-status={form.status}>{form.status}</span>
                </div>
                <p>{form.description || form.fields.length + " fields"}</p>
                <small>
                  {snapshot.responses.filter((response) => response.formId === form.id).length} responses ·{" "}
                  {new Date(form.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))}
            {!visibleForms.length && <div className={styles.emptyList}>No forms in this view.</div>}
          </div>
        )}
      </section>

      <section className={styles.workspace}>
        {selectedForm ? (
          <>
            <header className={styles.topbar}>
              <div className={styles.titleGroup}>
                <input
                  value={selectedForm.title}
                  onChange={(event) => updateForm(selectedForm.id, { title: event.target.value })}
                  placeholder="Untitled form"
                />
                <div>
                  <span className={styles.statusDot} data-state={selectedForm.status} />
                  <span>{selectedForm.status}</span>
                  <i>·</i>
                  <span>{status}</span>
                </div>
              </div>
              <div className={styles.actions}>
                <button onClick={copyWorkspaceLink}>Copy link</button>
                <button onClick={exportNative}>Export</button>
                {selectedForm.status === "draft" && (
                  <button
                    className={styles.primaryAction}
                    onClick={() => updateForm(selectedForm.id, setFormStatus(selectedForm, "published"))}
                  >
                    Publish
                  </button>
                )}
                {selectedForm.status === "published" && (
                  <button onClick={() => updateForm(selectedForm.id, setFormStatus(selectedForm, "closed"))}>
                    Close
                  </button>
                )}
                {selectedForm.status === "closed" && (
                  <button onClick={() => updateForm(selectedForm.id, setFormStatus(selectedForm, "published"))}>
                    Reopen
                  </button>
                )}
                {view === "trash" ? (
                  <>
                    <button onClick={restoreSelected}>Restore</button>
                    <button className={styles.danger} onClick={deleteForever}>Delete forever</button>
                  </>
                ) : (
                  <button className={styles.iconAction} title="Move to trash" onClick={trashSelected}>⌫</button>
                )}
              </div>
            </header>

            <nav className={styles.modeTabs}>
              {(["build", "logic", "preview", "responses", "settings"] as Mode[]).map((item) => (
                <button
                  key={item}
                  className={mode === item ? styles.activeTab : ""}
                  onClick={() => setMode(item)}
                >
                  {item === "responses" ? "Responses " + formResponses.length : item[0].toUpperCase() + item.slice(1)}
                </button>
              ))}
            </nav>

            {mode === "build" && (
              <div className={styles.builder}>
                <aside className={styles.palette}>
                  <div className={styles.panelTitle}>
                    <strong>Fields</strong>
                    <span>{selectedForm.fields.length}</span>
                  </div>
                  {fieldGroups.map((group) => (
                    <div className={styles.fieldGroup} key={group.name}>
                      <span>{group.name}</span>
                      {group.items.map((type) => (
                        <button key={type} onClick={() => addField(type)}>
                          <b>+</b>
                          <span>{fieldLabels[type]}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </aside>

                <section className={styles.canvas}>
                  <div
                    className={styles.formSurface}
                    data-surface={selectedForm.theme.surface}
                    style={{ "--form-accent": selectedForm.theme.accent } as React.CSSProperties}
                  >
                    <div className={styles.formIntro}>
                      <textarea
                        value={selectedForm.description}
                        onChange={(event) => updateForm(selectedForm.id, { description: event.target.value })}
                        placeholder="Add a description for respondents"
                      />
                    </div>

                    {selectedForm.fields.map((field, index) => (
                      <article
                        key={field.id}
                        className={selectedFieldId === field.id ? styles.fieldCardSelected : styles.fieldCard}
                        onClick={() => setSelectedFieldId(field.id)}
                      >
                        <div className={styles.fieldCardHeader}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <b>{fieldLabels[field.type]}</b>
                          {field.required && <i>Required</i>}
                        </div>
                        <strong>{field.label || "Question"}</strong>
                        {field.description && <p>{field.description}</p>}
                        <div className={styles.fieldGhost}>
                          {field.type === "multiple-choice" || field.type === "checkboxes" || field.type === "yes-no"
                            ? field.options.slice(0, 3).map((option) => <span key={option}>○ {option}</span>)
                            : field.type === "rating"
                              ? <span>1  2  3  4  5</span>
                              : <span>{field.placeholder || "Respondent input"}</span>}
                        </div>
                        <div className={styles.fieldQuickActions}>
                          <button onClick={(event) => { event.stopPropagation(); moveField(field.id, -1); }}>↑</button>
                          <button onClick={(event) => { event.stopPropagation(); moveField(field.id, 1); }}>↓</button>
                          <button onClick={(event) => { event.stopPropagation(); duplicateField(field.id); }}>Duplicate</button>
                          <button onClick={(event) => { event.stopPropagation(); deleteField(field.id); }}>Delete</button>
                        </div>
                      </article>
                    ))}

                    {!selectedForm.fields.length && (
                      <button className={styles.emptyCanvas} onClick={() => addField("short-text")}>
                        + Add the first field
                      </button>
                    )}
                  </div>
                </section>

                <aside className={styles.inspector}>
                  <div className={styles.panelTitle}>
                    <strong>Properties</strong>
                    <span>{selectedField ? fieldLabels[selectedField.type] : "No field"}</span>
                  </div>

                  {selectedField ? (
                    <div className={styles.propertyStack}>
                      <label>
                        <span>Label</span>
                        <input value={selectedField.label} onChange={(event) => updateField(selectedField.id, { label: event.target.value })} />
                      </label>
                      <label>
                        <span>Description</span>
                        <textarea value={selectedField.description} onChange={(event) => updateField(selectedField.id, { description: event.target.value })} />
                      </label>
                      {!["multiple-choice", "checkboxes", "dropdown", "yes-no", "rating"].includes(selectedField.type) && (
                        <label>
                          <span>Placeholder</span>
                          <input value={selectedField.placeholder} onChange={(event) => updateField(selectedField.id, { placeholder: event.target.value })} />
                        </label>
                      )}

                      {["multiple-choice", "checkboxes", "dropdown", "yes-no"].includes(selectedField.type) && (
                        <label>
                          <span>Options · one per line</span>
                          <textarea
                            value={selectedField.options.join("\n")}
                            onChange={(event) =>
                              updateField(selectedField.id, {
                                options: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean)
                              })
                            }
                          />
                        </label>
                      )}

                      {selectedField.type === "rating" && (
                        <div className={styles.inlineFields}>
                          <label>
                            <span>Minimum</span>
                            <input
                              type="number"
                              value={selectedField.min ?? 1}
                              onChange={(event) => updateField(selectedField.id, { min: Number(event.target.value) })}
                            />
                          </label>
                          <label>
                            <span>Maximum</span>
                            <input
                              type="number"
                              value={selectedField.max ?? 5}
                              onChange={(event) => updateField(selectedField.id, { max: Number(event.target.value) })}
                            />
                          </label>
                        </div>
                      )}

                      {(selectedField.type === "short-text" || selectedField.type === "paragraph") && (
                        <div className={styles.inlineFields}>
                          <label>
                            <span>Min chars</span>
                            <input
                              type="number"
                              min="0"
                              value={selectedField.validation?.minLength ?? ""}
                              onChange={(event) =>
                                updateField(selectedField.id, {
                                  validation: {
                                    ...selectedField.validation,
                                    minLength: event.target.value ? Number(event.target.value) : undefined
                                  }
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>Max chars</span>
                            <input
                              type="number"
                              min="0"
                              value={selectedField.validation?.maxLength ?? ""}
                              onChange={(event) =>
                                updateField(selectedField.id, {
                                  validation: {
                                    ...selectedField.validation,
                                    maxLength: event.target.value ? Number(event.target.value) : undefined
                                  }
                                })
                              }
                            />
                          </label>
                        </div>
                      )}

                      {selectedField.type === "number" && (
                        <div className={styles.inlineFields}>
                          <label>
                            <span>Minimum</span>
                            <input
                              type="number"
                              value={selectedField.validation?.min ?? ""}
                              onChange={(event) =>
                                updateField(selectedField.id, {
                                  validation: {
                                    ...selectedField.validation,
                                    min: event.target.value ? Number(event.target.value) : undefined
                                  }
                                })
                              }
                            />
                          </label>
                          <label>
                            <span>Maximum</span>
                            <input
                              type="number"
                              value={selectedField.validation?.max ?? ""}
                              onChange={(event) =>
                                updateField(selectedField.id, {
                                  validation: {
                                    ...selectedField.validation,
                                    max: event.target.value ? Number(event.target.value) : undefined
                                  }
                                })
                              }
                            />
                          </label>
                        </div>
                      )}

                      <label className={styles.toggleRow}>
                        <input
                          type="checkbox"
                          checked={selectedField.required}
                          onChange={(event) => updateField(selectedField.id, { required: event.target.checked })}
                        />
                        <span><b>Required</b><small>Respondent must answer this field.</small></span>
                      </label>
                    </div>
                  ) : (
                    <div className={styles.emptyInspector}>Select a field on the canvas.</div>
                  )}
                </aside>
              </div>
            )}

            {mode === "logic" && (
              <div className={styles.logicWorkspace}>
                <div className={styles.sectionHeader}>
                  <div>
                    <span>CONDITIONAL LOGIC</span>
                    <h2>Control when fields appear.</h2>
                    <p>Each rule is evaluated instantly in Preview. No decorative logic controls.</p>
                  </div>
                </div>
                <div className={styles.logicList}>
                  {selectedForm.fields.map((field, index) => {
                    const earlier = selectedForm.fields.slice(0, index);
                    return (
                      <article key={field.id}>
                        <div>
                          <strong>{field.label}</strong>
                          <span>{fieldLabels[field.type]}</span>
                        </div>
                        {index === 0 ? (
                          <small>First field is always visible.</small>
                        ) : (
                          <div className={styles.logicControls}>
                            <select
                              value={field.visibility?.fieldId ?? ""}
                              onChange={(event) =>
                                updateField(field.id, {
                                  visibility: event.target.value
                                    ? {
                                        fieldId: event.target.value,
                                        operator: field.visibility?.operator ?? "equals",
                                        value: field.visibility?.value ?? ""
                                      }
                                    : null
                                })
                              }
                            >
                              <option value="">Always show</option>
                              {earlier.map((source) => <option key={source.id} value={source.id}>When “{source.label}”</option>)}
                            </select>

                            {field.visibility && (
                              <>
                                <select
                                  value={field.visibility.operator}
                                  onChange={(event) =>
                                    updateField(field.id, {
                                      visibility: {
                                        ...field.visibility!,
                                        operator: event.target.value as FormLogicOperator
                                      }
                                    })
                                  }
                                >
                                  {logicOperators.map((operator) => (
                                    <option key={operator.value} value={operator.value}>{operator.label}</option>
                                  ))}
                                </select>
                                {!["is-empty", "is-not-empty"].includes(field.visibility.operator) && (
                                  <input
                                    value={field.visibility.value ?? ""}
                                    placeholder="Value"
                                    onChange={(event) =>
                                      updateField(field.id, {
                                        visibility: { ...field.visibility!, value: event.target.value }
                                      })
                                    }
                                  />
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            {mode === "preview" && (
              <div className={styles.previewArea}>
                <div
                  className={styles.previewCard}
                  data-surface={selectedForm.theme.surface}
                  style={{ "--form-accent": selectedForm.theme.accent } as React.CSSProperties}
                >
                  <div className={styles.previewHeader}>
                    <span>LIVE PREVIEW</span>
                    <h1>{selectedForm.title || "Untitled form"}</h1>
                    {selectedForm.description && <p>{selectedForm.description}</p>}
                    {selectedForm.status === "closed" && <div className={styles.closedBanner}>This form is closed.</div>}
                  </div>

                  <div className={styles.previewFields}>
                    {selectedForm.settings.collectEmail && (
                      <label className={styles.previewField}>
                        <div><strong>Respondent email</strong><em>*</em></div>
                        <input
                          className={errors.__respondentEmail ? styles.inputError : ""}
                          type="email"
                          value={String(answers.__respondentEmail ?? "")}
                          placeholder="name@example.com"
                          onChange={(event) =>
                            setAnswers((current) => ({ ...current, __respondentEmail: event.target.value }))
                          }
                        />
                        {errors.__respondentEmail && <small>{errors.__respondentEmail}</small>}
                      </label>
                    )}
                    {selectedForm.fields.filter((field) => isFieldVisible(field, answers)).map((field) => (
                      <label className={styles.previewField} key={field.id}>
                        <div>
                          <strong>{field.label}</strong>
                          {field.required && <em>*</em>}
                        </div>
                        {field.description && <p>{field.description}</p>}
                        <InputPreview
                          field={field}
                          value={answers[field.id]}
                          error={errors[field.id]}
                          onChange={(value) =>
                            setAnswers((current) => ({ ...current, [field.id]: value }))
                          }
                        />
                        {errors[field.id] && <small>{errors[field.id]}</small>}
                      </label>
                    ))}
                  </div>

                  <button
                    className={styles.submitButton}
                    disabled={selectedForm.status === "closed"}
                    onClick={submitPreview}
                  >
                    Submit response
                  </button>
                </div>
              </div>
            )}

            {mode === "responses" && (
              <div className={styles.responsesArea}>
                <div className={styles.metrics}>
                  <article><span>Responses</span><strong>{formResponses.length}</strong></article>
                  <article>
                    <span>Fields</span>
                    <strong>{selectedForm.fields.length}</strong>
                  </article>
                  <article>
                    <span>Status</span>
                    <strong>{selectedForm.status}</strong>
                  </article>
                  <article>
                    <span>Latest</span>
                    <strong>{formResponses[0] ? new Date(formResponses[0].submittedAt).toLocaleDateString() : "—"}</strong>
                  </article>
                </div>

                <div className={styles.responseToolbar}>
                  <div>
                    <strong>Response table</strong>
                    <span>Rows are submissions. Columns are form fields.</span>
                  </div>
                  <button onClick={exportCsv} disabled={!formResponses.length}>Export CSV</button>
                </div>

                {formResponses.length ? (
                  <div className={styles.tableWrap}>
                    <table>
                      <thead>
                        <tr>
                          <th>Submitted</th>
                          {selectedForm.settings.collectEmail && <th>Respondent email</th>}
                          {selectedForm.fields.map((field) => <th key={field.id}>{field.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {formResponses.map((response) => (
                          <tr key={response.id}>
                            <td>{new Date(response.submittedAt).toLocaleString()}</td>
                            {selectedForm.settings.collectEmail && <td>{String(response.answers.__respondentEmail ?? "")}</td>}
                            {selectedForm.fields.map((field) => {
                              const value = response.answers[field.id];
                              return <td key={field.id}>{Array.isArray(value) ? value.join(", ") : String(value ?? "")}</td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className={styles.emptyResponses}>
                    <strong>No responses yet.</strong>
                    <span>Use Preview to submit a real local response and test the form end to end.</span>
                    <button onClick={() => setMode("preview")}>Open preview</button>
                  </div>
                )}
              </div>
            )}

            {mode === "settings" && (
              <div className={styles.settingsArea}>
                <section>
                  <div className={styles.sectionHeader}>
                    <div><span>FORM SETTINGS</span><h2>Behaviour</h2></div>
                  </div>
                  <div className={styles.settingsGrid}>
                    <label className={styles.toggleRow}>
                      <input
                        type="checkbox"
                        checked={selectedForm.settings.collectEmail}
                        onChange={(event) =>
                          updateForm(selectedForm.id, {
                            settings: { ...selectedForm.settings, collectEmail: event.target.checked }
                          })
                        }
                      />
                      <span><b>Collect respondent email</b><small>Store an email field with each response when enabled.</small></span>
                    </label>
                    <label className={styles.toggleRow}>
                      <input
                        type="checkbox"
                        checked={selectedForm.settings.allowMultipleSubmissions}
                        onChange={(event) =>
                          updateForm(selectedForm.id, {
                            settings: { ...selectedForm.settings, allowMultipleSubmissions: event.target.checked }
                          })
                        }
                      />
                      <span><b>Allow multiple submissions</b><small>Prepared for identity-aware publishing.</small></span>
                    </label>
                    <label>
                      <span>Response limit</span>
                      <input
                        type="number"
                        min="1"
                        placeholder="Unlimited"
                        value={selectedForm.settings.responseLimit ?? ""}
                        onChange={(event) =>
                          updateForm(selectedForm.id, {
                            settings: {
                              ...selectedForm.settings,
                              responseLimit: event.target.value ? Number(event.target.value) : null
                            }
                          })
                        }
                      />
                    </label>
                    <label className={styles.wideSetting}>
                      <span>Confirmation message</span>
                      <textarea
                        value={selectedForm.settings.confirmationMessage}
                        onChange={(event) =>
                          updateForm(selectedForm.id, {
                            settings: { ...selectedForm.settings, confirmationMessage: event.target.value }
                          })
                        }
                      />
                    </label>
                  </div>
                </section>

                <section>
                  <div className={styles.sectionHeader}>
                    <div><span>APPEARANCE</span><h2>Theme</h2></div>
                  </div>
                  <div className={styles.themeControls}>
                    {["#315cf4", "#0f766e", "#7c3aed", "#c2410c", "#be123c", "#334155"].map((accent) => (
                      <button
                        key={accent}
                        className={selectedForm.theme.accent === accent ? styles.themeSelected : ""}
                        style={{ background: accent }}
                        aria-label={"Use accent " + accent}
                        onClick={() =>
                          updateForm(selectedForm.id, {
                            theme: { ...selectedForm.theme, accent }
                          })
                        }
                      />
                    ))}
                  </div>
                  <div className={styles.settingsGrid}>
                    <label>
                      <span>Surface</span>
                      <select
                        value={selectedForm.theme.surface}
                        onChange={(event) =>
                          updateForm(selectedForm.id, {
                            theme: {
                              ...selectedForm.theme,
                              surface: event.target.value as TamishraForm["theme"]["surface"]
                            }
                          })
                        }
                      >
                        <option value="clean">Clean</option>
                        <option value="soft">Soft</option>
                        <option value="glass">Glass</option>
                      </select>
                    </label>
                    <label>
                      <span>Density</span>
                      <select
                        value={selectedForm.theme.density}
                        onChange={(event) =>
                          updateForm(selectedForm.id, {
                            theme: {
                              ...selectedForm.theme,
                              density: event.target.value as TamishraForm["theme"]["density"]
                            }
                          })
                        }
                      >
                        <option value="comfortable">Comfortable</option>
                        <option value="compact">Compact</option>
                      </select>
                    </label>
                  </div>
                </section>
              </div>
            )}
          </>
        ) : (
          <div className={styles.emptyWorkspace}>
            <div className={styles.emptyMark}>F</div>
            <strong>{view === "templates" ? "Choose a template" : "Build your first Tamishra Form"}</strong>
            <p>Structured data collection with native files, validation, logic, preview and response tables.</p>
            <button onClick={() => view === "templates" ? createNewForm("registration") : createNewForm()}>
              {view === "templates" ? "Use registration template" : "Create blank form"}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}