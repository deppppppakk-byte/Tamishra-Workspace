"use client";

const DB_NAME = "tamishra-workspace";
const STORE_NAME = "native-file-handoffs";
const DB_VERSION = 2;
const MAX_HANDOFF_BYTES = 64 * 1024 * 1024;

export type NativeFileHandoff = {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  bytes: ArrayBuffer;
};

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("binary-assets")) {
        db.createObjectStore("binary-assets", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
  });
}

function randomId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function createNativeFileHandoff(file: File) {
  if (file.size > MAX_HANDOFF_BYTES) {
    throw new Error("Files larger than 64 MB must be opened from the desktop app.");
  }

  const db = await openDb();
  const id = randomId();
  const record: NativeFileHandoff = {
    id,
    name: file.name,
    type: file.type,
    size: file.size,
    createdAt: new Date().toISOString(),
    bytes: await file.arrayBuffer()
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("handoff_write_failed"));
  });

  db.close();
  sessionStorage.setItem("tamishra.native-handoff", id);
  return id;
}

export async function consumeNativeFileHandoff(): Promise<NativeFileHandoff | null> {
  const id = sessionStorage.getItem("tamishra.native-handoff");
  if (!id) return null;

  const db = await openDb();
  const record = await new Promise<NativeFileHandoff | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result as NativeFileHandoff | undefined);
    request.onerror = () => reject(request.error ?? new Error("handoff_read_failed"));
  });

  if (record) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("handoff_delete_failed"));
    });
  }

  db.close();
  sessionStorage.removeItem("tamishra.native-handoff");
  return record ?? null;
}

export function targetAppForNativeFile(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tmdoc") || lower.endsWith(".docx")) return "/apps/docs";
  if (
    lower.endsWith(".tmsh") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".json")
  ) return "/apps/sheets";
  if (lower.endsWith(".tmsl")) return "/apps/slides";
  if (lower.endsWith(".pdf")) return "/apps/pdf";
  if (lower.endsWith(".tmnt")) return "/apps/notes";
  return null;
}
