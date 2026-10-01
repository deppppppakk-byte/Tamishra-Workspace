"use client";

const DB_NAME = "tamishra-workspace";
const STORE_NAME = "binary-assets";
const DB_VERSION = 2;

export type WorkspaceBinaryAsset = {
  id: string;
  name: string;
  type: string;
  size: number;
  bytes: ArrayBuffer;
  createdAt: string;
  updatedAt: string;
};

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("native-file-handoffs")) {
        db.createObjectStore("native-file-handoffs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("binary_store_open_failed"));
  });
}

function createId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function putWorkspaceBinaryAsset(input: {
  id?: string;
  name: string;
  type: string;
  bytes: ArrayBuffer;
}) {
  const db = await openDb();
  const id = input.id ?? `asset_${createId()}`;
  const existing = await new Promise<WorkspaceBinaryAsset | undefined>(
    (resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () =>
        resolve(request.result as WorkspaceBinaryAsset | undefined);
      request.onerror = () =>
        reject(request.error ?? new Error("binary_asset_read_failed"));
    }
  );

  const now = new Date().toISOString();
  const record: WorkspaceBinaryAsset = {
    id,
    name: input.name,
    type: input.type,
    size: input.bytes.byteLength,
    bytes: input.bytes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("binary_asset_write_failed"));
  });

  db.close();
  return record;
}

export async function getWorkspaceBinaryAsset(id: string) {
  const db = await openDb();
  const record = await new Promise<WorkspaceBinaryAsset | undefined>(
    (resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () =>
        resolve(request.result as WorkspaceBinaryAsset | undefined);
      request.onerror = () =>
        reject(request.error ?? new Error("binary_asset_read_failed"));
    }
  );
  db.close();
  return record ?? null;
}

export async function deleteWorkspaceBinaryAsset(id: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("binary_asset_delete_failed"));
  });
  db.close();
}
