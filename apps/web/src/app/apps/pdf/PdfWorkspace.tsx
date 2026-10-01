"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { upsertWorkspaceFile } from "@tamishra/file-core";
import {
  consumeNativeFileHandoff
} from "../../../lib/native-file-handoff";
import {
  getWorkspaceBinaryAsset,
  putWorkspaceBinaryAsset,
  type WorkspaceBinaryAsset
} from "../../../lib/workspace-binary-store";
import { mutateWorkspaceFileIndex } from "../../../lib/workspace-files";
import {
  fetchCloudBinaryAsset,
  updateCloudPdfMetadata,
  uploadCloudPdfAsset
} from "../../../lib/workspace-binary-cloud";
import styles from "./pdf.module.css";

type PdfAnnotation = {
  id: string;
  kind: "highlight" | "box" | "note";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  createdAt: string;
};

type DragDraft = {
  x: number;
  y: number;
  currentX: number;
  currentY: number;
} | null;

type SearchResult = {
  page: number;
  matches: number;
};

function annotationKey(assetId: string) {
  return `tamishra.pdf.annotations.${assetId}`;
}

type PdfAnnotationState = {
  updatedAt: string;
  annotations: PdfAnnotation[];
};

function normalizeAnnotations(value: unknown): PdfAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PdfAnnotation =>
    Boolean(
      item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      typeof item.kind === "string" &&
      typeof item.page === "number"
    )
  );
}

function readLocalAnnotationState(assetId: string): PdfAnnotationState {
  const raw = localStorage.getItem(annotationKey(assetId));
  if (!raw) return { updatedAt: "", annotations: [] };

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { updatedAt: "", annotations: normalizeAnnotations(parsed) };
    }
    return {
      updatedAt:
        parsed && typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      annotations: normalizeAnnotations(parsed?.annotations)
    };
  } catch {
    return { updatedAt: "", annotations: [] };
  }
}

function annotationStateFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): PdfAnnotationState {
  return {
    updatedAt:
      typeof metadata?.annotationsUpdatedAt === "string"
        ? metadata.annotationsUpdatedAt
        : "",
    annotations: normalizeAnnotations(metadata?.annotations)
  };
}

