"use client";

import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  applyMatrixToSheet,
  cellAddress,
  cloneWorkbook,
  columnLabel,
  createTamishraSheetPackage,
  createWorkbook,
  csvToCells,
  evaluateCell,
  formatDisplay,
  normalizeRange,
  normalizeWorkbook,
  parseAddress,
  parseClipboardMatrix,
  parseTamishraSheet,
  parseWorkbookJson,
  rangeAddresses,
  rangeDimensions,
  rangeLabel,
  rangeToTsv,
  serializeTamishraSheet,
  serializeWorkbook,
  sortRangeRows,
  tamishraSheetFilename,
  TMSHEET_MIME_TYPE,
  worksheetToCsv,
  type CellRange,
  type CellStyle,
  type Workbook
} from "@tamishra/sheets-engine";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createBlock,
  liveBlocksForSource,
  refreshLiveBlock,
  upsertBlock
} from "@tamishra/blocks-core";
import { upsertWorkspaceFile } from "@tamishra/file-core";
import { consumeNativeFileHandoff } from "../../../lib/native-file-handoff";
import { mutateWorkspaceFileIndex } from "../../../lib/workspace-files";
import {
  loadWorkspaceBlockShelf,
  mutateWorkspaceBlockShelf,
  saveWorkspaceBlockShelf
} from "../../../lib/workspace-blocks";
import styles from "./sheets.module.css";

const STORAGE_KEY = "tamishra-sheets-workbook-v2";
const LEGACY_STORAGE_KEY = "tamishra-sheets-workbook-v1";
const BACKUP_KEY = "tamishra-sheets-workbook-backup-v2";
const ROW_HEIGHT = 30;
const COLUMN_WIDTH = 112;
const ROW_HEADER_WIDTH = 54;
const VISIBLE_ROWS = 42;
const MAX_LOCAL_AUTOSAVE_BYTES = 4_500_000;

type Selection = {
  anchor: string;
  focus: string;
};

function starterWorkbook(): Workbook {
  const workbook = createWorkbook("Project tracker");
  workbook.id = "tamishra-starter-workbook";
  workbook.updatedAt = "";
  workbook.sheets[0].cells = {
    A1: { raw: "Task", style: { bold: true, fill: "#e8f5ef" } },
    B1: { raw: "Owner", style: { bold: true, fill: "#e8f5ef" } },
    C1: { raw: "Progress", style: { bold: true, fill: "#e8f5ef" } },
    D1: { raw: "Budget", style: { bold: true, fill: "#e8f5ef" } },
    A2: { raw: "Research" },
    B2: { raw: "Deepak" },
    C2: { raw: "0.75", style: { numberFormat: "percent" } },
    D2: { raw: "25000", style: { numberFormat: "currency" } },
    A3: { raw: "Prototype" },
    B3: { raw: "Team" },
    C3: { raw: "0.45", style: { numberFormat: "percent" } },
    D3: { raw: "42000", style: { numberFormat: "currency" } },
    A5: { raw: "Total", style: { bold: true } },
    D5: {
      raw: "=SUM(D2:D3)",
      style: { bold: true, numberFormat: "currency" }
    }
  };
  return workbook;
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string) {
  return (value || "tamishra-sheet")
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "tamishra-sheet";
}

function rangeFromLocator(locator?: string) {
  if (!locator) return null;
  const [start, end = start] = locator.split(":");
  return normalizeRange(start, end);
}

function displayMatrixForRange(
  workbook: Workbook,
  sheetId: string,
  range: CellRange
) {
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  const start = parseAddress(range.start);
  const end = parseAddress(range.end);
  if (!sheet || !start || !end) return [];

  const matrix: string[][] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const values: string[] = [];
    for (let col = start.col; col <= end.col; col += 1) {
      const address = cellAddress(row, col);
      values.push(
        formatDisplay(
          evaluateCell(workbook, sheet.id, address),
          sheet.cells[address]?.style
        )
      );
    }
    matrix.push(values);
  }
  return matrix;
}

