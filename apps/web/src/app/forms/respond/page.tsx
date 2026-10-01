"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getFieldsForPage,
  getNextPageId,
  isFieldVisible,
  normalizeForm,
  validateAnswers,
  type FormField,
  type TamishraForm
} from "@tamishra/forms-core";
import { workspaceApiBase } from "../../../lib/workspace-api";
import styles from "./respond.module.css";

function ResponseInput({
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
  const errorClass = error ? styles.inputError : "";

  if (field.type === "paragraph") {
    return (
      <textarea
        className={errorClass}
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
      <select className={errorClass} value={textValue} onChange={(event) => onChange(event.target.value)}>
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
            key={rating}
            className={textValue === String(rating) ? styles.ratingActive : ""}
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
      className={errorClass}
      type={type}
      value={textValue}
      placeholder={field.placeholder}
      min={field.type === "number" ? field.validation?.min ?? field.min : undefined}
      max={field.type === "number" ? field.validation?.max ?? field.max : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export default function PublicFormRespondPage() {
  const [form, setForm] = useState<TamishraForm | null>(null);
  const [formId, setFormId] = useState("");
  const [currentPageId, setCurrentPageId] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<"loading" | "ready" | "submitting" | "done" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const id = new URLSearchParams(location.search).get("form")?.trim() ?? "";
    if (!id) {
      setState("error");
      setMessage("No form was specified.");
      return;
    }

    setFormId(id);
    void fetch(workspaceApiBase + "/v1/forms/public/" + encodeURIComponent(id), {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store"
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body?.error === "form_not_found" ? "This form is unavailable." : "Could not load this form.");
        }
        return body;
      })
      .then((body) => {
        const next = normalizeForm(body.form ?? {});
        setForm(next);
        setCurrentPageId(next.pages[0]?.id ?? "");
        setState("ready");
      })
      .catch((error) => {
        setState("error");
        setMessage(error instanceof Error ? error.message : "Could not load this form.");
      });
  }, []);

  const currentPage = useMemo(
    () => form?.pages.find((page) => page.id === currentPageId) ?? null,
    [form, currentPageId]
  );

  const pageFields = useMemo(
    () =>
      form && currentPage
        ? getFieldsForPage(form, currentPage.id).filter((field) => isFieldVisible(field, answers))
        : [],
    [form, currentPage, answers]
  );

  const validateCurrentPage = () => {
    if (!form || !currentPage) return false;
    const pageForm = { ...form, fields: pageFields };
    const nextErrors = validateAnswers(pageForm, answers);

    if (form.settings.collectEmail && currentPage.id === form.pages[0]?.id) {
      const raw = answers.__respondentEmail;
      const email = Array.isArray(raw) ? "" : String(raw ?? "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        nextErrors.__respondentEmail = "Enter a valid email address.";
      }
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const submit = async () => {
    if (!form || !formId) return;
    setState("submitting");
    setMessage("");

    try {
      const response = await fetch(
        workspaceApiBase + "/v1/forms/public/" + encodeURIComponent(formId) + "/responses",
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ answers })
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body?.error === "form_closed") throw new Error("This form is closed.");
        if (body?.error === "response_limit_reached") throw new Error("This form is no longer accepting responses.");
        throw new Error("Your response could not be submitted.");
      }
      setState("done");
      setMessage(form.settings.confirmationMessage);
    } catch (error) {
      setState("ready");
      setMessage(error instanceof Error ? error.message : "Submission failed.");
    }
  };

  const goNext = () => {
    if (!form || !currentPage || !validateCurrentPage()) return;
    const nextPageId = getNextPageId(form, currentPage.id, answers);
    if (!nextPageId) {
      void submit();
      return;
    }
    setHistory((current) => [...current, currentPage.id]);
    setCurrentPageId(nextPageId);
    setErrors({});
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const goBack = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((current) => current.slice(0, -1));
    setCurrentPageId(previous);
    setErrors({});
  };

  if (state === "loading") {
    return <main className={styles.statePage}><div className={styles.loader} /><span>Loading form…</span></main>;
  }

  if (state === "error" || !form || !currentPage) {
    return (
      <main className={styles.statePage}>
        <div className={styles.brandMark}>T</div>
        <strong>Form unavailable</strong>
        <p>{message || "This form could not be opened."}</p>
      </main>
    );
  }

  if (state === "done") {
    return (
      <main className={styles.statePage}>
        <div className={styles.successMark}>✓</div>
        <strong>Response submitted</strong>
        <p>{message}</p>
        {form.settings.allowMultipleSubmissions && (
          <button
            onClick={() => {
              setAnswers({});
              setHistory([]);
              setCurrentPageId(form.pages[0]?.id ?? "");
              setState("ready");
              setMessage("");
            }}
          >
            Submit another response
          </button>
        )}
      </main>
    );
  }

  const pageIndex = form.pages.findIndex((page) => page.id === currentPage.id);
  const isClosed = form.status === "closed";

  return (
    <main
      className={styles.page}
      data-surface={form.theme.surface}
      style={{ "--form-accent": form.theme.accent } as React.CSSProperties}
    >
      <header className={styles.publicHeader}>
        <div className={styles.tamishra}><b>T</b><span>Tamishra Forms</span></div>
        <span>Page {Math.max(1, pageIndex + 1)} of {form.pages.length}</span>
      </header>

      <div className={styles.progress}>
        <span style={{ width: ((Math.max(0, pageIndex) + 1) / Math.max(1, form.pages.length)) * 100 + "%" }} />
      </div>

      <section className={styles.card}>
        <div className={styles.formHeader}>
          <span>PUBLIC FORM</span>
          <h1>{form.title}</h1>
          {form.description && <p>{form.description}</p>}
          {form.pages.length > 1 && (
            <div className={styles.pageHeading}>
              <strong>{currentPage.title}</strong>
              {currentPage.description && <small>{currentPage.description}</small>}
            </div>
          )}
          {isClosed && <div className={styles.closed}>This form is closed and is not accepting responses.</div>}
        </div>

        {!isClosed && (
          <div className={styles.fields}>
            {form.settings.collectEmail && currentPage.id === form.pages[0]?.id && (
              <label className={styles.field}>
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

            {pageFields.map((field) => (
              <label className={styles.field} key={field.id}>
                <div>
                  <strong>{field.label}</strong>
                  {field.required && <em>*</em>}
                </div>
                {field.description && <p>{field.description}</p>}
                <ResponseInput
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
        )}

        {!isClosed && (
          <footer className={styles.actions}>
            <button className={styles.secondary} disabled={!history.length || state === "submitting"} onClick={goBack}>
              Back
            </button>
            <button className={styles.primary} disabled={state === "submitting"} onClick={goNext}>
              {state === "submitting"
                ? "Submitting…"
                : getNextPageId(form, currentPage.id, answers)
                  ? "Continue"
                  : "Submit response"}
            </button>
          </footer>
        )}

        {message && state === "ready" && <div className={styles.errorMessage}>{message}</div>}
      </section>

      <footer className={styles.footer}>Powered by Tamishra Workspace</footer>
    </main>
  );
}
