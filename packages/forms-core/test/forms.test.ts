import assert from "node:assert/strict";
import test from "node:test";
import {
  createField,
  createForm,
  createFormPage,
  getFieldsForPage,
  getNextPageId,
  normalizeForm,
  parseTamishraForm,
  serializeTamishraForm,
  validateAnswers
} from "../src/index.js";

test("legacy forms normalize into one page", () => {
  const field = createField("short-text", "Name");
  const form = normalizeForm({
    id: "legacy_form",
    title: "Legacy",
    fields: [field]
  });

  assert.equal(form.pages.length, 1);
  assert.deepEqual(form.pages[0].fieldIds, [field.id]);
  assert.deepEqual(getFieldsForPage(form, form.pages[0].id).map((item) => item.id), [field.id]);
});

test("forward page branching follows the first matching rule", () => {
  const first = createField("yes-no", "Continue to engineering?");
  first.options = ["Yes", "No"];
  const second = createField("short-text", "General details");
  const third = createField("short-text", "Engineering details");

  const page1 = createFormPage("Start", [first.id]);
  const page2 = createFormPage("General", [second.id]);
  const page3 = createFormPage("Engineering", [third.id]);
  page1.branchRules = [
    {
      id: "branch_engineering",
      sourceFieldId: first.id,
      operator: "equals",
      value: "Yes",
      targetPageId: page3.id
    }
  ];

  const form = normalizeForm({
    id: "branch_form",
    title: "Branch form",
    fields: [first, second, third],
    pages: [page1, page2, page3]
  });

  assert.equal(getNextPageId(form, page1.id, { [first.id]: "Yes" }), page3.id);
  assert.equal(getNextPageId(form, page1.id, { [first.id]: "No" }), page2.id);
});

test("backward branch targets are removed during normalization", () => {
  const first = createField("short-text", "One");
  const second = createField("short-text", "Two");
  const page1 = createFormPage("One", [first.id]);
  const page2 = createFormPage("Two", [second.id]);

  page2.branchRules = [
    {
      id: "cycle",
      sourceFieldId: second.id,
      operator: "equals",
      value: "Back",
      targetPageId: page1.id
    }
  ];

  const form = normalizeForm({
    id: "cycle_form",
    title: "Cycle form",
    fields: [first, second],
    pages: [page1, page2]
  });

  assert.equal(form.pages[1].branchRules.length, 0);
});

test("validation respects required, email and conditional visibility rules", () => {
  const email = { ...createField("email", "Email"), required: true };
  const detail = {
    ...createField("short-text", "Detail"),
    required: true,
    visibility: {
      fieldId: email.id,
      operator: "equals" as const,
      value: "show@example.com"
    }
  };

  const form = normalizeForm({
    id: "validation_form",
    title: "Validation",
    fields: [email, detail]
  });

  const invalid = validateAnswers(form, { [email.id]: "not-an-email" });
  assert.equal(invalid[email.id], "Enter a valid email address.");
  assert.equal(invalid[detail.id], undefined);

  const conditional = validateAnswers(form, { [email.id]: "show@example.com" });
  assert.equal(conditional[detail.id], "This question is required.");
});

test("native form serialization round-trips page metadata", () => {
  const form = createForm("Round trip");
  const page2 = createFormPage("Second");
  const normalized = normalizeForm({
    ...form,
    pages: [...form.pages, page2]
  });

  const bytes = serializeTamishraForm(normalized);
  const parsed = parseTamishraForm(bytes);

  assert.equal(parsed.form.title, "Round trip");
  assert.equal(parsed.form.pages.length, 2);
  assert.equal(parsed.form.pages[1].title, "Second");
});