function makeId(prefix: string) {
  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${value}`;
}

function countMatches(text: string, query: string) {
  if (!query) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const next = text.indexOf(query, cursor);
    if (next < 0) return count;
    count += 1;
    cursor = next + Math.max(1, query.length);
  }
}

export default function PdfWorkspace() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renderTaskRef = useRef<{ cancel?: () => void } | null>(null);

  const [asset, setAsset] = useState<WorkspaceBinaryAsset | null>(null);
  const [pdfDocument, setPdfDocument] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(110);
  const [rotation, setRotation] = useState(0);
  const [status, setStatus] = useState("Open a PDF to begin");
  const [rendering, setRendering] = useState(false);
  const [tool, setTool] = useState<"pan" | "highlight" | "box" | "note">("pan");
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [dragDraft, setDragDraft] = useState<DragDraft>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const currentAnnotations = useMemo(
    () => annotations.filter((item) => item.page === pageNumber),
    [annotations, pageNumber]
  );

  const configurePdfJs = useCallback(async () => {
    const pdfjs = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
    }
    return pdfjs;
  }, []);

  const indexAsset = useCallback((record: WorkspaceBinaryAsset) => {
    mutateWorkspaceFileIndex((index) =>
      upsertWorkspaceFile(index, {
        id: `pdf:${record.id}`,
        title: record.name.replace(/\.pdf$/i, "") || "PDF document",
        kind: "pdf",
        appHref: `/apps/pdf?file=${encodeURIComponent(record.id)}`,
        nativeExtension: ".pdf",
        nativeMime: "application/pdf",
        sourceId: record.id,
        sizeBytes: record.size,
        storage: "local"
      })
    );
  }, []);

  const openStoredAsset = useCallback(
    async (
      record: WorkspaceBinaryAsset,
      cloudMetadata?: Record<string, unknown> | null
    ) => {
      setStatus("Opening PDF…");
      setAsset(record);
      setPageNumber(1);
      setRotation(0);
      setSearchResults([]);

      const localAnnotations = readLocalAnnotationState(record.id);
      const cloudAnnotations = annotationStateFromMetadata(cloudMetadata);
      const selectedAnnotations =
        cloudAnnotations.updatedAt.localeCompare(localAnnotations.updatedAt) > 0
          ? cloudAnnotations
          : localAnnotations;

      setAnnotations(selectedAnnotations.annotations);
      localStorage.setItem(
        annotationKey(record.id),
        JSON.stringify(selectedAnnotations)
      );

      const pdfjs = await configurePdfJs();
      const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(record.bytes.slice(0))
      });
      const doc = await loadingTask.promise;
      setPdfDocument(doc);
      setPageCount(doc.numPages);
      setStatus(`${record.name} · ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`);
      indexAsset(record);
    },
    [configurePdfJs, indexAsset]
  );

  const storeAndOpenFile = useCallback(
    async (file: File) => {
      if (
        file.type !== "application/pdf" &&
        !file.name.toLowerCase().endsWith(".pdf")
      ) {
        throw new Error("Tamishra PDF currently opens PDF files only.");
      }

      const record = await putWorkspaceBinaryAsset({
        name: file.name || "document.pdf",
        type: "application/pdf",
        bytes: await file.arrayBuffer()
      });

      history.replaceState(
        null,
        "",
        `/apps/pdf?file=${encodeURIComponent(record.id)}`
      );
      await openStoredAsset(record);

      const annotationState = readLocalAnnotationState(record.id);
      void uploadCloudPdfAsset(record, {
        annotations: annotationState.annotations,
        annotationsUpdatedAt: annotationState.updatedAt
      }).then((result) => {
        if (result.reason === "too_large") {
          setStatus(
            `${record.name} · local only · PDF exceeds the 16 MB cloud-sync limit`
          );
        } else if (result.uploaded && result.persistence === "postgres") {
          setStatus(`${record.name} · cloud synchronized`);
        }
      });
    },
    [openStoredAsset]
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const requestedId = new URLSearchParams(location.search).get("file");
      if (requestedId) {
        const [stored, cloud] = await Promise.all([
          getWorkspaceBinaryAsset(requestedId),
          fetchCloudBinaryAsset(requestedId).catch(() => null)
        ]);

        if (!cancelled && stored) {
          await openStoredAsset(stored, cloud?.metadata ?? null);

          if (!cloud) {
            const annotationState = readLocalAnnotationState(stored.id);
            void uploadCloudPdfAsset(stored, {
              annotations: annotationState.annotations,
              annotationsUpdatedAt: annotationState.updatedAt
            });
          }
          return;
        }

        if (!cancelled && cloud) {
          const restored = await putWorkspaceBinaryAsset({
            id: cloud.asset.id,
            name: cloud.asset.name,
            type: cloud.asset.type,
            bytes: cloud.asset.bytes
          });
          await openStoredAsset(restored, cloud.metadata);
          setStatus(`${restored.name} · restored from cloud`);
          return;
        }
      }

      const handoff = await consumeNativeFileHandoff();
      if (!cancelled && handoff) {
        const file = new File([handoff.bytes], handoff.name, {
          type: handoff.type || "application/pdf"
        });
        await storeAndOpenFile(file);
      }
    })().catch((error) => {
      if (!cancelled) {
        console.error("PDF startup open failed", error);
        setStatus(error instanceof Error ? error.message : "Could not open PDF");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [openStoredAsset, storeAndOpenFile]);

  useEffect(() => {
    if (!asset) return;

    const updatedAt = new Date().toISOString();
    const localState: PdfAnnotationState = {
      updatedAt,
      annotations
    };

    localStorage.setItem(
      annotationKey(asset.id),
      JSON.stringify(localState)
    );

    const timer = window.setTimeout(() => {
      void updateCloudPdfMetadata(asset.id, {
        annotations,
        annotationsUpdatedAt: updatedAt
      }).then((result) => {
        const remoteState = annotationStateFromMetadata(result.metadata);
        if (remoteState.updatedAt.localeCompare(updatedAt) > 0) {
          setAnnotations(remoteState.annotations);
          localStorage.setItem(
            annotationKey(asset.id),
            JSON.stringify(remoteState)
          );
          setStatus("Annotations refreshed from cloud");
        }
      });
    }, 900);

    return () => window.clearTimeout(timer);
  }, [annotations, asset]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return;

    let disposed = false;
    setRendering(true);

    void (async () => {
      renderTaskRef.current?.cancel?.();
      const page = await pdfDocument.getPage(pageNumber);
      if (disposed) return;

      const viewport = page.getViewport({
        scale: Math.max(0.35, zoom / 100 * 1.35),
        rotation
      });
      const canvas = canvasRef.current;
      if (!canvas) return;

      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0]
      });
      renderTaskRef.current = renderTask;

      try {
        await renderTask.promise;
        if (!disposed) setRendering(false);
      } catch (error) {
        if (!disposed && (error as { name?: string }).name !== "RenderingCancelledException") {
          console.error("PDF render failed", error);
          setStatus("Could not render this page");
          setRendering(false);
        }
      }
    })();

    return () => {
      disposed = true;
      renderTaskRef.current?.cancel?.();
    };
  }, [pdfDocument, pageNumber, zoom, rotation]);

  const chooseTool = (next: typeof tool) => {
    if (next !== "pan" && rotation !== 0) {
      setRotation(0);
      setStatus("Rotation reset to 0° for accurate annotations");
    }
    setTool(next);
  };

  const pointerPosition = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!asset || tool === "pan" || rotation !== 0) return;

    const point = pointerPosition(event);

    if (tool === "note") {
      const text = window.prompt("Note");
      if (!text?.trim()) return;
      setAnnotations((current) => [
        ...current,
        {
          id: makeId("note"),
          kind: "note",
          page: pageNumber,
          x: point.x,
          y: point.y,
          width: 0.16,
          height: 0.05,
          text: text.trim(),
          createdAt: new Date().toISOString()
        }
      ]);
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDragDraft({
      x: point.x,
      y: point.y,
      currentX: point.x,
      currentY: point.y
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragDraft) return;
    const point = pointerPosition(event);
    setDragDraft((current) =>
      current
        ? { ...current, currentX: point.x, currentY: point.y }
        : current
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragDraft || (tool !== "highlight" && tool !== "box")) return;

    const point = pointerPosition(event);
    const x = Math.min(dragDraft.x, point.x);
    const y = Math.min(dragDraft.y, point.y);
    const width = Math.abs(point.x - dragDraft.x);
    const height = Math.abs(point.y - dragDraft.y);
    setDragDraft(null);

    if (width < 0.01 || height < 0.006) return;

    setAnnotations((current) => [
      ...current,
      {
        id: makeId(tool),
        kind: tool,
        page: pageNumber,
        x,
        y,
        width,
        height,
        createdAt: new Date().toISOString()
      }
    ]);
  };

  const runSearch = async () => {
    const query = searchQuery.trim().toLowerCase();
    if (!pdfDocument || !query) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    setStatus("Searching document…");

    try {
      const results: SearchResult[] = [];

      for (let pageIndex = 1; pageIndex <= pageCount; pageIndex += 1) {
        const page = await pdfDocument.getPage(pageIndex);
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item: any) => ("str" in item ? String(item.str) : ""))
          .join(" ")
          .toLowerCase();
        const matches = countMatches(text, query);
        if (matches) results.push({ page: pageIndex, matches });
      }

      setSearchResults(results);
      const total = results.reduce((sum, item) => sum + item.matches, 0);
      setStatus(
        total
          ? `${total} match${total === 1 ? "" : "es"} across ${results.length} page${results.length === 1 ? "" : "s"}`
          : "No matches found"
      );
      if (results[0]) setPageNumber(results[0].page);
    } catch (error) {
      console.error("PDF search failed", error);
      setStatus("Search failed");
    } finally {
      setSearching(false);
    }
  };

  const exportAnnotatedPdf = async () => {
    if (!asset) return;

    setStatus("Writing annotations to PDF…");

    try {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
      const pdf = await PDFDocument.load(asset.bytes.slice(0));
      const font = await pdf.embedFont(StandardFonts.Helvetica);

      for (const item of annotations) {
        const page = pdf.getPage(item.page - 1);
        if (!page) continue;
        const { width, height } = page.getSize();
        const x = item.x * width;
        const boxWidth = item.width * width;
        const boxHeight = item.height * height;
        const y = height - (item.y + item.height) * height;

        if (item.kind === "highlight") {
          page.drawRectangle({
            x,
            y,
            width: boxWidth,
            height: boxHeight,
            color: rgb(1, 0.83, 0.15),
            opacity: 0.28,
            borderOpacity: 0
          });
        } else if (item.kind === "box") {
          page.drawRectangle({
            x,
            y,
            width: boxWidth,
            height: boxHeight,
            borderColor: rgb(0.19, 0.36, 0.96),
            borderWidth: 1.4,
            opacity: 0
          });
        } else {
          const safeText = (item.text ?? "Note")
            .replace(/[^\x20-\x7E]/g, "?")
            .slice(0, 140);
          page.drawRectangle({
            x,
            y,
            width: Math.max(boxWidth, 90),
            height: Math.max(boxHeight, 22),
            color: rgb(1, 0.93, 0.55),
            opacity: 0.72
          });
          page.drawText(safeText, {
            x: x + 4,
            y: y + 6,
            size: 9,
            font,
            color: rgb(0.18, 0.2, 0.24),
            maxWidth: Math.max(boxWidth, 86)
          });
        }
      }

      const bytes = await pdf.save();
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const blob = new Blob([buffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        (asset.name.replace(/\.pdf$/i, "") || "document") + "-annotated.pdf";
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("Annotated PDF exported");
    } catch (error) {
      console.error("Annotated PDF export failed", error);
      setStatus("Annotated PDF export failed");
    }
  };

  const draftRect = dragDraft
    ? {
        left: `${Math.min(dragDraft.x, dragDraft.currentX) * 100}%`,
        top: `${Math.min(dragDraft.y, dragDraft.currentY) * 100}%`,
        width: `${Math.abs(dragDraft.currentX - dragDraft.x) * 100}%`,
        height: `${Math.abs(dragDraft.currentY - dragDraft.y) * 100}%`
      }
    : undefined;

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.back}>← Workspace</Link>
        <div className={styles.titleBlock}>
          <strong>{asset?.name ?? "Tamishra PDF"}</strong>
          <span>{status}</span>
        </div>
        <div className={styles.topActions}>
          <button onClick={() => inputRef.current?.click()}>Open PDF</button>
          <button
            className={styles.primary}
            onClick={exportAnnotatedPdf}
            disabled={!asset}
          >
            Export annotated PDF
          </button>
        </div>
        <input
          ref={inputRef}
          hidden
          type="file"
          accept=".pdf,application/pdf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void storeAndOpenFile(file).catch((error) => {
              setStatus(error instanceof Error ? error.message : "Could not open PDF");
            });
          }}
        />
      </header>

      <section className={styles.toolbar}>
        <div className={styles.toolGroup}>
          {(["pan", "highlight", "box", "note"] as const).map((item) => (
            <button
              key={item}
              className={tool === item ? styles.activeTool : ""}
              onClick={() => chooseTool(item)}
              disabled={!asset}
            >
              {item === "pan"
                ? "Pan"
                : item === "highlight"
                  ? "Highlight"
                  : item === "box"
                    ? "Box"
                    : "Note"}
            </button>
          ))}
        </div>

        <div className={styles.toolGroup}>
          <button
            disabled={!asset || pageNumber <= 1}
            onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
          >
            ←
          </button>
          <label>
            Page
            <input
              value={pageNumber}
              min={1}
              max={Math.max(1, pageCount)}
              type="number"
              disabled={!asset}
              onChange={(event) =>
                setPageNumber(
                  Math.min(
                    Math.max(1, Number(event.target.value) || 1),
                    Math.max(1, pageCount)
                  )
                )
              }
            />
            <span>/ {pageCount || 0}</span>
          </label>
          <button
            disabled={!asset || pageNumber >= pageCount}
            onClick={() =>
              setPageNumber((value) => Math.min(pageCount, value + 1))
            }
          >
            →
          </button>
        </div>

        <div className={styles.toolGroup}>
          <button onClick={() => setZoom((value) => Math.max(40, value - 10))} disabled={!asset}>−</button>
          <span>{zoom}%</span>
          <button onClick={() => setZoom((value) => Math.min(250, value + 10))} disabled={!asset}>+</button>
          <button onClick={() => setRotation((value) => (value + 90) % 360)} disabled={!asset}>Rotate</button>
        </div>

        <form
          className={styles.search}
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search text in PDF"
            disabled={!asset}
          />
          <button disabled={!asset || searching}>
            {searching ? "Searching…" : "Find"}
          </button>
        </form>
      </section>

      <section className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.panelHeader}>
            <strong>Pages</strong>
            <span>{pageCount}</span>
          </div>
          <div className={styles.pageList}>
            {Array.from({ length: pageCount }, (_, index) => index + 1).map(
              (item) => (
                <button
                  key={item}
                  className={pageNumber === item ? styles.activePage : ""}
                  onClick={() => setPageNumber(item)}
                >
                  <b>{item}</b>
                  <span>
                    {annotations.filter((annotation) => annotation.page === item).length} annotations
                  </span>
                </button>
              )
            )}
          </div>

          {searchResults.length > 0 && (
            <>
              <div className={styles.panelHeader}>
                <strong>Search results</strong>
                <span>{searchResults.length}</span>
              </div>
              <div className={styles.searchList}>
                {searchResults.map((result) => (
                  <button
                    key={result.page}
                    onClick={() => setPageNumber(result.page)}
                  >
                    Page {result.page}
                    <span>{result.matches} match{result.matches === 1 ? "" : "es"}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>

        <section className={styles.stage}>
          {!asset ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>PDF</div>
              <h1>Tamishra PDF</h1>
              <p>Open a PDF to read, search, highlight, add notes and export a marked-up copy.</p>
              <button onClick={() => inputRef.current?.click()}>Open PDF</button>
            </div>
          ) : (
            <div className={styles.paperWrap}>
              {rendering && <div className={styles.rendering}>Rendering page…</div>}
              <div className={styles.pageSurface}>
                <canvas ref={canvasRef} className={styles.canvas} />
                <div
                  ref={overlayRef}
                  className={`${styles.overlay} ${tool !== "pan" ? styles.annotationMode : ""}`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                >
                  {currentAnnotations.map((item) => (
                    <div
                      key={item.id}
                      className={`${styles.annotation} ${styles[item.kind]}`}
                      style={{
                        left: `${item.x * 100}%`,
                        top: `${item.y * 100}%`,
                        width: `${item.width * 100}%`,
                        height: `${item.height * 100}%`
                      }}
                      title={item.text}
                    >
                      {item.kind === "note" ? "N" : null}
                    </div>
                  ))}
                  {dragDraft && (
                    <div
                      className={`${styles.annotation} ${styles.draft} ${styles[tool]}`}
                      style={draftRect}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        <aside className={styles.inspector}>
          <div className={styles.panelHeader}>
            <strong>Annotations</strong>
            <span>{currentAnnotations.length}</span>
          </div>

          {currentAnnotations.length ? (
            <div className={styles.annotationList}>
              {currentAnnotations.map((item) => (
                <article key={item.id}>
                  <div>
                    <strong>{item.kind}</strong>
                    <span>{item.text || `Page ${item.page}`}</span>
                  </div>
                  <button
                    onClick={() =>
                      setAnnotations((current) =>
                        current.filter((annotation) => annotation.id !== item.id)
                      )
                    }
                  >
                    Remove
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className={styles.panelEmpty}>
              Use Highlight, Box or Note to mark this page.
            </p>
          )}

          <div className={styles.panelHeader}>
            <strong>Document</strong>
          </div>
          <div className={styles.documentStats}>
            <span><b>{pageCount}</b> pages</span>
            <span><b>{annotations.length}</b> annotations</span>
            <span><b>{asset ? (asset.size / 1024 / 1024).toFixed(2) : "0"}</b> MB</span>
          </div>
        </aside>
      </section>
    </main>
  );
}
