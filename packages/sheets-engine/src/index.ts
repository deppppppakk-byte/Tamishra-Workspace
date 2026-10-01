export type CellStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  fill?: string;
  color?: string;
  numberFormat?: "general" | "number" | "percent" | "currency";
};

export type SheetCell = {
  raw: string;
  style?: CellStyle;
};

export type Worksheet = {
  id: string;
  name: string;
  cells: Record<string, SheetCell>;
  frozenRows?: number;
  frozenColumns?: number;
};

export type NamedRange = {
  name: string;
  sheetId: string;
  start: string;
  end: string;
};

export type Workbook = {
  formatVersion: number;
  id: string;
  title: string;
  version: number;
  activeSheetId: string;
  sheets: Worksheet[];
  namedRanges: NamedRange[];
  updatedAt: string;
};

export type FormulaValue = string | number | boolean | null;

export type CellRange = {
  start: string;
  end: string;
};

export type SortDirection = "asc" | "desc";

export const WORKBOOK_FORMAT_VERSION = 2;
export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLUMNS = 52;
export const MAX_SHEETS = 100;
export const MAX_CELLS_PER_SHEET = 100_000;
export const MAX_CELL_RAW_LENGTH = 100_000;

export function columnLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function columnIndex(label: string): number {
  let value = 0;
  for (const char of label.toUpperCase()) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return Math.max(0, value - 1);
}

export function parseAddress(address: string) {
  const match = /^([A-Z]+)([1-9]\d*)$/i.exec(address.trim());
  if (!match) return null;
  return {
    col: columnIndex(match[1]),
    row: Number(match[2]) - 1,
    colLabel: match[1].toUpperCase(),
    address: match[1].toUpperCase() + match[2]
  };
}