export default function SheetsWorkspace() {
  const [workbook, setWorkbook] = useState<Workbook>(() => starterWorkbook());
  const [selection, setSelection] = useState<Selection>({
    anchor: "A1",
    focus: "A1"
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [formulaDraft, setFormulaDraft] = useState("");
  const [rowStart, setRowStart] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("Local");
  const [zoom, setZoom] = useState(100);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const workbookRef = useRef(workbook);

  const selected = selection.focus;
  const selectedRange = useMemo<CellRange>(
    () =>
      normalizeRange(selection.anchor, selection.focus) ?? {
        start: selected,
        end: selected
      },
    [selection, selected]
  );

  useEffect(() => {
    workbookRef.current = workbook;
  }, [workbook]);

  useEffect(() => {
    try {
      const primary =
        window.localStorage.getItem(STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_STORAGE_KEY);
      const restored = primary ? parseWorkbookJson(primary) : null;
      if (restored) setWorkbook(restored);
      setRecoveryAvailable(Boolean(window.localStorage.getItem(BACKUP_KEY)));
    } catch {
      setSaveState("Recovery needed");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const createRequest = sessionStorage.getItem("tamishra.workspace.create");
    if (createRequest === "sheets") {
      sessionStorage.removeItem("tamishra.workspace.create");
      const blank = createWorkbook("Untitled spreadsheet");
      setWorkbook(blank);
      setSelection({ anchor: "A1", focus: "A1" });
      setSaveState("New spreadsheet");
      return;
    }

    void consumeNativeFileHandoff()
      .then((handoff) => {
        if (!handoff) return;
        const file = new File([handoff.bytes], handoff.name, {
          type: handoff.type || "application/octet-stream"
        });
        return importFile(file);
      })
      .catch((error) => {
        console.error("Workspace Sheets handoff failed", error);
        setSaveState("Workspace file could not be opened");
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let cancelled = false;

    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("startup_tmsh"))
      .then((raw) => {
        if (cancelled || !raw) return;
        const parsed = parseTamishraSheet(new TextEncoder().encode(raw));
        setWorkbook(parsed.workbook);
        setSelection({ anchor: "A1", focus: "A1" });
        setSaveState(".tmsh opened from desktop");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Could not open startup .tmsh", error);
        setSaveState("Startup .tmsh could not be opened");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;

    const timer = window.setTimeout(() => {
      const shelf = loadWorkspaceBlockShelf();
      const liveBlocks = liveBlocksForSource(shelf, {
        app: "sheets",
        resourceId: workbook.id
      });
      if (!liveBlocks.length) return;

      let next = shelf;
      for (const block of liveBlocks) {
        const source = block.binding?.source;
        if (!source?.subresourceId) continue;
        const range = rangeFromLocator(source.locator);
        if (!range) continue;
        const sheet = workbook.sheets.find(
          (item) => item.id === source.subresourceId
        );
        if (!sheet) continue;

        const dimensions = rangeDimensions(range);
        next = refreshLiveBlock(
          next,
          block.id,
          {
            tableData: displayMatrixForRange(workbook, sheet.id, range),
            sourceLabel: workbook.title + " · " + sheet.name + " · " + rangeLabel(range),
            rows: dimensions.rows,
            columns: dimensions.columns
          },
          workbook.version
        );
      }

      if (next !== shelf) saveWorkspaceBlockShelf(next);
    }, 360);

    return () => window.clearTimeout(timer);
  }, [workbook, loaded]);

  useEffect(() => {
    if (!loaded) return;
    setSaveState("Saving…");
    const timer = window.setTimeout(() => {
      try {
        const serialized = serializeWorkbook(workbook);
        if (serialized.length > MAX_LOCAL_AUTOSAVE_BYTES) {
          setSaveState("Export backup — workbook is large");
          return;
        }
        const previous = window.localStorage.getItem(STORAGE_KEY);
        if (previous && previous !== serialized) {
          window.localStorage.setItem(BACKUP_KEY, previous);
          setRecoveryAvailable(true);
        }
        window.localStorage.setItem(STORAGE_KEY, serialized);
        mutateWorkspaceFileIndex((index) =>
          upsertWorkspaceFile(index, {
            id: `sheets:${workbook.id}`,
            title: workbook.title || "Untitled spreadsheet",
            kind: "sheets",
            appHref: "/apps/sheets",
            nativeExtension: ".tmsh",
            nativeMime: TMSHEET_MIME_TYPE,
            sourceId: workbook.id,
            sizeBytes: new Blob([serialized]).size,
            storage: "local"
          })
        );
        setSaveState("Saved locally");
      } catch {
        setSaveState("Local save failed — export backup");
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [workbook, loaded]);

  useEffect(() => {
    function persistImmediately() {
      try {
        const serialized = serializeWorkbook(workbookRef.current);
        if (serialized.length <= MAX_LOCAL_AUTOSAVE_BYTES) {
          window.localStorage.setItem(STORAGE_KEY, serialized);
        }
      } catch {
        // Browser shutdown must not be blocked by persistence errors.
      }
    }
    window.addEventListener("pagehide", persistImmediately);
    return () => window.removeEventListener("pagehide", persistImmediately);
  }, []);

  const activeSheet = useMemo(
    () =>
      workbook.sheets.find((sheet) => sheet.id === workbook.activeSheetId) ??
      workbook.sheets[0],
    [workbook]
  );

  const selectedCell = activeSheet.cells[selected];
  const selectedValue = evaluateCell(workbook, activeSheet.id, selected);

  const selectionStats = useMemo(() => {
    const values = rangeAddresses(selectedRange)
      .map((address) => evaluateCell(workbook, activeSheet.id, address))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return {
      count: values.length,
      sum: values.reduce((sum, value) => sum + value, 0),
      average:
        values.length > 0
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : 0
    };
  }, [selectedRange, workbook, activeSheet.id]);

  useEffect(() => {
    setFormulaDraft(selectedCell?.raw ?? "");
  }, [selected, selectedCell?.raw]);

  function commitMutation(mutator: (next: Workbook) => void) {
    setWorkbook((current) => {
      undoStack.current.push(serializeWorkbook(current));
      if (undoStack.current.length > 80) undoStack.current.shift();
      redoStack.current = [];
      const next = cloneWorkbook(current);
      mutator(next);
      next.version = current.version + 1;
      next.updatedAt = new Date().toISOString();
      return next;
    });
  }

  function activeSheetIn(next: Workbook) {
    return next.sheets.find((item) => item.id === next.activeSheetId)!;
  }

  function selectCell(address: string, extend = false) {
    setSelection((current) => ({
      anchor: extend ? current.anchor : address,
      focus: address
    }));
  }

  function setRaw(address: string, raw: string) {
    commitMutation((next) => {
      const sheet = activeSheetIn(next);
      const existing = sheet.cells[address] ?? { raw: "" };
      const nextRaw = raw.slice(0, 100_000);
      if (nextRaw === "" && !existing.style) delete sheet.cells[address];
      else sheet.cells[address] = { ...existing, raw: nextRaw };
    });
  }

  function patchStyle(patch: Partial<CellStyle>) {
    const addresses = rangeAddresses(selectedRange);
    commitMutation((next) => {
      const sheet = activeSheetIn(next);
      for (const address of addresses) {
        const existing = sheet.cells[address] ?? { raw: "" };
        sheet.cells[address] = {
          ...existing,
          style: { ...existing.style, ...patch }
        };
      }
    });
  }

  function toggleStyle(key: "bold" | "italic" | "underline") {
    const current = Boolean(selectedCell?.style?.[key]);
    patchStyle({ [key]: !current });
  }

  function beginEdit(address: string) {
    selectCell(address);
    setDraft(activeSheet.cells[address]?.raw ?? "");
    setEditing(address);
  }

  function commitEdit() {
    if (!editing) return;
    setRaw(editing, draft);
    setEditing(null);
  }

  function moveSelection(
    deltaRow: number,
    deltaCol: number,
    extend = false
  ) {
    const parsed = parseAddress(selected);
    if (!parsed) return;
    const row = Math.max(
      0,
      Math.min(DEFAULT_ROWS - 1, parsed.row + deltaRow)
    );
    const col = Math.max(
      0,
      Math.min(DEFAULT_COLUMNS - 1, parsed.col + deltaCol)
    );
    selectCell(cellAddress(row, col), extend);
  }

  function handleGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (editing) return;
    const extend = event.shiftKey;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1, 0, extend);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1, 0, extend);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveSelection(0, -1, extend);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveSelection(0, 1, extend);
    }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginEdit(selected);
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      clearSelection();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copySelection();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void pasteSelection();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      findCell();
    }
  }

  function undo() {
    const previous = undoStack.current.pop();
    if (!previous) return;
    setWorkbook((current) => {
      redoStack.current.push(serializeWorkbook(current));
      return parseWorkbookJson(previous) ?? current;
    });
  }

  function redo() {
    const next = redoStack.current.pop();
    if (!next) return;
    setWorkbook((current) => {
      undoStack.current.push(serializeWorkbook(current));
      return parseWorkbookJson(next) ?? current;
    });
  }

  function addSheet() {
    commitMutation((next) => {
      const id = "sheet-" + Date.now().toString(36);
      next.sheets.push({
        id,
        name: "Sheet " + (next.sheets.length + 1),
        cells: {},
        frozenRows: 0,
        frozenColumns: 0
      });
      next.activeSheetId = id;
    });
    setSelection({ anchor: "A1", focus: "A1" });
  }

  function duplicateActiveSheet() {
    commitMutation((next) => {
      const source = activeSheetIn(next);
      const id = "sheet-" + Date.now().toString(36);
      const names = new Set(next.sheets.map((sheet) => sheet.name));
      let base = source.name + " copy";
      let name = base;
      let suffix = 2;
      while (names.has(name)) name = base + " " + suffix++;
      const copy = {
        ...JSON.parse(JSON.stringify(source)),
        id,
        name
      };
      next.sheets.push(copy);
      next.activeSheetId = id;
    });
    setSelection({ anchor: "A1", focus: "A1" });
  }

  function renameSheet(sheetId: string) {
    const sheet = workbook.sheets.find((item) => item.id === sheetId);
    if (!sheet) return;
    const name = window.prompt("Rename sheet", sheet.name)?.trim();
    if (!name) return;
    commitMutation((next) => {
      const target = next.sheets.find((item) => item.id === sheetId);
      if (target) target.name = name.slice(0, 80);
    });
  }

  function removeActiveSheet() {
    if (workbook.sheets.length === 1) return;
    if (!window.confirm("Delete this sheet? This can be undone.")) return;
    commitMutation((next) => {
      const index = next.sheets.findIndex(
        (item) => item.id === next.activeSheetId
      );
      next.sheets.splice(index, 1);
      next.activeSheetId = next.sheets[Math.max(0, index - 1)].id;
    });
    setSelection({ anchor: "A1", focus: "A1" });
  }

  function publishSelectionAsLiveBlock() {
    const dimensions = rangeDimensions(selectedRange);
    const block = createBlock({
      title: activeSheet.name + " · " + rangeLabel(selectedRange),
      kind: "table",
      sourceApp: "sheets",
      payload: {
        tableData: displayMatrixForRange(
          workbook,
          activeSheet.id,
          selectedRange
        ),
        sourceLabel:
          workbook.title +
          " · " +
          activeSheet.name +
          " · " +
          rangeLabel(selectedRange),
        rows: dimensions.rows,
        columns: dimensions.columns
      },
      tags: ["sheets", "live-table", activeSheet.name],
      binding: {
        mode: "live",
        source: {
          app: "sheets",
          resourceId: workbook.id,
          subresourceId: activeSheet.id,
          locator: rangeLabel(selectedRange),
          revision: workbook.version
        }
      }
    });

    mutateWorkspaceBlockShelf((current) => upsertBlock(current, block));
    setSaveState("Live Block published · " + block.title);
  }

  function exportCsv() {
    downloadText(
      safeFileName(workbook.title) + ".csv",
      worksheetToCsv(activeSheet),
      "text/csv;charset=utf-8"
    );
  }

  function exportNative() {
    const packageData = createTamishraSheetPackage(workbook);
    const bytes = serializeTamishraSheet(packageData);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: TMSHEET_MIME_TYPE });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = tamishraSheetFilename(workbook.title);
    anchor.click();
    URL.revokeObjectURL(url);
    setSaveState(".tmsh exported");
  }

  function exportBackup() {
    downloadText(
      safeFileName(workbook.title) + ".tamishra-sheet.json",
      JSON.stringify(workbook, null, 2),
      "application/json;charset=utf-8"
    );
  }

  async function importFile(file: File) {
    if (/\.tmsh$/i.test(file.name)) {
      try {
        const parsed = parseTamishraSheet(await file.arrayBuffer());
        commitMutation((next) => {
          Object.assign(next, parsed.workbook);
        });
        setSelection({ anchor: "A1", focus: "A1" });
        setSaveState(".tmsh opened");
      } catch (error) {
        window.alert(
          error instanceof Error ? error.message : "This .tmsh file is invalid."
        );
      }
      return;
    }

    const text = await file.text();
    if (/\.json$/i.test(file.name)) {
      const parsed = parseWorkbookJson(text);
      if (!parsed) {
        window.alert("This workbook backup is invalid or unsupported.");
        return;
      }
      commitMutation((next) => {
        Object.assign(next, parsed);
      });
      setSelection({ anchor: "A1", focus: "A1" });
      return;
    }

    commitMutation((next) => {
      const sheet = activeSheetIn(next);
      sheet.cells = csvToCells(text);
    });
    setSelection({ anchor: "A1", focus: "A1" });
  }

  async function copySelection() {
    try {
      await navigator.clipboard.writeText(
        rangeToTsv(activeSheet, selectedRange)
      );
    } catch {
      setSaveState("Clipboard permission denied");
    }
  }

  async function pasteSelection() {
    try {
      const text = await navigator.clipboard.readText();
      const matrix = parseClipboardMatrix(text);
      const start = normalizeRange(selectedRange.start, selectedRange.end)?.start ?? selected;
      commitMutation((next) => {
        applyMatrixToSheet(activeSheetIn(next), start, matrix);
      });
      const parsedStart = parseAddress(start);
      if (parsedStart) {
        const rows = matrix.length;
        const columns = Math.max(1, ...matrix.map((row) => row.length));
        const end = cellAddress(
          Math.min(DEFAULT_ROWS - 1, parsedStart.row + rows - 1),
          Math.min(DEFAULT_COLUMNS - 1, parsedStart.col + columns - 1)
        );
        setSelection({ anchor: start, focus: end });
      }
    } catch {
      setSaveState("Clipboard permission denied");
    }
  }

  function clearSelection() {
    const addresses = rangeAddresses(selectedRange);
    commitMutation((next) => {
      const sheet = activeSheetIn(next);
      for (const address of addresses) {
        const existing = sheet.cells[address];
        if (!existing) continue;
        if (existing.style) sheet.cells[address] = { ...existing, raw: "" };
        else delete sheet.cells[address];
      }
    });
  }

  function clearSheet() {
    if (!window.confirm("Clear all cells in this sheet? This can be undone.")) {
      return;
    }
    commitMutation((next) => {
      activeSheetIn(next).cells = {};
    });
  }

  function toggleFreezeRows() {
    commitMutation((next) => {
      const sheet = activeSheetIn(next);
      sheet.frozenRows = sheet.frozenRows ? 0 : 1;
    });
  }

  function toggleFreezeColumns() {
    commitMutation((next) => {
      const sheet = activeSheetIn(next);
      sheet.frozenColumns = sheet.frozenColumns ? 0 : 1;
    });
  }

  function sortSelection(direction: "asc" | "desc") {
    const dimensions = rangeDimensions(selectedRange);
    if (dimensions.rows < 2) {
      setSaveState("Select at least two rows to sort");
      return;
    }
    const focus = parseAddress(selected);
    if (!focus) return;
    commitMutation((next) => {
      sortRangeRows(
        activeSheetIn(next),
        selectedRange,
        focus.col,
        direction
      );
    });
  }

  function findCell() {
    const query = window.prompt("Find in this sheet")?.trim().toLocaleLowerCase();
    if (!query) return;
    const entries = Object.entries(activeSheet.cells);
    const currentIndex = entries.findIndex(([address]) => address === selected);
    const ordered = [
      ...entries.slice(currentIndex + 1),
      ...entries.slice(0, currentIndex + 1)
    ];
    const match = ordered.find(([, cell]) =>
      cell.raw.toLocaleLowerCase().includes(query)
    );
    if (!match) {
      setSaveState("No match found");
      return;
    }
    selectCell(match[0]);
  }

  function restoreBackup() {
    const raw = window.localStorage.getItem(BACKUP_KEY);
    const recovered = raw ? parseWorkbookJson(raw) : null;
    if (!recovered) {
      setRecoveryAvailable(false);
      setSaveState("No valid recovery copy");
      return;
    }
    if (!window.confirm("Restore the previous autosaved workbook?")) return;
    undoStack.current.push(serializeWorkbook(workbook));
    setWorkbook(recovered);
    setSelection({ anchor: "A1", focus: "A1" });
    setSaveState("Recovery restored");
  }

  function updateTitle(title: string) {
    setWorkbook((current) => ({ ...current, title: title.slice(0, 160) }));
  }

  const selectedStyle = selectedCell?.style ?? {};
  const rowEnd = Math.min(DEFAULT_ROWS, rowStart + VISIBLE_ROWS);
  const standardRows = Array.from(
    { length: Math.max(0, rowEnd - rowStart) },
    (_, index) => rowStart + index
  );
  const frozenRows = Array.from(
    { length: activeSheet.frozenRows ?? 0 },
    (_, index) => index
  );
  const visibleRows = Array.from(new Set([...frozenRows, ...standardRows]));
  const columns = Array.from({ length: DEFAULT_COLUMNS }, (_, index) => index);
  const selectedAddresses = useMemo(
    () => new Set(rangeAddresses(selectedRange)),
    [selectedRange]
  );

  return (
    <main className={styles.app}>
      <header className={styles.topbar}>
        <a
          className={styles.logo}
          href="/"
          aria-label="Back to Tamishra Workspace"
        >
          T
        </a>
        <div className={styles.identity}>
          <div className={styles.titleLine}>
            <input
              className={styles.titleInput}
              value={workbook.title}
              onChange={(event) => updateTitle(event.target.value)}
              aria-label="Workbook title"
            />
            <span
              className={
                saveState.includes("failed") || saveState.includes("Recovery")
                  ? styles.saveStateWarning
                  : styles.saveState
              }
            >
              {saveState}
            </span>
          </div>
          <div className={styles.menuRow}>
            <button onClick={() => fileInputRef.current?.click()}>Import</button>
            <button onClick={exportNative}>Save .tmsh</button>
            <button onClick={exportBackup}>Backup</button>
            <button onClick={restoreBackup} disabled={!recoveryAvailable}>
              Recover
            </button>
            <button onClick={undo}>Undo</button>
            <button onClick={redo}>Redo</button>
            <button onClick={() => void copySelection()}>Copy</button>
            <button onClick={() => void pasteSelection()}>Paste</button>
            <button onClick={findCell}>Find</button>
            <button onClick={publishSelectionAsLiveBlock}>Publish Live Block</button>
            <button onClick={() => { window.location.href = "/apps/blocks"; }}>Blocks</button>
            <button onClick={clearSheet}>Clear sheet</button>
          </div>
        </div>
        <div className={styles.topActions}>
          <button
            className={styles.iconButton}
            title="Export native .tmsh workbook"
            onClick={exportNative}
          >
            ↓
          </button>
          <button className={styles.shareButton}>Share</button>
          <button className={styles.profile}>DK</button>
        </div>
      </header>

      <section className={styles.toolbar} aria-label="Spreadsheet toolbar">
        <div className={styles.toolGroup}>
          <button onClick={undo} title="Undo">↶</button>
          <button onClick={redo} title="Redo">↷</button>
          <button onClick={() => void copySelection()} title="Copy range">⧉</button>
          <button onClick={() => void pasteSelection()} title="Paste range">▣</button>
        </div>
        <span className={styles.divider} />
        <div className={styles.toolGroup}>
          <button
            className={selectedStyle.bold ? styles.activeTool : ""}
            onClick={() => toggleStyle("bold")}
          >
            <b>B</b>
          </button>
          <button
            className={selectedStyle.italic ? styles.activeTool : ""}
            onClick={() => toggleStyle("italic")}
          >
            <i>I</i>
          </button>
          <button
            className={selectedStyle.underline ? styles.activeTool : ""}
            onClick={() => toggleStyle("underline")}
          >
            <u>U</u>
          </button>
        </div>
        <span className={styles.divider} />
        <div className={styles.toolGroup}>
          <button
            className={selectedStyle.align === "left" ? styles.activeTool : ""}
            onClick={() => patchStyle({ align: "left" })}
            title="Align left"
          >
            ≡
          </button>
          <button
            className={selectedStyle.align === "center" ? styles.activeTool : ""}
            onClick={() => patchStyle({ align: "center" })}
            title="Align center"
          >
            ≣
          </button>
          <button
            className={selectedStyle.align === "right" ? styles.activeTool : ""}
            onClick={() => patchStyle({ align: "right" })}
            title="Align right"
          >
            ≡
          </button>
        </div>
        <span className={styles.divider} />
        <select
          className={styles.formatSelect}
          value={selectedStyle.numberFormat ?? "general"}
          onChange={(event) =>
            patchStyle({
              numberFormat: event.target.value as CellStyle["numberFormat"]
            })
          }
          aria-label="Number format"
        >
          <option value="general">General</option>
          <option value="number">Number</option>
          <option value="percent">Percent</option>
          <option value="currency">Currency ₹</option>
        </select>
        <label className={styles.colorControl} title="Text color">
          A
          <input
            type="color"
            value={selectedStyle.color ?? "#172033"}
            onChange={(event) => patchStyle({ color: event.target.value })}
          />
        </label>
        <label className={styles.colorControl} title="Cell fill">
          ▦
          <input
            type="color"
            value={selectedStyle.fill ?? "#ffffff"}
            onChange={(event) => patchStyle({ fill: event.target.value })}
          />
        </label>
        <span className={styles.divider} />
        <button
          className={activeSheet.frozenRows ? styles.activeTool : ""}
          onClick={toggleFreezeRows}
          title="Freeze top row"
        >
          Freeze row
        </button>
        <button
          className={activeSheet.frozenColumns ? styles.activeTool : ""}
          onClick={toggleFreezeColumns}
          title="Freeze first column"
        >
          Freeze col
        </button>
        <button onClick={() => sortSelection("asc")} title="Sort selected rows ascending">
          Sort ↑
        </button>
        <button onClick={() => sortSelection("desc")} title="Sort selected rows descending">
          Sort ↓
        </button>
        <span className={styles.divider} />
        <button
          className={styles.actionButton}
          onClick={() => fileInputRef.current?.click()}
        >
          Import
        </button>
        <button className={styles.actionButton} onClick={exportNative}>
          Export .tmsh
        </button>
        <button className={styles.actionButton} onClick={exportCsv}>
          Export CSV
        </button>
        <button className={styles.actionButton} onClick={exportBackup}>
          Backup JSON
        </button>
        <button
          className={styles.actionButton}
          onClick={publishSelectionAsLiveBlock}
          title="Publish selected cells as a linked Tamishra Block"
        >
          Live Block
        </button>
        <div className={styles.toolbarSpacer} />
        <select
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
          className={styles.zoomSelect}
        >
          <option value={80}>80%</option>
          <option value={90}>90%</option>
          <option value={100}>100%</option>
          <option value={110}>110%</option>
          <option value={125}>125%</option>
        </select>
        <input
          ref={fileInputRef}
          className={styles.hiddenInput}
          type="file"
          accept=".tmsh,application/vnd.tamishra.spreadsheet,.csv,text/csv,.json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = "";
          }}
        />
      </section>

      <section className={styles.formulaBar}>
        <div className={styles.nameBox}>{rangeLabel(selectedRange)}</div>
        <div className={styles.fx}>fx</div>
        <input
          value={formulaDraft}
          onChange={(event) => setFormulaDraft(event.target.value)}
          onBlur={() => {
            if (formulaDraft !== (selectedCell?.raw ?? "")) {
              setRaw(selected, formulaDraft);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
              moveSelection(1, 0);
            }
          }}
          aria-label="Formula bar"
          placeholder="Enter a value or formula, e.g. =SUM(A1:A5)"
        />
      </section>

      <section className={styles.sheetArea}>
        <div
          className={styles.gridScroller}
          tabIndex={0}
          onKeyDown={handleGridKeyDown}
          onScroll={(event) => {
            const next = Math.max(
              0,
              Math.floor(
                Math.max(0, event.currentTarget.scrollTop - ROW_HEIGHT) /
                  ROW_HEIGHT
              ) - 5
            );
            if (next !== rowStart) {
              setRowStart(
                Math.min(DEFAULT_ROWS - VISIBLE_ROWS, next)
              );
            }
          }}
        >
          <div
            className={styles.gridInner}
            style={{
              width: ROW_HEADER_WIDTH + DEFAULT_COLUMNS * COLUMN_WIDTH,
              transform: `scale(${zoom / 100})`,
              transformOrigin: "top left"
            }}
          >
            <div className={styles.columnHeader}>
              <div className={styles.cornerCell}>#</div>
              {columns.map((col) => (
                <div className={styles.columnCell} key={col}>
                  {columnLabel(col)}
                </div>
              ))}
            </div>

            <div
              className={styles.rowsLayer}
              style={{ height: DEFAULT_ROWS * ROW_HEIGHT }}
            >
              {visibleRows.map((row) => {
                const isFrozenRow = row < (activeSheet.frozenRows ?? 0);
                return (
                  <div
                    className={styles.gridRow}
                    key={row}
                    style={
                      isFrozenRow
                        ? {
                            top: ROW_HEIGHT,
                            position: "sticky",
                            zIndex: 14
                          }
                        : { top: row * ROW_HEIGHT }
                    }
                  >
                    <div className={styles.rowNumber}>{row + 1}</div>
                    {columns.map((col) => {
                      const address = cellAddress(row, col);
                      const cell = activeSheet.cells[address];
                      const value = evaluateCell(
                        workbook,
                        activeSheet.id,
                        address
                      );
                      const isFocus = selected === address;
                      const isInRange = selectedAddresses.has(address);
                      const cellStyle = cell?.style;
                      const isFrozenColumn =
                        col < (activeSheet.frozenColumns ?? 0);

                      return (
                        <div
                          key={address}
                          className={styles.cellWrap}
                          style={{
                            background: cellStyle?.fill || undefined,
                            color: cellStyle?.color || undefined,
                            textAlign: cellStyle?.align || "left",
                            fontWeight: cellStyle?.bold ? 700 : 400,
                            fontStyle: cellStyle?.italic ? "italic" : "normal",
                            textDecoration: cellStyle?.underline
                              ? "underline"
                              : "none",
                            ...(isFrozenColumn
                              ? {
                                  position: "sticky",
                                  left:
                                    ROW_HEADER_WIDTH +
                                    col * COLUMN_WIDTH,
                                  zIndex: isFrozenRow ? 16 : 9,
                                  boxShadow:
                                    "1px 0 0 #cfd7df"
                                }
                              : {})
                          }}
                        >
                          {editing === address ? (
                            <input
                              className={styles.cellEditor}
                              autoFocus
                              value={draft}
                              onChange={(event) =>
                                setDraft(event.target.value)
                              }
                              onBlur={commitEdit}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitEdit();
                                  moveSelection(1, 0);
                                }
                                if (event.key === "Escape") {
                                  setEditing(null);
                                }
                              }}
                            />
                          ) : (
                            <button
                              className={
                                isFocus
                                  ? styles.cellSelected
                                  : isInRange
                                    ? styles.cellRange
                                    : styles.cell
                              }
                              onClick={(event) =>
                                selectCell(address, event.shiftKey)
                              }
                              onDoubleClick={() => beginEdit(address)}
                              title={
                                cell?.raw?.startsWith("=")
                                  ? cell.raw
                                  : undefined
                              }
                            >
                              {formatDisplay(value, cellStyle)}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.sheetTabs}>
          <button className={styles.addSheet} onClick={addSheet}>+</button>
          {workbook.sheets.map((sheet) => (
            <button
              key={sheet.id}
              className={
                sheet.id === workbook.activeSheetId
                  ? styles.activeTab
                  : styles.sheetTab
              }
              onClick={() => {
                setWorkbook((current) => ({
                  ...current,
                  activeSheetId: sheet.id
                }));
                setSelection({ anchor: "A1", focus: "A1" });
              }}
              onDoubleClick={() => renameSheet(sheet.id)}
              title="Double-click to rename"
            >
              {sheet.name}
            </button>
          ))}
          <button
            className={styles.duplicateSheet}
            onClick={duplicateActiveSheet}
            title="Duplicate current sheet"
          >
            ⧉
          </button>
          <button
            className={styles.deleteSheet}
            onClick={removeActiveSheet}
            disabled={workbook.sheets.length === 1}
            title="Delete current sheet"
          >
            ×
          </button>
        </div>
        <div className={styles.status}>
          <span>{rangeLabel(selectedRange)}</span>
          <span>
            {selectionStats.count
              ? `Sum ${selectionStats.sum.toLocaleString()} · Avg ${selectionStats.average.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
              : formatDisplay(selectedValue, selectedStyle) || "Empty"}
          </span>
          <span>{Object.keys(activeSheet.cells).length} populated</span>
          <span>{zoom}%</span>
        </div>
      </footer>
    </main>
  );
}
