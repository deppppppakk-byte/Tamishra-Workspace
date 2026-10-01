"use client";

import { useEffect } from "react";
import {
  createNativeFileHandoffFromBytes,
  targetAppForNativeFile
} from "../lib/native-file-handoff";

type NativeWorkspaceFile = {
  path: string;
  name: string;
  extension: string;
  bytes: number[];
};

function mimeForExtension(extension: string) {
  switch (extension.toLowerCase()) {
    case "tmdoc":
      return "application/vnd.tamishra.document";
    case "tmsh":
      return "application/vnd.tamishra.spreadsheet";
    case "tmsl":
      return "application/x-tamishra-slides";
    case "tmnt":
      return "application/vnd.tamishra.note";
    case "tmfm":
      return "application/vnd.tamishra.form";
    default:
      return "application/octet-stream";
  }
}

function bytesToArrayBuffer(bytes: number[]) {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function DesktopNativeOpenBridge() {
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event")
      ]);

      const startupRoute = await invoke<string | null>("startup_workspace_route");
      if (
        !disposed &&
        startupRoute &&
        window.location.pathname !== startupRoute
      ) {
        window.location.replace(startupRoute);
        return;
      }

      unlisten = await listen<string>(
        "tamishra://open-workspace-file",
        async (event) => {
          if (disposed || !event.payload) return;

          const path = event.payload;
          const lower = path.toLowerCase();

          // Slides keeps a native-path attachment in Rust so Save writes back to
          // the original .tmsl. A route reload lets its specialized pending-file
          // bridge preserve that behavior without duplicating the import.
          if (lower.endsWith(".tmsl")) {
            window.location.assign("/apps/slides");
            return;
          }

          try {
            const opened = await invoke<NativeWorkspaceFile>(
              "open_workspace_native_path",
              { path }
            );
            if (disposed) return;

            const target = targetAppForNativeFile(opened.name);
            if (!target) return;

            await createNativeFileHandoffFromBytes({
              name: opened.name,
              type: mimeForExtension(opened.extension),
              bytes: bytesToArrayBuffer(opened.bytes)
            });

            if (!disposed) {
              window.location.assign(target);
            }
          } catch (error) {
            console.error("Tamishra native file open failed", error);
          }
        }
      );
    })().catch((error) => {
      console.error("Tamishra desktop native-open bridge failed", error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