export function cellAddress(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`;
}

export function createWorkbook(title = "Untitled spreadsheet"): Workbook {
  const firstSheetId = "sheet-1";
  return {
    formatVersion: WORKBOOK_FORMAT_VERSION,
    id: "workbook-" + Date.now().toString(36),
    title,
    version: 1,
    activeSheetId: firstSheetId,
    namedRanges: [],
    updatedAt: new Date().toISOString(),
    sheets: [
      {
        id: firstSheetId,
        name: "Sheet 1",
        cells: {}
      }
    ]
  };
}

export function cloneWorkbook(workbook: Workbook): Workbook {
  return JSON.parse(JSON.stringify(workbook)) as Workbook;
}

export function normalizeRange(a: string, b: string): CellRange | null {
  const first = parseAddress(a);
  const second = parseAddress(b);
  if (!first || !second) return null;
  const minRow = Math.min(first.row, second.row);
  const maxRow = Math.max(first.row, second.row);
  const minCol = Math.min(first.col, second.col);
  const maxCol = Math.max(first.col, second.col);
  return {
    start: cellAddress(minRow, minCol),
    end: cellAddress(maxRow, maxCol)
  };
}

export function rangeDimensions(range: CellRange) {
  const start = parseAddress(range.start);
  const end = parseAddress(range.end);
  if (!start || !end) return { rows: 0, columns: 0 };
  return {
    rows: Math.abs(end.row - start.row) + 1,
    columns: Math.abs(end.col - start.col) + 1
  };
}

export function rangeAddresses(range: CellRange): string[] {
  const normalized = normalizeRange(range.start, range.end);
  if (!normalized) return [];
  const start = parseAddress(normalized.start)!;
  const end = parseAddress(normalized.end)!;
  const addresses: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    for (let col = start.col; col <= end.col; col += 1) {
      addresses.push(cellAddress(row, col));
    }
  }
  return addresses;
}

export function rangeLabel(range: CellRange) {
  const normalized = normalizeRange(range.start, range.end);
  if (!normalized) return "";
  return normalized.start === normalized.end
    ? normalized.start
    : `${normalized.start}:${normalized.end}`;
}

function numeric(value: FormulaValue | FormulaValue[]): number {
  if (Array.isArray(value)) return numeric(value[0] ?? 0);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function flatten(values: Array<FormulaValue | FormulaValue[]>): FormulaValue[] {
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

function tokenize(input: string): string[] {
  const normalized = input.replace(/\s+/g, "");
  const tokens =
    normalized.match(
      /(?:\d+\.\d+|\d+|[A-Za-z_][A-Za-z0-9_]*|>=|<=|<>|=|>|<|[+\-*/^(),:])/g
    ) ?? [];
  if (tokens.join("") !== normalized) {
    throw new Error("Unsupported formula syntax");
  }
  return tokens;
}

class FormulaParser {
  private index = 0;

  constructor(
    private readonly tokens: string[],
    private readonly sheet: Worksheet,
    private readonly workbook: Workbook,
    private readonly stack: Set<string>
  ) {}

  parse(): FormulaValue | FormulaValue[] {
    const value = this.parseComparison();
    if (this.index < this.tokens.length) {
      throw new Error("Unexpected token " + this.tokens[this.index]);
    }
    return value;
  }

  private peek() {
    return this.tokens[this.index];
  }

  private take() {
    return this.tokens[this.index++];
  }

  private parseComparison(): FormulaValue | FormulaValue[] {
    let left = this.parseExpression();
    while ([">", "<", ">=", "<=", "=", "<>"].includes(this.peek())) {
      const op = this.take();
      const right = this.parseExpression();
      const a = Array.isArray(left) ? left[0] : left;
      const b = Array.isArray(right) ? right[0] : right;
      if (op === ">") left = numeric(a ?? null) > numeric(b ?? null);
      if (op === "<") left = numeric(a ?? null) < numeric(b ?? null);
      if (op === ">=") left = numeric(a ?? null) >= numeric(b ?? null);
      if (op === "<=") left = numeric(a ?? null) <= numeric(b ?? null);
      if (op === "=") left = String(a ?? "") === String(b ?? "");
      if (op === "<>") left = String(a ?? "") !== String(b ?? "");
    }
    return left;
  }

  private parseExpression(): FormulaValue | FormulaValue[] {
    let left = this.parseTerm();
    while (this.peek() === "+" || this.peek() === "-") {
      const op = this.take();
      const right = this.parseTerm();
      left =
        op === "+"
          ? numeric(left) + numeric(right)
          : numeric(left) - numeric(right);
    }
    return left;
  }

  private parseTerm(): FormulaValue | FormulaValue[] {
    let left = this.parsePower();
    while (this.peek() === "*" || this.peek() === "/") {
      const op = this.take();
      const right = this.parsePower();
      if (op === "*") left = numeric(left) * numeric(right);
      else {
        const denominator = numeric(right);
        if (denominator === 0) throw new Error("#DIV/0!");
        left = numeric(left) / denominator;
      }
    }
    return left;
  }

  private parsePower(): FormulaValue | FormulaValue[] {
    let left = this.parseUnary();
    while (this.peek() === "^") {
      this.take();
      const right = this.parseUnary();
      left = Math.pow(numeric(left), numeric(right));
    }
    return left;
  }

  private parseUnary(): FormulaValue | FormulaValue[] {
    if (this.peek() === "-") {
      this.take();
      return -numeric(this.parseUnary());
    }
    if (this.peek() === "+") {
      this.take();
      return numeric(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaValue | FormulaValue[] {
    const token = this.take();
    if (token == null) return 0;

    if (token === "(") {
      const value = this.parseComparison();
      if (this.take() !== ")") throw new Error("Missing closing parenthesis");
      return value;
    }

    if (/^\d/.test(token)) return Number(token);

    if (/^[A-Za-z_]/.test(token)) {
      const identifier = token.toUpperCase();

      if (this.peek() === "(") {
        this.take();
        const args: Array<FormulaValue | FormulaValue[]> = [];
        if (this.peek() !== ")") {
          while (true) {
            args.push(this.parseComparison());
            if (this.peek() !== ",") break;
            this.take();
          }
        }
        if (this.take() !== ")") throw new Error("Missing closing parenthesis");
        return this.callFunction(identifier, args);
      }

      if (/^[A-Z]+[1-9]\d*$/.test(identifier)) {
        if (this.peek() === ":") {
          this.take();
          const end = this.take();
          if (!end || !/^[A-Za-z]+[1-9]\d*$/.test(end)) {
            throw new Error("Invalid range");
          }
          return this.range(identifier, end.toUpperCase());
        }
        return evaluateCell(
          this.workbook,
          this.sheet.id,
          identifier,
          this.stack
        );
      }

      const named = this.workbook.namedRanges.find(
        (range) => range.name.toUpperCase() === identifier
      );
      if (named) {
        const targetSheet = this.workbook.sheets.find(
          (sheet) => sheet.id === named.sheetId
        );
        if (!targetSheet) return [];
        return this.range(named.start, named.end, targetSheet);
      }

      if (identifier === "TRUE") return true;
      if (identifier === "FALSE") return false;
      throw new Error("Unknown name " + token);
    }

    throw new Error("Unexpected token " + token);
  }

  private range(
    start: string,
    end: string,
    sourceSheet = this.sheet
  ): FormulaValue[] {
    const a = parseAddress(start);
    const b = parseAddress(end);
    if (!a || !b) return [];
    const values: FormulaValue[] = [];
    for (
      let row = Math.min(a.row, b.row);
      row <= Math.max(a.row, b.row);
      row += 1
    ) {
      for (
        let col = Math.min(a.col, b.col);
        col <= Math.max(a.col, b.col);
        col += 1
      ) {
        values.push(
          evaluateCell(
            this.workbook,
            sourceSheet.id,
            cellAddress(row, col),
            this.stack
          )
        );
      }
    }
    return values;
  }

  private callFunction(
    name: string,
    args: Array<FormulaValue | FormulaValue[]>
  ): FormulaValue {
    const values = flatten(args);
    const nums = values.map(numeric);
    switch (name) {
      case "SUM":
        return nums.reduce((sum, value) => sum + value, 0);
      case "AVERAGE":
      case "AVG":
        return nums.length
          ? nums.reduce((sum, value) => sum + value, 0) / nums.length
          : 0;
      case "MIN":
        return nums.length ? Math.min(...nums) : 0;
      case "MAX":
        return nums.length ? Math.max(...nums) : 0;
      case "COUNT":
        return values.filter(
          (value) =>
            value !== "" &&
            value != null &&
            Number.isFinite(Number(value))
        ).length;
      case "COUNTA":
        return values.filter((value) => value !== "" && value != null).length;
      case "PRODUCT":
        return nums.reduce((product, value) => product * value, 1);
      case "MEDIAN": {
        if (!nums.length) return 0;
        const ordered = [...nums].sort((a, b) => a - b);
        const middle = Math.floor(ordered.length / 2);
        return ordered.length % 2
          ? ordered[middle]
          : (ordered[middle - 1] + ordered[middle]) / 2;
      }
      case "ABS":
        return Math.abs(numeric(args[0] ?? 0));
      case "SQRT":
        return Math.sqrt(numeric(args[0] ?? 0));
      case "POWER":
        return Math.pow(
          numeric(args[0] ?? 0),
          numeric(args[1] ?? 0)
        );
      case "MOD": {
        const divisor = numeric(args[1] ?? 0);
        if (divisor === 0) throw new Error("#DIV/0!");
        return numeric(args[0] ?? 0) % divisor;
      }
      case "ROUND": {
        const value = numeric(args[0] ?? 0);
        const places = Math.max(0, Math.floor(numeric(args[1] ?? 0)));
        const factor = 10 ** places;
        return Math.round(value * factor) / factor;
      }
      case "AND":
        return values.every(Boolean);
      case "OR":
        return values.some(Boolean);
      case "NOT":
        return !Boolean(values[0]);
      case "IF":
        return Boolean(Array.isArray(args[0]) ? args[0][0] : args[0])
          ? ((Array.isArray(args[1]) ? args[1][0] : args[1]) ?? true)
          : ((Array.isArray(args[2]) ? args[2][0] : args[2]) ?? false);
      case "TODAY":
        return new Date().toISOString().slice(0, 10);
      default:
        throw new Error("Unknown function " + name);
    }
  }
}

export function evaluateCell(
  workbook: Workbook,
  sheetId: string,
  address: string,
  inheritedStack = new Set<string>()
): FormulaValue {
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  if (!sheet) return null;
  const key = address.toUpperCase();
  const cell = sheet.cells[key];
  if (!cell || cell.raw === "") return null;

  if (!cell.raw.startsWith("=")) {
    const asNumber = Number(cell.raw);
    return cell.raw.trim() !== "" && Number.isFinite(asNumber)
      ? asNumber
      : cell.raw;
  }

  const stackKey = sheetId + ":" + key;
  if (inheritedStack.has(stackKey)) return "#CYCLE!";
  const stack = new Set(inheritedStack);
  stack.add(stackKey);

  try {
    const parser = new FormulaParser(
      tokenize(cell.raw.slice(1)),
      sheet,
      workbook,
      stack
    );
    const value = parser.parse();
    return Array.isArray(value) ? value[0] ?? null : value;
  } catch (error) {
    const message = error instanceof Error ? error.message : "#ERROR!";
    return message.startsWith("#") ? message : "#ERROR!";
  }
}

export function formatDisplay(
  value: FormulaValue,
  style?: CellStyle
): string {
  if (value == null) return "";
  if (typeof value !== "number") return String(value);
  if (style?.numberFormat === "percent") {
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      maximumFractionDigits: 2
    }).format(value);
  }
  if (style?.numberFormat === "currency") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2
    }).format(value);
  }
  if (style?.numberFormat === "number") {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 6
    }).format(value);
  }
  return String(value);
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function worksheetToCsv(sheet: Worksheet): string {
  let maxRow = 0;
  let maxCol = 0;
  for (const key of Object.keys(sheet.cells)) {
    const parsed = parseAddress(key);
    if (!parsed) continue;
    maxRow = Math.max(maxRow, parsed.row);
    maxCol = Math.max(maxCol, parsed.col);
  }
  const rows: string[] = [];
  for (let row = 0; row <= maxRow; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col <= maxCol; col += 1) {
      cells.push(escapeCsv(sheet.cells[cellAddress(row, col)]?.raw ?? ""));
    }
    rows.push(cells.join(","));
  }
  return rows.join("\n");
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.length > 1 || row[0] !== "" || rows.length === 0) rows.push(row);
  return rows;
}

export function parseClipboardMatrix(text: string): string[][] {
  return parseDelimited(text, text.includes("\t") ? "\t" : ",");
}

export function csvToCells(csv: string): Record<string, SheetCell> {
  const cells: Record<string, SheetCell> = {};
  const rows = parseDelimited(csv, ",");

  rows.forEach((values, rowIndex) => {
    values.forEach((value, colIndex) => {
      if (value !== "") {
        cells[cellAddress(rowIndex, colIndex)] = {
          raw: value.slice(0, MAX_CELL_RAW_LENGTH)
        };
      }
    });
  });
  return cells;
}

export function rangeToTsv(sheet: Worksheet, range: CellRange): string {
  const normalized = normalizeRange(range.start, range.end);
  if (!normalized) return "";
  const start = parseAddress(normalized.start)!;
  const end = parseAddress(normalized.end)!;
  const lines: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const values: string[] = [];
    for (let col = start.col; col <= end.col; col += 1) {
      values.push(sheet.cells[cellAddress(row, col)]?.raw ?? "");
    }
    lines.push(values.join("\t"));
  }
  return lines.join("\n");
}

export function applyMatrixToSheet(
  sheet: Worksheet,
  startAddress: string,
  matrix: string[][]
) {
  const start = parseAddress(startAddress);
  if (!start) return;
  matrix.forEach((values, rowOffset) => {
    values.forEach((raw, colOffset) => {
      const row = start.row + rowOffset;
      const col = start.col + colOffset;
      if (row >= DEFAULT_ROWS || col >= DEFAULT_COLUMNS) return;
      const address = cellAddress(row, col);
      const existing = sheet.cells[address] ?? { raw: "" };
      const nextRaw = raw.slice(0, MAX_CELL_RAW_LENGTH);
      if (nextRaw === "" && !existing.style) {
        delete sheet.cells[address];
      } else {
        sheet.cells[address] = { ...existing, raw: nextRaw };
      }
    });
  });
}

function sortableRaw(raw: string) {
  const numericValue = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(numericValue)) {
    return { kind: 0, value: numericValue };
  }
  return { kind: 1, value: raw.toLocaleLowerCase() };
}

export function sortRangeRows(
  sheet: Worksheet,
  range: CellRange,
  keyColumn: number,
  direction: SortDirection
) {
  const normalized = normalizeRange(range.start, range.end);
  if (!normalized) return;
  const start = parseAddress(normalized.start)!;
  const end = parseAddress(normalized.end)!;
  if (keyColumn < start.col || keyColumn > end.col) return;

  const rows = Array.from(
    { length: end.row - start.row + 1 },
    (_, offset) => {
      const row = start.row + offset;
      return {
        originalRow: row,
        cells: Array.from(
          { length: end.col - start.col + 1 },
          (_, colOffset) => {
            const address = cellAddress(row, start.col + colOffset);
            const cell = sheet.cells[address];
            return cell ? JSON.parse(JSON.stringify(cell)) as SheetCell : undefined;
          }
        )
      };
    }
  );

  rows.sort((a, b) => {
    const aRaw =
      a.cells[keyColumn - start.col]?.raw ?? "";
    const bRaw =
      b.cells[keyColumn - start.col]?.raw ?? "";
    const av = sortableRaw(aRaw);
    const bv = sortableRaw(bRaw);
    let result = av.kind - bv.kind;
    if (result === 0) {
      result =
        typeof av.value === "number" && typeof bv.value === "number"
          ? av.value - bv.value
          : String(av.value).localeCompare(String(bv.value));
    }
    if (result === 0) result = a.originalRow - b.originalRow;
    return direction === "asc" ? result : -result;
  });

  rows.forEach((source, rowOffset) => {
    source.cells.forEach((cell, colOffset) => {
      const address = cellAddress(
        start.row + rowOffset,
        start.col + colOffset
      );
      if (cell) sheet.cells[address] = cell;
      else delete sheet.cells[address];
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeStyle(value: unknown): CellStyle | undefined {
  if (!isRecord(value)) return undefined;
  const style: CellStyle = {};
  if (typeof value.bold === "boolean") style.bold = value.bold;
  if (typeof value.italic === "boolean") style.italic = value.italic;
  if (typeof value.underline === "boolean") style.underline = value.underline;
  if (["left", "center", "right"].includes(String(value.align))) {
    style.align = value.align as CellStyle["align"];
  }
  if (typeof value.fill === "string" && /^#[0-9a-f]{6}$/i.test(value.fill)) {
    style.fill = value.fill;
  }
  if (typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color)) {
    style.color = value.color;
  }
  if (
    ["general", "number", "percent", "currency"].includes(
      String(value.numberFormat)
    )
  ) {
    style.numberFormat = value.numberFormat as CellStyle["numberFormat"];
  }
  return Object.keys(style).length ? style : undefined;
}

export function normalizeWorkbook(input: unknown): Workbook | null {
  if (!isRecord(input) || !Array.isArray(input.sheets) || !input.sheets.length) {
    return null;
  }

  const sheets: Worksheet[] = [];
  for (const [sheetIndex, sheetInput] of input.sheets.slice(0, MAX_SHEETS).entries()) {
    if (!isRecord(sheetInput)) continue;
    const cells: Record<string, SheetCell> = {};
    if (isRecord(sheetInput.cells)) {
      let count = 0;
      for (const [address, cellInput] of Object.entries(sheetInput.cells)) {
        if (count >= MAX_CELLS_PER_SHEET) break;
        const parsed = parseAddress(address);
        if (
          !parsed ||
          parsed.row >= DEFAULT_ROWS ||
          parsed.col >= DEFAULT_COLUMNS ||
          !isRecord(cellInput) ||
          typeof cellInput.raw !== "string"
        ) {
          continue;
        }
        cells[parsed.address] = {
          raw: cellInput.raw.slice(0, MAX_CELL_RAW_LENGTH),
          style: sanitizeStyle(cellInput.style)
        };
        count += 1;
      }
    }

    sheets.push({
      id:
        typeof sheetInput.id === "string" && sheetInput.id
          ? sheetInput.id
          : `sheet-${sheetIndex + 1}`,
      name:
        typeof sheetInput.name === "string" && sheetInput.name.trim()
          ? sheetInput.name.trim().slice(0, 80)
          : `Sheet ${sheetIndex + 1}`,
      cells,
      frozenRows:
        typeof sheetInput.frozenRows === "number"
          ? Math.max(0, Math.min(5, Math.floor(sheetInput.frozenRows)))
          : 0,
      frozenColumns:
        typeof sheetInput.frozenColumns === "number"
          ? Math.max(0, Math.min(5, Math.floor(sheetInput.frozenColumns)))
          : 0
    });
  }

  if (!sheets.length) return null;
  const activeSheetId =
    typeof input.activeSheetId === "string" &&
    sheets.some((sheet) => sheet.id === input.activeSheetId)
      ? input.activeSheetId
      : sheets[0].id;

  const namedRanges: NamedRange[] = Array.isArray(input.namedRanges)
    ? input.namedRanges
        .filter(isRecord)
        .slice(0, 1000)
        .flatMap((range) => {
          const sheetId =
            typeof range.sheetId === "string" ? range.sheetId : "";
          const name = typeof range.name === "string" ? range.name.trim() : "";
          const start = typeof range.start === "string" ? parseAddress(range.start) : null;
          const end = typeof range.end === "string" ? parseAddress(range.end) : null;
          if (
            !name ||
            !start ||
            !end ||
            !sheets.some((sheet) => sheet.id === sheetId)
          ) {
            return [];
          }
          return [
            {
              name: name.slice(0, 80),
              sheetId,
              start: start.address,
              end: end.address
            }
          ];
        })
    : [];

  return {
    formatVersion: WORKBOOK_FORMAT_VERSION,
    id:
      typeof input.id === "string" && input.id
        ? input.id
        : "workbook-" + Date.now().toString(36),
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 160)
        : "Untitled spreadsheet",
    version:
      typeof input.version === "number" && Number.isFinite(input.version)
        ? Math.max(1, Math.floor(input.version))
        : 1,
    activeSheetId,
    sheets,
    namedRanges,
    updatedAt:
      typeof input.updatedAt === "string"
        ? input.updatedAt
        : new Date().toISOString()
  };
}

export function serializeWorkbook(workbook: Workbook): string {
  return JSON.stringify({
    ...workbook,
    formatVersion: WORKBOOK_FORMAT_VERSION
  });
}

export function parseWorkbookJson(json: string): Workbook | null {
  try {
    return normalizeWorkbook(JSON.parse(json));
  } catch {
    return null;
  }
}

export * from "./native-format.js";
