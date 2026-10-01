"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createNote,
  createNotesSnapshot,
  parseTamishraNote,
  searchNotes,
  serializeTamishraNote,
  stripHtml,
  tamishraNoteFilename,
  TMNOTE_MIME_TYPE,
  type NotesSnapshot,
  type TamishraNote
} from "@tamishra/notes-core";
import {
  permanentlyDeleteWorkspaceFile,
  trashWorkspaceFile,
  upsertWorkspaceFile
} from "@tamishra/file-core";
import { consumeNativeFileHandoff } from "../../../lib/native-file-handoff";
import { mutateWorkspaceFileIndex } from "../../../lib/workspace-files";
import styles from "./notes.module.css";

const STORAGE_KEY = "tamishra.notes.snapshot.v1";

type View = "notes" | "pinned" | "archive" | "trash";

function sanitizeHtml(html: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed").forEach((node) => node.remove());
  doc.querySelectorAll("*").forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || (["href", "src"].includes(name) && value.startsWith("javascript:"))) {
        element.removeAttribute(attribute.name);
      }
    });
  });
  return doc.body.innerHTML || "<p><br></p>";
}

function loadSnapshot(): NotesSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createNotesSnapshot();
    const parsed = JSON.parse(raw) as Partial<NotesSnapshot>;
    return {
      version: 1,
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      notebooks:
        Array.isArray(parsed.notebooks) && parsed.notebooks.length
          ? parsed.notebooks
          : ["Notes"]
    };
  } catch {
    return createNotesSnapshot();
  }
}

function applyCommand(command: string, value?: string) {
  document.execCommand(command, false, value);
}

