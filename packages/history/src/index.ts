export type HistoryEntry<T> = {
  id: string;
  label: string;
  before: T;
  after: T;
  timestamp: number;
};

function copy<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

export class TransactionHistory<T> {
  private undoStack: HistoryEntry<T>[] = [];
  private redoStack: HistoryEntry<T>[] = [];

  constructor(private readonly limit = 100) {}

  push(label: string, before: T, after: T): void {
    this.undoStack.push({
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      label,
      before: copy(before),
      after: copy(after),
      timestamp: Date.now()
    });

    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
    }

    this.redoStack = [];
  }

  undo(): T | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;

    this.redoStack.push(entry);
    return copy(entry.before);
  }

  redo(): T | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;

    this.undoStack.push(entry);
    return copy(entry.after);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }
}
