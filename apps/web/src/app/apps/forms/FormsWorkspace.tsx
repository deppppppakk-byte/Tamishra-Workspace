"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addResponse,
  createField,
  createForm,
  createFormsSnapshot,
  mergeFormsSnapshots,
  normalizeFormsSnapshot,
  parseTamishraForm,
  responsesToCsv,
  serializeTamishraForm,
  tamishraFormFilename,
  TMFORM_MIME_TYPE,
  validateAnswers,
  type FormField,
  type FormFieldType,
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
import {
  hydrateWorkspaceContent,
  pushWorkspaceContent
} from "../../../lib/workspace-content-sync";
import styles from "./forms.module.css";

const STORAGE_KEY = "tamishra.forms.snapshot.v1";
type Mode = "build" | "preview" | "responses";
type View = "forms" | "trash";

function loadSnapshot(): FormsSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createFormsSnapshot();
    const parsed = JSON.parse(raw) as Partial<FormsSnapshot>;
    return {
      version: 1,
      forms: Array.isArray(parsed.forms) ? parsed.forms : [],
      responses: Array.isArray(parsed.responses) ? parsed.responses : [],
      deleted:
        parsed.deleted && typeof parsed.deleted === "object" && !Array.isArray(parsed.deleted)
          ? parsed.deleted
          : {}
    };
  } catch {
    return createFormsSnapshot();
  }
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

const fieldLabels: Record<FormFieldType, string> = {
  "short-text": "Short text",
  paragraph: "Paragraph",
  "multiple-choice": "Multiple choice",
  checkboxes: "Checkboxes",
  dropdown: "Dropdown",
  number: "Number",
  date: "Date",
  rating: "Rating"
};

function copyField(field: FormField): FormField {
  const next = createField(field.type, field.label);
  return {
    ...next,
    description: field.description,
    required: field.required,
    options: [...field.options],
    min: field.min,
    max: field.max
  };
}