export default function NotesWorkspace() {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<NotesSnapshot>(() => createNotesSnapshot());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("notes");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Local-first");
  const [loaded, setLoaded] = useState(false);

  const selectedNote = useMemo(
    () => snapshot.notes.find((note) => note.id === selectedId) ?? null,
    [snapshot.notes, selectedId]
  );

  const visibleNotes = useMemo(() => {
    let notes =
      view === "trash"
        ? snapshot.notes.filter((note) => note.trashedAt)
        : searchNotes(snapshot, query).filter((note) => !note.trashedAt);

    if (view === "notes") notes = notes.filter((note) => !note.archivedAt);
    if (view === "pinned") notes = notes.filter((note) => note.pinned && !note.archivedAt);
    if (view === "archive") notes = notes.filter((note) => note.archivedAt);

    if (view === "trash" && query.trim()) {
      const normalized = query.trim().toLowerCase();
      notes = notes.filter((note) =>
        [note.title, note.plainText, note.notebook, ...note.tags]
          .join(" ")
          .toLowerCase()
          .includes(normalized)
      );
    }

    return [...notes].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt)
    );
  }, [snapshot, view, query]);

  const wordCount = useMemo(() => {
    const text = selectedNote?.plainText.trim() ?? "";
    return text ? text.split(/\s+/).length : 0;
  }, [selectedNote?.plainText]);

  const selectNote = (id: string) => {
    setSelectedId(id);
    history.replaceState(null, "", `/apps/notes?note=${encodeURIComponent(id)}`);
  };

  const createNewNote = () => {
    const note = createNote({
      title: "Untitled note",
      notebook: snapshot.notebooks[0] ?? "Notes"
    });
    setSnapshot((current) => ({
      ...current,
      notes: [note, ...current.notes]
    }));
    setView("notes");
    selectNote(note.id);
    setStatus("New note");
  };

  const updateNote = (id: string, patch: Partial<TamishraNote>) => {
    const now = new Date().toISOString();
    setSnapshot((current) => ({
      ...current,
      notes: current.notes.map((note) =>
        note.id === id ? { ...note, ...patch, updatedAt: now } : note
      )
    }));
  };

  const saveEditorHtml = () => {
    if (!selectedNote || !editorRef.current) return;
    const html = sanitizeHtml(editorRef.current.innerHTML);
    updateNote(selectedNote.id, {
      html,
      plainText: stripHtml(html)
    });
  };

  const importNativeBytes = (bytes: ArrayBuffer | Uint8Array) => {
    const parsed = parseTamishraNote(bytes);
    const note: TamishraNote = {
      ...parsed,
      html: sanitizeHtml(parsed.html),
      plainText: stripHtml(parsed.html),
      trashedAt: null,
      updatedAt: new Date().toISOString()
    };
    setSnapshot((current) => ({
      ...current,
      notebooks: Array.from(new Set([...current.notebooks, note.notebook])),
      notes: [note, ...current.notes.filter((item) => item.id !== note.id)]
    }));
    setView("notes");
    selectNote(note.id);
    setStatus(".tmnt opened · integrity verified");
  };

  useEffect(() => {
    const restored = loadSnapshot();
    setSnapshot(restored);

    const requestedId = new URLSearchParams(location.search).get("note");
    if (requestedId && restored.notes.some((note) => note.id === requestedId)) {
      setSelectedId(requestedId);
    } else {
      setSelectedId(
        restored.notes.find((note) => !note.trashedAt)?.id ?? null
      );
    }

    setLoaded(true);
  }, []);

  useEffect(() => {
    if (
      !loaded ||
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in window)
    ) {
      return;
    }

    let cancelled = false;

    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("startup_tmnt"))
      .then((raw) => {
        if (cancelled || !raw) return;
        importNativeBytes(new TextEncoder().encode(raw));
        setStatus(".tmnt opened from desktop");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Could not open startup .tmnt", error);
        setStatus("Startup .tmnt could not be opened");
      });

    return () => {
      cancelled = true;
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;

    const createRequest = sessionStorage.getItem("tamishra.workspace.create");
    if (createRequest === "notes") {
      sessionStorage.removeItem("tamishra.workspace.create");
      createNewNote();
      return;
    }

    void consumeNativeFileHandoff()
      .then((handoff) => {
        if (!handoff || !handoff.name.toLowerCase().endsWith(".tmnt")) return;
        importNativeBytes(handoff.bytes);
      })
      .catch((error) => {
        console.error("Notes handoff failed", error);
        setStatus("Workspace note could not be opened");
      });
  }, [loaded]);

  useEffect(() => {
    if (!selectedNote || !editorRef.current) return;
    editorRef.current.innerHTML = sanitizeHtml(selectedNote.html);
  }, [selectedId]);

  useEffect(() => {
    if (!loaded) return;
    setStatus("Saving…");

    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));

      mutateWorkspaceFileIndex((index) => {
        let next = index;
        for (const note of snapshot.notes) {
          if (note.trashedAt) continue;
          next = upsertWorkspaceFile(next, {
            id: `notes:${note.id}`,
            title: note.title || "Untitled note",
            kind: "notes",
            appHref: `/apps/notes?note=${encodeURIComponent(note.id)}`,
            nativeExtension: ".tmnt",
            nativeMime: TMNOTE_MIME_TYPE,
            sourceId: note.id,
            sizeBytes: new Blob([JSON.stringify(note)]).size,
            storage: "local",
            updatedAt: note.updatedAt,
            lastOpenedAt: note.id === selectedId ? new Date().toISOString() : note.updatedAt
          });
        }
        return next;
      });

      setStatus("Saved locally");
    }, 450);

    return () => window.clearTimeout(timer);
  }, [snapshot, loaded, selectedId]);

  const exportNative = () => {
    if (!selectedNote) return;
    saveEditorHtml();
    const bytes = serializeTamishraNote(selectedNote);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: TMNOTE_MIME_TYPE });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = tamishraNoteFilename(selectedNote.title);
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(".tmnt exported");
  };

  const archiveSelected = () => {
    if (!selectedNote) return;
    updateNote(selectedNote.id, {
      archivedAt: selectedNote.archivedAt ? null : new Date().toISOString()
    });
  };

  const trashSelected = () => {
    if (!selectedNote) return;
    const now = new Date().toISOString();
    updateNote(selectedNote.id, { trashedAt: now });
    mutateWorkspaceFileIndex((index) =>
      trashWorkspaceFile(index, `notes:${selectedNote.id}`)
    );
    setSelectedId(null);
  };

  const restoreSelected = () => {
    if (!selectedNote) return;
    updateNote(selectedNote.id, { trashedAt: null });
    mutateWorkspaceFileIndex((index) =>
      upsertWorkspaceFile(index, {
        id: `notes:${selectedNote.id}`,
        title: selectedNote.title || "Untitled note",
        kind: "notes",
        appHref: `/apps/notes?note=${encodeURIComponent(selectedNote.id)}`,
        nativeExtension: ".tmnt",
        nativeMime: TMNOTE_MIME_TYPE,
        sourceId: selectedNote.id,
        sizeBytes: new Blob([JSON.stringify(selectedNote)]).size,
        storage: "local"
      })
    );
    setView("notes");
    setStatus("Note restored");
  };

  const permanentlyDeleteSelected = () => {
    if (!selectedNote) return;
    if (!window.confirm("Permanently delete this note?")) return;

    const id = selectedNote.id;
    setSnapshot((current) => ({
      ...current,
      notes: current.notes.filter((note) => note.id !== id)
    }));
    mutateWorkspaceFileIndex((index) =>
      permanentlyDeleteWorkspaceFile(index, `notes:${id}`)
    );
    setSelectedId(null);
  };

  const insertChecklist = () => {
    if (!editorRef.current) return;
    editorRef.current.focus();
    applyCommand(
      "insertHTML",
      '<div data-tamishra-checklist="true"><input type="checkbox"> <span>Checklist item</span></div>'
    );
    saveEditorHtml();
  };

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>← Tamishra Workspace</Link>
        <button className={styles.newButton} onClick={createNewNote}>+ New note</button>

        <nav>
          {(["notes", "pinned", "archive", "trash"] as View[]).map((item) => (
            <button
              key={item}
              className={view === item ? styles.active : ""}
              onClick={() => setView(item)}
            >
              {item === "notes"
                ? "All notes"
                : item[0].toUpperCase() + item.slice(1)}
              <span>
                {item === "notes"
                  ? snapshot.notes.filter((note) => !note.trashedAt && !note.archivedAt).length
                  : item === "pinned"
                    ? snapshot.notes.filter((note) => note.pinned && !note.trashedAt && !note.archivedAt).length
                    : item === "archive"
                      ? snapshot.notes.filter((note) => note.archivedAt && !note.trashedAt).length
                      : snapshot.notes.filter((note) => note.trashedAt).length}
              </span>
            </button>
          ))}
        </nav>

        <div className={styles.notebooks}>
          <div className={styles.sideHeading}>
            <span>Notebooks</span>
            <button
              onClick={() => {
                const name = window.prompt("Notebook name");
                if (!name?.trim()) return;
                setSnapshot((current) => ({
                  ...current,
                  notebooks: Array.from(
                    new Set([...current.notebooks, name.trim()])
                  ).sort()
                }));
              }}
            >
              +
            </button>
          </div>
          {snapshot.notebooks.map((notebook) => (
            <button
              key={notebook}
              onClick={() => {
                setView("notes");
                setQuery(notebook);
              }}
            >
              {notebook}
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.listPane}>
        <div className={styles.search}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes, tags, notebooks"
          />
          <button onClick={() => fileInputRef.current?.click()}>Open .tmnt</button>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept=".tmnt,application/vnd.tamishra.note"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void file
                .arrayBuffer()
                .then(importNativeBytes)
                .catch((error) =>
                  setStatus(error instanceof Error ? error.message : "Could not open note")
                );
            }}
          />
        </div>

        <div className={styles.noteList}>
          {visibleNotes.map((note) => (
            <button
              key={note.id}
              className={selectedId === note.id ? styles.selectedNote : ""}
              onClick={() => selectNote(note.id)}
            >
              <div className={styles.noteListTop}>
                <strong>{note.title || "Untitled note"}</strong>
                {note.pinned && <span>★</span>}
              </div>
              <p>{note.plainText || "Empty note"}</p>
              <div className={styles.noteMeta}>
                <span>{note.notebook}</span>
                <span>{new Date(note.updatedAt).toLocaleDateString()}</span>
              </div>
            </button>
          ))}
          {!visibleNotes.length && (
            <div className={styles.emptyList}>No notes in this view.</div>
          )}
        </div>
      </section>

      <section className={styles.editorPane}>
        {selectedNote ? (
          <>
            <header className={styles.editorHeader}>
              <input
                className={styles.title}
                value={selectedNote.title}
                onChange={(event) =>
                  updateNote(selectedNote.id, { title: event.target.value })
                }
                placeholder="Untitled note"
              />
              <div className={styles.headerActions}>
                <button
                  className={selectedNote.pinned ? styles.pinned : ""}
                  onClick={() =>
                    updateNote(selectedNote.id, {
                      pinned: !selectedNote.pinned
                    })
                  }
                >
                  {selectedNote.pinned ? "★ Pinned" : "☆ Pin"}
                </button>
                <button onClick={exportNative}>Export .tmnt</button>
                {view === "trash" ? (
                  <>
                    <button onClick={restoreSelected}>Restore</button>
                    <button className={styles.danger} onClick={permanentlyDeleteSelected}>
                      Delete forever
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={archiveSelected}>
                      {selectedNote.archivedAt ? "Unarchive" : "Archive"}
                    </button>
                    <button className={styles.danger} onClick={trashSelected}>Trash</button>
                  </>
                )}
              </div>
            </header>

            <div className={styles.metadataBar}>
              <label>
                Notebook
                <select
                  value={selectedNote.notebook}
                  onChange={(event) =>
                    updateNote(selectedNote.id, { notebook: event.target.value })
                  }
                >
                  {snapshot.notebooks.map((notebook) => (
                    <option key={notebook} value={notebook}>{notebook}</option>
                  ))}
                </select>
              </label>
              <label className={styles.tags}>
                Tags
                <input
                  value={selectedNote.tags.join(", ")}
                  onChange={(event) =>
                    updateNote(selectedNote.id, {
                      tags: event.target.value
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                        .slice(0, 20)
                    })
                  }
                  placeholder="project, idea, meeting"
                />
              </label>
              <span>{wordCount} words</span>
              <span>{status}</span>
            </div>

            <div className={styles.toolbar}>
              <button onClick={() => applyCommand("bold")}><b>B</b></button>
              <button onClick={() => applyCommand("italic")}><i>I</i></button>
              <button onClick={() => applyCommand("underline")}><u>U</u></button>
              <button onClick={() => applyCommand("formatBlock", "h2")}>H2</button>
              <button onClick={() => applyCommand("insertUnorderedList")}>• List</button>
              <button onClick={() => applyCommand("insertOrderedList")}>1. List</button>
              <button onClick={insertChecklist}>☑ Checklist</button>
              <button
                onClick={() => {
                  const url = window.prompt("Link URL");
                  if (url?.trim()) applyCommand("createLink", url.trim());
                }}
              >
                Link
              </button>
              <button onClick={() => applyCommand("removeFormat")}>Clear</button>
            </div>

            <div
              ref={editorRef}
              className={styles.editor}
              contentEditable={view !== "trash"}
              suppressContentEditableWarning
              onInput={saveEditorHtml}
              onBlur={saveEditorHtml}
              onClick={(event) => {
                const target = event.target;
                if (target instanceof HTMLInputElement && target.type === "checkbox") {
                  if (target.checked) target.setAttribute("checked", "");
                  else target.removeAttribute("checked");
                  saveEditorHtml();
                }
              }}
              spellCheck
            />
          </>
        ) : (
          <div className={styles.emptyEditor}>
            <strong>Select a note or create a new one.</strong>
            <button onClick={createNewNote}>Create note</button>
          </div>
        )}
      </section>
    </main>
  );
}
