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
  id: string;
  title: string;
  version: number;
  activeSheetId: string;
  sheets: Worksheet[];
  namedRanges: NamedRange[];
  updatedAt: string;
};

export type FormulaValue = string | number | boolean | null;

export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLUMNS = 52;

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
  const tokens = normalized.match(/(?:\d+\.\d+|\d+|[A-Za-z_][A-Za-z0-9_]*|>=|<=|<>|=|>|<|[+\-*/^(),:])/g) ?? [];
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
      left = op === "+" ? numeric(left) + numeric(right) : numeric(left) - numeric(right);
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
          if (!end || !/^[A-Za-z]+[1-9]\d*$/.test(end)) throw new Error("Invalid range");
          return this.range(identifier, end.toUpperCase());
        }
        return evaluateCell(this.workbook, this.sheet.id, identifier, this.stack);
      }

      const named = this.workbook.namedRanges.find((range) => range.name.toUpperCase() === identifier);
      if (named) {
        const targetSheet = this.workbook.sheets.find((sheet) => sheet.id === named.sheetId);
        if (!targetSheet) return [];
        return this.range(named.start, named.end, targetSheet);
      }

      if (identifier === "TRUE") return true;
      if (identifier === "FALSE") return false;
      throw new Error("Unknown name " + token);
    }

    throw new Error("Unexpected token " + token);
  }

  private range(start: string, end: string, sourceSheet = this.sheet): FormulaValue[] {
    const a = parseAddress(start);
    const b = parseAddress(end);
    if (!a || !b) return [];
    const values: FormulaValue[] = [];
    for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row += 1) {
      for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col += 1) {
        values.push(evaluateCell(this.workbook, sourceSheet.id, cellAddress(row, col), this.stack));
      }
    }
    return values;
  }

  private callFunction(name: string, args: Array<FormulaValue | FormulaValue[]>): FormulaValue {
    const values = flatten(args);
    const nums = values.map(numeric);
    switch (name) {
      case "SUM":
        return nums.reduce((sum, value) => sum + value, 0);
      case "AVERAGE":
      case "AVG":
        return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
      case "MIN":
        return nums.length ? Math.min(...nums) : 0;
      case "MAX":
        return nums.length ? Math.max(...nums) : 0;
      case "COUNT":
        return values.filter((value) => value !== "" && value != null && Number.isFinite(Number(value))).length;
      case "COUNTA":
        return values.filter((value) => value !== "" && value != null).length;
      case "ABS":
        return Math.abs(numeric(args[0] ?? 0));
      case "ROUND": {
        const value = numeric(args[0] ?? 0);
        const places = Math.max(0, Math.floor(numeric(args[1] ?? 0)));
        const factor = 10 ** places;
        return Math.round(value * factor) / factor;
      }
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
    return cell.raw.trim() !== "" && Number.isFinite(asNumber) ? asNumber : cell.raw;
  }

  const stackKey = sheetId + ":" + key;
  if (inheritedStack.has(stackKey)) return "#CYCLE!";
  const stack = new Set(inheritedStack);
  stack.add(stackKey);

  try {
    const parser = new FormulaParser(tokenize(cell.raw.slice(1)), sheet, workbook, stack);
    const value = parser.parse();
    return Array.isArray(value) ? value[0] ?? null : value;
  } catch (error) {
    const message = error instanceof Error ? error.message : "#ERROR!";
    return message.startsWith("#") ? message : "#ERROR!";
  }
}

export function formatDisplay(value: FormulaValue, style?: CellStyle): string {
  if (value == null) return "";
  if (typeof value !== "number") return String(value);
  if (style?.numberFormat === "percent") return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 }).format(value);
  if (style?.numberFormat === "currency") return new Intl.NumberFormat(undefined, { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
  if (style?.numberFormat === "number") return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
  return String(value);
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
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

export function csvToCells(csv: string): Record<string, SheetCell> {
  const cells: Record<string, SheetCell> = {};
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);

  rows.forEach((values, rowIndex) => {
    values.forEach((value, colIndex) => {
      if (value !== "") cells[cellAddress(rowIndex, colIndex)] = { raw: value };
    });
  });
  return cells;
}
