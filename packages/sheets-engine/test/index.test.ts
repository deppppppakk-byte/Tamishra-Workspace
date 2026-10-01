import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMatrixToSheet,
  createWorkbook,
  evaluateCell,
  normalizeRange,
  normalizeWorkbook,
  parseClipboardMatrix,
  rangeAddresses,
  sortRangeRows
} from "../src/index.js";

test("formula engine evaluates ranges and statistical functions", () => {
  const workbook = createWorkbook("test");
  const sheet = workbook.sheets[0];
  sheet.cells.A1 = { raw: "10" };
  sheet.cells.A2 = { raw: "20" };
  sheet.cells.A3 = { raw: "30" };
  sheet.cells.B1 = { raw: "=SUM(A1:A3)" };
  sheet.cells.B2 = { raw: "=AVERAGE(A1:A3)" };
  sheet.cells.B3 = { raw: "=MEDIAN(A1:A3)" };

  assert.equal(evaluateCell(workbook, sheet.id, "B1"), 60);
  assert.equal(evaluateCell(workbook, sheet.id, "B2"), 20);
  assert.equal(evaluateCell(workbook, sheet.id, "B3"), 20);
});

test("cycle detection remains bounded", () => {
  const workbook = createWorkbook("cycle");
  const sheet = workbook.sheets[0];
  sheet.cells.A1 = { raw: "=B1" };
  sheet.cells.B1 = { raw: "=A1" };
  assert.equal(evaluateCell(workbook, sheet.id, "A1"), "#CYCLE!");
});

test("range normalization and enumeration are deterministic", () => {
  assert.deepEqual(normalizeRange("C3", "A2"), {
    start: "A2",
    end: "C3"
  });
  assert.deepEqual(rangeAddresses({ start: "A1", end: "B2" }), [
    "A1",
    "B1",
    "A2",
    "B2"
  ]);
});

test("clipboard matrix paste fills a rectangular region", () => {
  const workbook = createWorkbook("paste");
  const sheet = workbook.sheets[0];
  const matrix = parseClipboardMatrix("alpha\tbeta\n1\t2");
  applyMatrixToSheet(sheet, "B2", matrix);
  assert.equal(sheet.cells.B2.raw, "alpha");
  assert.equal(sheet.cells.C2.raw, "beta");
  assert.equal(sheet.cells.B3.raw, "1");
  assert.equal(sheet.cells.C3.raw, "2");
});

test("row sorting preserves row cell objects across selected columns", () => {
  const workbook = createWorkbook("sort");
  const sheet = workbook.sheets[0];
  sheet.cells.A1 = { raw: "b" };
  sheet.cells.B1 = { raw: "2" };
  sheet.cells.A2 = { raw: "a" };
  sheet.cells.B2 = { raw: "1" };

  sortRangeRows(sheet, { start: "A1", end: "B2" }, 0, "asc");

  assert.equal(sheet.cells.A1.raw, "a");
  assert.equal(sheet.cells.B1.raw, "1");
  assert.equal(sheet.cells.A2.raw, "b");
  assert.equal(sheet.cells.B2.raw, "2");
});

test("workbook normalization rejects malformed input and sanitizes cells", () => {
  assert.equal(normalizeWorkbook({}), null);
  const normalized = normalizeWorkbook({
    id: "book",
    title: "Safe",
    sheets: [
      {
        id: "sheet",
        name: "Sheet",
        cells: {
          A1: { raw: "ok", style: { fill: "#ffffff" } },
          bad: { raw: "ignored" }
        }
      }
    ],
    activeSheetId: "sheet"
  });
  assert.ok(normalized);
  assert.equal(normalized?.sheets[0].cells.A1.raw, "ok");
  assert.equal(normalized?.sheets[0].cells.bad, undefined);
});