export default function FormsWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<FormsSnapshot>(() => createFormsSnapshot());
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
          : [form.title, form.description]
              .join(" ")
              .toLowerCase()
              .includes(normalized)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [snapshot.forms, query, view]);

  const selectForm = (id: string) => {
    setSelectedId(id);
    setAnswers({});
    setErrors({});
    history.replaceState(null, "", `/apps/forms?form=${encodeURIComponent(id)}`);
  };

  const createNewForm = () => {
    const form = createForm();
    setSnapshot((current) => ({
      ...current,
      forms: [form, ...current.forms]
    }));
    setView("forms");
    setMode("build");
    selectForm(form.id);
    setStatus("New form");
  };

  const updateForm = (id: string, patch: Partial<TamishraForm>) => {
    const now = new Date().toISOString();
    setSnapshot((current) => ({
      ...current,
      forms: current.forms.map((form) =>
        form.id === id ? { ...form, ...patch, updatedAt: now } : form
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

  const importNativeBytes = (bytes: ArrayBuffer | Uint8Array) => {
    const payload = parseTamishraForm(bytes);
    const form = {
      ...payload.form,
      trashedAt: null,
      updatedAt: new Date().toISOString()
    };
    setSnapshot((current) => ({
      ...current,
      forms: [form, ...current.forms.filter((item) => item.id !== form.id)],
      responses: [
        ...payload.responses,
        ...current.responses.filter((item) => item.formId !== form.id)
      ]
    }));
    setView("forms");
    setMode("build");
    selectForm(form.id);
    setStatus(".tmfm opened · integrity verified");
  };

  useEffect(() => {
    let cancelled = false;
    const restored = normalizeFormsSnapshot(loadSnapshot());
    setSnapshot(restored);

    const requestedId = new URLSearchParams(location.search).get("form");
    if (requestedId && restored.forms.some((form) => form.id === requestedId)) {
      setSelectedId(requestedId);
    } else {
      setSelectedId(restored.forms.find((form) => !form.trashedAt)?.id ?? null);
    }

    void hydrateWorkspaceContent(
      "forms",
      restored,
      normalizeFormsSnapshot,
      mergeFormsSnapshots
    ).then((result) => {
      if (cancelled) return;

      setSnapshot((current) =>
        mergeFormsSnapshots(current, result.state)
      );

      if (!requestedId) {
        const first = result.state.forms.find((form) => !form.trashedAt);
        if (first) setSelectedId((current) => current ?? first.id);
      }

      setStatus(
        result.cloudAvailable
          ? result.persistence === "postgres"
            ? "Cloud synchronized"
            : "Synced to session storage"
          : "Local-first"
      );
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      !loaded ||
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in window)
    ) {
      return;
    }

    let cancelled = false;

    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("startup_tmfm"))
      .then((raw) => {
        if (cancelled || !raw) return;
        importNativeBytes(new TextEncoder().encode(raw));
        setStatus(".tmfm opened from desktop");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Could not open startup .tmfm", error);
        setStatus("Startup .tmfm could not be opened");
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
      .catch((error) => {
        console.error("Forms handoff failed", error);
        setStatus("Workspace form could not be opened");
      });
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
            id: `forms:${form.id}`,
            title: form.title || "Untitled form",
            kind: "forms",
            appHref: `/apps/forms?form=${encodeURIComponent(form.id)}`,
            nativeExtension: ".tmfm",
            nativeMime: TMFORM_MIME_TYPE,
            sourceId: form.id,
            sizeBytes: new Blob([
              JSON.stringify({
                form,
                responses: snapshot.responses.filter(
                  (response) => response.formId === form.id
                )
              })
            ]).size,
            storage: "local",
            updatedAt: form.updatedAt,
            lastOpenedAt: form.id === selectedId ? new Date().toISOString() : form.updatedAt
          });
        }
        return next;
      });

      void pushWorkspaceContent(
        "forms",
        snapshot,
        normalizeFormsSnapshot,
        mergeFormsSnapshots
      ).then((result) => {
        if (result.cloudAvailable) {
          setStatus(
            result.persistence === "postgres"
              ? "Saved · cloud synchronized"
              : "Saved · session synchronized"
          );
        } else {
          setStatus("Saved locally");
        }

        const merged = normalizeFormsSnapshot(result.state);
        if (JSON.stringify(merged) !== JSON.stringify(snapshot)) {
          setSnapshot(merged);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        }
      });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [snapshot, loaded, selectedId]);

  const addField = (type: FormFieldType) => {
    if (!selectedForm) return;
    updateForm(selectedForm.id, {
      fields: [...selectedForm.fields, createField(type, "Question")]
    });
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
    const fields = [...selectedForm.fields];
    fields.splice(index + 1, 0, copyField(fields[index]));
    updateForm(selectedForm.id, { fields });
  };

  const deleteField = (fieldId: string) => {
    if (!selectedForm) return;
    updateForm(selectedForm.id, {
      fields: selectedForm.fields.filter((field) => field.id !== fieldId)
    });
  };

  const submitPreview = () => {
    if (!selectedForm) return;
    const nextErrors = validateAnswers(selectedForm, answers);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setStatus("Complete required questions");
      return;
    }

    setSnapshot((current) =>
      addResponse(current, selectedForm.id, answers).snapshot
    );
    setAnswers({});
    setErrors({});
    setStatus("Response recorded locally");
    setMode("responses");
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
      (selectedForm.title || "form").replace(/[^a-z0-9-_]+/gi, "-") +
        "-responses.csv",
      responsesToCsv(selectedForm, formResponses),
      "text/csv;charset=utf-8"
    );
    setStatus("Responses CSV exported");
  };

  const trashSelected = () => {
    if (!selectedForm) return;
    updateForm(selectedForm.id, { trashedAt: new Date().toISOString() });
    mutateWorkspaceFileIndex((index) =>
      trashWorkspaceFile(index, `forms:${selectedForm.id}`)
    );
    setSelectedId(null);
  };

  const restoreSelected = () => {
    if (!selectedForm) return;
    updateForm(selectedForm.id, { trashedAt: null });
    mutateWorkspaceFileIndex((index) =>
      upsertWorkspaceFile(index, {
        id: `forms:${selectedForm.id}`,
        title: selectedForm.title || "Untitled form",
        kind: "forms",
        appHref: `/apps/forms?form=${encodeURIComponent(selectedForm.id)}`,
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
      responses: current.responses.filter((response) => response.formId !== id),
      deleted: {
        ...current.deleted,
        [id]: new Date().toISOString()
      }
    }));
    mutateWorkspaceFileIndex((index) =>
      permanentlyDeleteWorkspaceFile(index, `forms:${id}`)
    );
    setSelectedId(null);
  };

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>← Tamishra Workspace</Link>
        <button className={styles.newButton} onClick={createNewForm}>+ New form</button>
        <nav>
          <button className={view === "forms" ? styles.active : ""} onClick={() => setView("forms")}>
            My forms
            <span>{snapshot.forms.filter((form) => !form.trashedAt).length}</span>
          </button>
          <button className={view === "trash" ? styles.active : ""} onClick={() => setView("trash")}>
            Trash
            <span>{snapshot.forms.filter((form) => form.trashedAt).length}</span>
          </button>
        </nav>
        <div className={styles.help}>
          <strong>.tmfm</strong>
          <span>Tamishra Forms native format</span>
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

        <div className={styles.formList}>
          {visibleForms.map((form) => (
            <button
              key={form.id}
              className={selectedId === form.id ? styles.selected : ""}
              onClick={() => selectForm(form.id)}
            >
              <strong>{form.title || "Untitled form"}</strong>
              <p>{form.description || `${form.fields.length} questions`}</p>
              <span>
                {snapshot.responses.filter((response) => response.formId === form.id).length} responses
              </span>
            </button>
          ))}
          {!visibleForms.length && <div className={styles.emptyList}>No forms in this view.</div>}
        </div>
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
                <span>{status}</span>
              </div>
              <div className={styles.actions}>
                <button onClick={exportNative}>Export .tmfm</button>
                {view === "trash" ? (
                  <>
                    <button onClick={restoreSelected}>Restore</button>
                    <button className={styles.danger} onClick={deleteForever}>Delete forever</button>
                  </>
                ) : (
                  <button className={styles.danger} onClick={trashSelected}>Trash</button>
                )}
              </div>
            </header>

            <nav className={styles.modeTabs}>
              {(["build", "preview", "responses"] as Mode[]).map((item) => (
                <button
                  key={item}
                  className={mode === item ? styles.activeTab : ""}
                  onClick={() => setMode(item)}
                >
                  {item === "build" ? "Build" : item === "preview" ? "Preview" : `Responses (${formResponses.length})`}
                </button>
              ))}
            </nav>

            {mode === "build" && (
              <div className={styles.builder}>
                <div className={styles.formIntro}>
                  <textarea
                    value={selectedForm.description}
                    onChange={(event) => updateForm(selectedForm.id, { description: event.target.value })}
                    placeholder="Form description"
                  />
                </div>

                {selectedForm.fields.map((field, index) => (
                  <article className={styles.fieldCard} key={field.id}>
                    <div className={styles.fieldTop}>
                      <span>Question {index + 1}</span>
                      <select
                        value={field.type}
                        onChange={(event) => {
                          const type = event.target.value as FormFieldType;
                          const template = createField(type, field.label);
                          updateField(field.id, {
                            type,
                            options: template.options,
                            min: template.min,
                            max: template.max
                          });
                        }}
                      >
                        {(Object.keys(fieldLabels) as FormFieldType[]).map((type) => (
                          <option key={type} value={type}>{fieldLabels[type]}</option>
                        ))}
                      </select>
                    </div>

                    <input
                      className={styles.question}
                      value={field.label}
                      onChange={(event) => updateField(field.id, { label: event.target.value })}
                      placeholder="Question"
                    />
                    <input
                      className={styles.description}
                      value={field.description}
                      onChange={(event) => updateField(field.id, { description: event.target.value })}
                      placeholder="Description (optional)"
                    />

                    {["multiple-choice", "checkboxes", "dropdown"].includes(field.type) && (
                      <div className={styles.options}>
                        {field.options.map((option, optionIndex) => (
                          <div key={optionIndex}>
                            <span>{field.type === "checkboxes" ? "□" : "○"}</span>
                            <input
                              value={option}
                              onChange={(event) => {
                                const options = [...field.options];
                                options[optionIndex] = event.target.value;
                                updateField(field.id, { options });
                              }}
                            />
                            <button
                              onClick={() =>
                                updateField(field.id, {
                                  options: field.options.filter((_, itemIndex) => itemIndex !== optionIndex)
                                })
                              }
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <button
                          className={styles.addOption}
                          onClick={() =>
                            updateField(field.id, {
                              options: [...field.options, `Option ${field.options.length + 1}`]
                            })
                          }
                        >
                          + Add option
                        </button>
                      </div>
                    )}

                    {field.type === "rating" && (
                      <div className={styles.ratingSetup}>
                        <label>Min <input type="number" min={1} max={10} value={field.min ?? 1} onChange={(event) => updateField(field.id, { min: Number(event.target.value) || 1 })} /></label>
                        <label>Max <input type="number" min={2} max={10} value={field.max ?? 5} onChange={(event) => updateField(field.id, { max: Number(event.target.value) || 5 })} /></label>
                      </div>
                    )}

                    <footer className={styles.fieldFooter}>
                      <div>
                        <button onClick={() => moveField(field.id, -1)} disabled={index === 0}>↑</button>
                        <button onClick={() => moveField(field.id, 1)} disabled={index === selectedForm.fields.length - 1}>↓</button>
                        <button onClick={() => duplicateField(field.id)}>Duplicate</button>
                        <button onClick={() => deleteField(field.id)} disabled={selectedForm.fields.length === 1}>Delete</button>
                      </div>
                      <label>
                        Required
                        <input
                          type="checkbox"
                          checked={field.required}
                          onChange={(event) => updateField(field.id, { required: event.target.checked })}
                        />
                      </label>
                    </footer>
                  </article>
                ))}

                <div className={styles.addFieldBar}>
                  <button onClick={() => addField("short-text")}>+ Text</button>
                  <button onClick={() => addField("multiple-choice")}>+ Choice</button>
                  <button onClick={() => addField("checkboxes")}>+ Checkboxes</button>
                  <button onClick={() => addField("rating")}>+ Rating</button>
                  <button onClick={() => addField("date")}>+ Date</button>
                </div>
              </div>
            )}

            {mode === "preview" && (
              <div className={styles.preview}>
                <div className={styles.previewCard}>
                  <h1>{selectedForm.title}</h1>
                  <p>{selectedForm.description}</p>
                </div>
                {selectedForm.fields.map((field) => (
                  <div className={styles.previewCard} key={field.id}>
                    <label className={styles.previewLabel}>
                      {field.label}
                      {field.required && <b> *</b>}
                    </label>
                    {field.description && <p>{field.description}</p>}

                    {field.type === "short-text" && (
                      <input
                        value={String(answers[field.id] ?? "")}
                        onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}
                      />
                    )}
                    {field.type === "paragraph" && (
                      <textarea
                        value={String(answers[field.id] ?? "")}
                        onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}
                      />
                    )}
                    {field.type === "number" && (
                      <input
                        type="number"
                        value={String(answers[field.id] ?? "")}
                        onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}
                      />
                    )}
                    {field.type === "date" && (
                      <input
                        type="date"
                        value={String(answers[field.id] ?? "")}
                        onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}
                      />
                    )}
                    {field.type === "dropdown" && (
                      <select
                        value={String(answers[field.id] ?? "")}
                        onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}
                      >
                        <option value="">Select</option>
                        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    )}
                    {field.type === "multiple-choice" && (
                      <div className={styles.choiceGroup}>
                        {field.options.map((option) => (
                          <label key={option}>
                            <input
                              type="radio"
                              name={field.id}
                              checked={answers[field.id] === option}
                              onChange={() => setAnswers((current) => ({ ...current, [field.id]: option }))}
                            />
                            {option}
                          </label>
                        ))}
                      </div>
                    )}
                    {field.type === "checkboxes" && (
                      <div className={styles.choiceGroup}>
                        {field.options.map((option) => {
                          const selected = Array.isArray(answers[field.id]) ? answers[field.id] as string[] : [];
                          return (
                            <label key={option}>
                              <input
                                type="checkbox"
                                checked={selected.includes(option)}
                                onChange={(event) => {
                                  const next = event.target.checked
                                    ? [...selected, option]
                                    : selected.filter((item) => item !== option);
                                  setAnswers((current) => ({ ...current, [field.id]: next }));
                                }}
                              />
                              {option}
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {field.type === "rating" && (
                      <div className={styles.rating}>
                        {Array.from(
                          { length: Math.max(1, (field.max ?? 5) - (field.min ?? 1) + 1) },
                          (_, index) => (field.min ?? 1) + index
                        ).map((value) => (
                          <button
                            key={value}
                            className={answers[field.id] === String(value) ? styles.ratingActive : ""}
                            onClick={() => setAnswers((current) => ({ ...current, [field.id]: String(value) }))}
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    )}
                    {errors[field.id] && <span className={styles.error}>{errors[field.id]}</span>}
                  </div>
                ))}
                <button className={styles.submit} onClick={submitPreview}>Submit response</button>
              </div>
            )}

            {mode === "responses" && (
              <div className={styles.responses}>
                <div className={styles.responseHeader}>
                  <div>
                    <strong>{formResponses.length}</strong>
                    <span>responses</span>
                  </div>
                  <button onClick={exportCsv} disabled={!formResponses.length}>Export CSV</button>
                </div>

                {formResponses.length ? (
                  <div className={styles.responseList}>
                    {formResponses.map((response, index) => (
                      <article key={response.id}>
                        <header>
                          <strong>Response {formResponses.length - index}</strong>
                          <span>{new Date(response.submittedAt).toLocaleString()}</span>
                        </header>
                        {selectedForm.fields.map((field) => (
                          <div key={field.id}>
                            <b>{field.label}</b>
                            <span>
                              {Array.isArray(response.answers[field.id])
                                ? (response.answers[field.id] as string[]).join(", ")
                                : String(response.answers[field.id] ?? "—")}
                            </span>
                          </div>
                        ))}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className={styles.emptyResponses}>No responses yet. Use Preview to submit a test response.</div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className={styles.emptyWorkspace}>
            <strong>Select a form or create a new one.</strong>
            <button onClick={createNewForm}>Create form</button>
          </div>
        )}
      </section>
    </main>
  );
}
