"use client";

import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  cellAddress,
  columnLabel,
  createWorkbook,
  csvToCells,
  evaluateCell,
  formatDisplay,
  parseAddress,
  worksheetToCsv,
  type CellStyle,
  type Workbook
} from "@tamishra/sheets-engine";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./sheets.module.css";

const STORAGE_KEY = "tamishra-sheets-workbook-v1";
const ROW_HEIGHT = 30;
const VISIBLE_ROWS = 42;

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
    A5: { raw: "Total" , style: { bold: true }},
    D5: { raw: "=SUM(D2:D3)", style: { bold: true, numberFormat: "currency" } }
  };
  return workbook;
}

function cloneWorkbook(workbook: Workbook): Workbook {
  return JSON.parse(JSON.stringify(workbook)) as Workbook;
}

export default function SheetsWorkspace() {
  const [workbook, setWorkbook] = useState<Workbook>(() => starterWorkbook());
  const [selected, setSelected] = useState("A1");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [formulaDraft, setFormulaDraft] = useState("");
  const [rowStart, setRowStart] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("Local");
  const [zoom, setZoom] = useState(100);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Workbook;
        if (parsed?.sheets?.length) setWorkbook(parsed);
      }
    } catch {
      // A malformed local snapshot should never block the editor.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    setSaveState("Saving…");
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workbook));
      setSaveState("Saved locally");
    }, 260);
    return () => window.clearTimeout(timer);
  }, [workbook, loaded]);

  const activeSheet = useMemo(
    () => workbook.sheets.find((sheet) => sheet.id === workbook.activeSheetId) ?? workbook.sheets[0],
    [workbook]
  );

  const selectedCell = activeSheet.cells[selected];
  const selectedValue = evaluateCell(workbook, activeSheet.id, selected);

  useEffect(() => {
    setFormulaDraft(selectedCell?.raw ?? "");
  }, [selected, selectedCell?.raw]);

  function commitMutation(mutator: (next: Workbook) => void) {
    setWorkbook((current) => {
      undoStack.current.push(JSON.stringify(current));
      if (undoStack.current.length > 80) undoStack.current.shift();
      redoStack.current = [];
      const next = cloneWorkbook(current);
      mutator(next);
      next.version = current.version + 1;
      next.updatedAt = new Date().toISOString();
      return next;
    });
  }

  function setRaw(address: string, raw: string) {
    commitMutation((next) => {
      const sheet = next.sheets.find((item) => item.id === next.activeSheetId)!;
      const existing = sheet.cells[address] ?? { raw: "" };
      if (raw === "" && !existing.style) delete sheet.cells[address];
      else sheet.cells[address] = { ...existing, raw };
    });
  }

  function patchStyle(patch: Partial<CellStyle>) {
    commitMutation((next) => {
      const sheet = next.sheets.find((item) => item.id === next.activeSheetId)!;
      const existing = sheet.cells[selected] ?? { raw: "" };
      sheet.cells[selected] = {
        ...existing,
        style: { ...existing.style, ...patch }
      };
    });
  }

  function toggleStyle(key: "bold" | "italic" | "underline") {
    const current = Boolean(selectedCell?.style?.[key]);
    patchStyle({ [key]: !current });
  }

  function beginEdit(address: string) {
    setSelected(address);
    setDraft(activeSheet.cells[address]?.raw ?? "");
    setEditing(address);
  }

  function commitEdit() {
    if (!editing) return;
    setRaw(editing, draft);
    setEditing(null);
  }

  function moveSelection(deltaRow: number, deltaCol: number) {
    const parsed = parseAddress(selected);
    if (!parsed) return;
    const row = Math.max(0, Math.min(DEFAULT_ROWS - 1, parsed.row + deltaRow));
    const col = Math.max(0, Math.min(DEFAULT_COLUMNS - 1, parsed.col + deltaCol));
    setSelected(cellAddress(row, col));
  }

  function handleGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (editing) return;
    if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(-1, 0); }
    if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(1, 0); }
    if (event.key === "ArrowLeft") { event.preventDefault(); moveSelection(0, -1); }
    if (event.key === "ArrowRight") { event.preventDefault(); moveSelection(0, 1); }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginEdit(selected);
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      setRaw(selected, "");
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
  }

  function undo() {
    const previous = undoStack.current.pop();
    if (!previous) return;
    setWorkbook((current) => {
      redoStack.current.push(JSON.stringify(current));
      return JSON.parse(previous) as Workbook;
    });
  }

  function redo() {
    const next = redoStack.current.pop();
    if (!next) return;
    setWorkbook((current) => {
      undoStack.current.push(JSON.stringify(current));
      return JSON.parse(next) as Workbook;
    });
  }

  function addSheet() {
    commitMutation((next) => {
      const id = "sheet-" + Date.now().toString(36);
      next.sheets.push({
        id,
        name: "Sheet " + (next.sheets.length + 1),
        cells: {}
      });
      next.activeSheetId = id;
    });
    setSelected("A1");
  }

  function renameSheet(sheetId: string) {
    const sheet = workbook.sheets.find((item) => item.id === sheetId);
    if (!sheet) return;
    const name = window.prompt("Rename sheet", sheet.name)?.trim();
    if (!name) return;
    commitMutation((next) => {
      const target = next.sheets.find((item) => item.id === sheetId);
      if (target) target.name = name.slice(0, 40);
    });
  }

  function removeActiveSheet() {
    if (workbook.sheets.length === 1) return;
    if (!window.confirm("Delete this sheet?")) return;
    commitMutation((next) => {
      const index = next.sheets.findIndex((item) => item.id === next.activeSheetId);
      next.sheets.splice(index, 1);
      next.activeSheetId = next.sheets[Math.max(0, index - 1)].id;
    });
    setSelected("A1");
  }

  function exportCsv() {
    const csv = worksheetToCsv(activeSheet);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = (workbook.title || "tamishra-sheet").replace(/[^a-z0-9-_]+/gi, "-") + ".csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function importCsv(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const csv = typeof reader.result === "string" ? reader.result : "";
      commitMutation((next) => {
        const sheet = next.sheets.find((item) => item.id === next.activeSheetId)!;
        sheet.cells = csvToCells(csv);
      });
      setSelected("A1");
    };
    reader.readAsText(file);
  }

  async function copyCell() {
    try {
      await navigator.clipboard.writeText(selectedCell?.raw ?? "");
    } catch {
      // Clipboard permission is browser-controlled.
    }
  }

  async function pasteCell() {
    try {
      const text = await navigator.clipboard.readText();
      setRaw(selected, text);
    } catch {
      // Clipboard permission is browser-controlled.
    }
  }

  function clearWorkbook() {
    if (!window.confirm("Clear all cells in this sheet?")) return;
    commitMutation((next) => {
      const sheet = next.sheets.find((item) => item.id === next.activeSheetId)!;
      sheet.cells = {};
    });
  }

  function updateTitle(title: string) {
    setWorkbook((current) => ({ ...current, title }));
  }

  const selectedStyle = selectedCell?.style ?? {};
  const rowEnd = Math.min(DEFAULT_ROWS, rowStart + VISIBLE_ROWS);
  const visibleRows = Array.from({ length: Math.max(0, rowEnd - rowStart) }, (_, index) => rowStart + index);
  const columns = Array.from({ length: DEFAULT_COLUMNS }, (_, index) => index);

  return (
    <main className={styles.app}>
      <header className={styles.topbar}>
        <a className={styles.logo} href="/" aria-label="Back to Tamishra Workspace">T</a>
        <div className={styles.identity}>
          <div className={styles.titleLine}>
            <input
              className={styles.titleInput}
              value={workbook.title}
              onChange={(event) => updateTitle(event.target.value)}
              aria-label="Workbook title"
            />
            <span className={styles.saveState}>{saveState}</span>
          </div>
          <div className={styles.menuRow}>
            <button onClick={() => fileInputRef.current?.click()}>File</button>
            <button onClick={undo}>Undo</button>
            <button onClick={redo}>Redo</button>
            <button onClick={copyCell}>Copy</button>
            <button onClick={pasteCell}>Paste</button>
            <button onClick={clearWorkbook}>Clear sheet</button>
          </div>
        </div>
        <div className={styles.topActions}>
          <button className={styles.iconButton} title="Comments">◌</button>
          <button className={styles.shareButton}>Share</button>
          <button className={styles.profile}>DK</button>
        </div>
      </header>

      <section className={styles.toolbar} aria-label="Spreadsheet toolbar">
        <div className={styles.toolGroup}>
          <button onClick={undo} title="Undo">↶</button>
          <button onClick={redo} title="Redo">↷</button>
          <button onClick={copyCell} title="Copy">⧉</button>
          <button onClick={pasteCell} title="Paste">▣</button>
        </div>
        <span className={styles.divider} />
        <div className={styles.toolGroup}>
          <button className={selectedStyle.bold ? styles.activeTool : ""} onClick={() => toggleStyle("bold")}><b>B</b></button>
          <button className={selectedStyle.italic ? styles.activeTool : ""} onClick={() => toggleStyle("italic")}><i>I</i></button>
          <button className={selectedStyle.underline ? styles.activeTool : ""} onClick={() => toggleStyle("underline")}><u>U</u></button>
        </div>
        <span className={styles.divider} />
        <div className={styles.toolGroup}>
          <button className={selectedStyle.align === "left" ? styles.activeTool : ""} onClick={() => patchStyle({ align: "left" })}>≡</button>
          <button className={selectedStyle.align === "center" ? styles.activeTool : ""} onClick={() => patchStyle({ align: "center" })}>≣</button>
          <button className={selectedStyle.align === "right" ? styles.activeTool : ""} onClick={() => patchStyle({ align: "right" })}>≡</button>
        </div>
        <span className={styles.divider} />
        <select
          className={styles.formatSelect}
          value={selectedStyle.numberFormat ?? "general"}
          onChange={(event) => patchStyle({ numberFormat: event.target.value as CellStyle["numberFormat"] })}
          aria-label="Number format"
        >
          <option value="general">General</option>
          <option value="number">Number</option>
          <option value="percent">Percent</option>
          <option value="currency">Currency ₹</option>
        </select>
        <label className={styles.colorControl} title="Text color">
          A
          <input type="color" value={selectedStyle.color ?? "#172033"} onChange={(event) => patchStyle({ color: event.target.value })} />
        </label>
        <label className={styles.colorControl} title="Cell fill">
          ▦
          <input type="color" value={selectedStyle.fill ?? "#ffffff"} onChange={(event) => patchStyle({ fill: event.target.value })} />
        </label>
        <span className={styles.divider} />
        <button className={styles.actionButton} onClick={() => fileInputRef.current?.click()}>Import CSV</button>
        <button className={styles.actionButton} onClick={exportCsv}>Export CSV</button>
        <div className={styles.toolbarSpacer} />
        <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className={styles.zoomSelect}>
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
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importCsv(file);
            event.target.value = "";
          }}
        />
      </section>

      <section className={styles.formulaBar}>
        <div className={styles.nameBox}>{selected}</div>
        <div className={styles.fx}>fx</div>
        <input
          value={formulaDraft}
          onChange={(event) => setFormulaDraft(event.target.value)}
          onBlur={() => {
            if (formulaDraft !== (selectedCell?.raw ?? "")) setRaw(selected, formulaDraft);
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
            const next = Math.max(0, Math.floor(Math.max(0, event.currentTarget.scrollTop - ROW_HEIGHT) / ROW_HEIGHT) - 5);
            if (next !== rowStart) setRowStart(Math.min(DEFAULT_ROWS - VISIBLE_ROWS, next));
          }}
        >
          <div
            className={styles.gridInner}
            style={{
              width: 54 + DEFAULT_COLUMNS * 112,
              transform: `scale(${zoom / 100})`,
              transformOrigin: "top left"
            }}
          >
            <div className={styles.columnHeader}>
              <div className={styles.cornerCell}>#</div>
              {columns.map((col) => (
                <div className={styles.columnCell} key={col}>{columnLabel(col)}</div>
              ))}
            </div>
            <div className={styles.rowsLayer} style={{ height: DEFAULT_ROWS * ROW_HEIGHT }}>
              {visibleRows.map((row) => (
                <div className={styles.gridRow} key={row} style={{ top: row * ROW_HEIGHT }}>
                  <div className={styles.rowNumber}>{row + 1}</div>
                  {columns.map((col) => {
                    const address = cellAddress(row, col);
                    const cell = activeSheet.cells[address];
                    const value = evaluateCell(workbook, activeSheet.id, address);
                    const isSelected = selected === address;
                    const cellStyle = cell?.style;
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
                          textDecoration: cellStyle?.underline ? "underline" : "none"
                        }}
                      >
                        {editing === address ? (
                          <input
                            className={styles.cellEditor}
                            autoFocus
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
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
                            className={isSelected ? styles.cellSelected : styles.cell}
                            onClick={() => setSelected(address)}
                            onDoubleClick={() => beginEdit(address)}
                            title={cell?.raw?.startsWith("=") ? cell.raw : undefined}
                          >
                            {formatDisplay(value, cellStyle)}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
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
              className={sheet.id === workbook.activeSheetId ? styles.activeTab : styles.sheetTab}
              onClick={() => {
                setWorkbook((current) => ({ ...current, activeSheetId: sheet.id }));
                setSelected("A1");
              }}
              onDoubleClick={() => renameSheet(sheet.id)}
              title="Double-click to rename"
            >
              {sheet.name}
            </button>
          ))}
          <button className={styles.deleteSheet} onClick={removeActiveSheet} disabled={workbook.sheets.length === 1}>×</button>
        </div>
        <div className={styles.status}>
          <span>{selected}: {formatDisplay(selectedValue, selectedStyle) || "Empty"}</span>
          <span>{Object.keys(activeSheet.cells).length} populated cells</span>
          <span>{zoom}%</span>
        </div>
      </footer>
    </main>
  );
}
