"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createId,
  createPageConfig,
  defaultHeaderFooterSettings,
  type HeaderFooterAlignment,
  type HeaderFooterSettings,
  type PageConfig
} from "@tamishra/document-model";
import {
  addDocsComment,
  addDocsShareGrant,
  addDocsSuggestion,
  addDocsVersion,
  calculateDocsProofingStats,
  createDocsFolder,
  createDraftFromHtml,
  createTamishraDocumentPackage,
  duplicateDocsRecord,
  exportDocsDocx,
  extractDocsOutline,
  importDocsDocx,
  loadDocsWorkspace,
  mergeDocsWorkspaces,
  migrateLegacyDraft,
  mmToCssPx,
  moveDocsRecordToFolder,
  parseTamishraDocument,
  permanentlyDeleteDocsRecord,
  registerDocsDocxAdapter,
  removeDocsShareGrant,
  restoreDocsRecord,
  saveDocsWorkspace,
  serializeTamishraDocument,
  tamishraDocumentFilename,
  TMDOC_MIME_TYPE,
  trashDocsRecord,
  updateDocsComment,
  updateDocsSuggestion,
  updateDraft,
  upsertDocsRecord,
  type DocsEditingMode,
  type DocsLibraryRecord,
  type DocsOutlineEntry,
  type DocsProofingStats,
  type DocsVersion,
  type DocsWorkspaceSnapshot,
  type PersistedDocsDraft
} from "@tamishra/docs-engine";
import { TransactionHistory } from "@tamishra/history";
import {
  permanentlyDeleteWorkspaceFile,
  restoreWorkspaceFile,
  trashWorkspaceFile,
  upsertWorkspaceFile
} from "@tamishra/file-core";
import HeaderFooterSettingsPanel from "./HeaderFooterSettings";
import PageSettings from "./PageSettings";
import DocsProductionPanel, { type DocsPanelTab } from "./DocsProductionPanel";
import { browserDocsDocxAdapter } from "./docx-browser";
import {
  pullDocsCloudWorkspace,
  pushDocsCloudWorkspace
} from "./docs-cloud";
import { consumeNativeFileHandoff } from "../../../lib/native-file-handoff";
import { mutateWorkspaceFileIndex } from "../../../lib/workspace-files";

const STORAGE_KEY = "tamishra.docs.current.v2";
const LEGACY_STORAGE_KEY = "tamishra.docs.current";
const CURRENT_DOCUMENT_ID_KEY = "tamishra.docs.current-id";

type SavedDocument = {
  title: string;
  html: string;
  updatedAt: string;
};

function applyCommand(command: string, value?: string) {
  document.execCommand(command, false, value);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function chromeTextToHtml(value: string) {
  const trimmed = value.trim();
  return trimmed ? `<p>${escapeHtml(trimmed)}</p>` : "";
}

function chromeHtmlToText(value?: string) {
  if (!value) return "";
  const container = document.createElement("div");
  container.innerHTML = value;
  return container.innerText.trim();
}

export default function DocsEditor() {
  const editorRef = useRef<HTMLDivElement>(null);
  const pageEditorsRef = useRef<Array<HTMLDivElement | null>>([]);
  const activePageRef = useRef(0);
  const reflowFrameRef = useRef<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const docxInputRef = useRef<HTMLInputElement>(null);
  const selectedTableCellRef = useRef<HTMLTableCellElement | null>(null);
  const draftRef = useRef<PersistedDocsDraft | null>(null);
  const workspaceRef = useRef<DocsWorkspaceSnapshot>(loadDocsWorkspace());
  const currentDocumentIdRef = useRef<string | null>(null);
  const collaborationChannelRef = useRef<BroadcastChannel | null>(null);
  const collaborationClientIdRef = useRef(createId("client"));
  const cloudRevisionRef = useRef<number | null>(null);
  const cloudHydratedRef = useRef(false);
  const cloudAuthenticatedRef = useRef(false);
  const pageHistoryRef = useRef(new TransactionHistory<PageConfig>(100));
  const [title, setTitle] = useState("Untitled document");
  const [page, setPage] = useState<PageConfig>(() => createPageConfig());
  const [savedState, setSavedState] = useState("Saved locally");
  const [zoom, setZoom] = useState(100);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [activePage, setActivePage] = useState(1);
  const [fontSize, setFontSize] = useState("3");
  const [textColor, setTextColor] = useState("#202939");
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedImageWidth, setSelectedImageWidth] = useState(320);
  const [selectedImageAlt, setSelectedImageAlt] = useState("");
  const [selectedImageLayout, setSelectedImageLayout] = useState("inline");
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [findStatus, setFindStatus] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [footerText, setFooterText] = useState("");
  const [headerFooter, setHeaderFooter] = useState<HeaderFooterSettings>(() => ({
    ...defaultHeaderFooterSettings
  }));
  const [workspace, setWorkspace] = useState<DocsWorkspaceSnapshot>(() => workspaceRef.current);
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<DocsPanelTab | null>(null);
  const [outline, setOutline] = useState<DocsOutlineEntry[]>([]);
  const [proofing, setProofing] = useState<DocsProofingStats>(() =>
    calculateDocsProofingStats("")
  );
  const [editingMode, setEditingMode] = useState<DocsEditingMode>("editing");
  const [language, setLanguage] = useState("en-US");
  const [spellcheck, setSpellcheck] = useState(true);
  const [tableActive, setTableActive] = useState(false);
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [cloudStatus, setCloudStatus] = useState("Local");

  const commitWorkspace = (next: DocsWorkspaceSnapshot) => {
    workspaceRef.current = next;
    setWorkspace(next);
    saveDocsWorkspace(next);
  };

  const selectDocumentId = (id: string | null) => {
    currentDocumentIdRef.current = id;
    setCurrentDocumentId(id);

    if (id) {
      localStorage.setItem(CURRENT_DOCUMENT_ID_KEY, id);
    } else {
      localStorage.removeItem(CURRENT_DOCUMENT_ID_KEY);
    }
  };

  const currentComments = workspace.comments.filter(
    (item) => item.documentId === currentDocumentId
  );
  const currentVersions = workspace.versions.filter(
    (item) => item.documentId === currentDocumentId
  );
  const currentGrants = workspace.grants.filter(
    (item) => item.documentId === currentDocumentId
  );
  const currentSuggestions = workspace.suggestions.filter(
    (item) => item.documentId === currentDocumentId
  );

  const getEditors = () =>
    pageEditorsRef.current.filter(
      (editor): editor is HTMLDivElement => Boolean(editor)
    );

  const getDocumentHtml = () =>
    getEditors().map((editor) => editor.innerHTML).join("");

  const getDocumentText = () =>
    getEditors().map((editor) => editor.innerText).join("\n");

  const queryDocument = <T extends Element = Element>(selector: string): T | null => {
    for (const editor of getEditors()) {
      const match = editor.querySelector<T>(selector);
      if (match) return match;
    }
    return null;
  };

  const queryDocumentAll = (selector: string): Element[] =>
    getEditors().flatMap((editor) => Array.from(editor.querySelectorAll(selector)));

  const focusEditor = () => {
    const active = pageEditorsRef.current[activePageRef.current] ?? pageEditorsRef.current[0];
    if (active) {
      editorRef.current = active;
      active.focus();
    }
  };

  const setActiveEditor = (index: number, editor: HTMLDivElement | null) => {
    pageEditorsRef.current[index] = editor;

    if (editor && (!editorRef.current || index === activePageRef.current)) {
      editorRef.current = editor;
    }
  };

  const pageOverflows = (editor: HTMLDivElement) =>
    editor.scrollHeight > editor.clientHeight + 1;

  const prependNodes = (target: HTMLDivElement, nodes: Node[]) => {
    const anchor = target.firstChild;
    nodes.forEach((node) => target.insertBefore(node, anchor));
  };

  const splitOversizedTextBlock = (
    block: HTMLElement,
    editor: HTMLDivElement,
    nextEditor: HTMLDivElement
  ) => {
    const splittable = new Set(["P", "DIV", "BLOCKQUOTE", "H1", "H2", "H3", "H4"]);
    const text = block.textContent ?? "";

    if (!splittable.has(block.tagName) || text.length < 40) return false;

    const ratio = Math.max(
      0.12,
      Math.min(0.88, (editor.clientHeight / Math.max(editor.scrollHeight, 1)) * 0.92)
    );
    let splitOffset = Math.floor(text.length * ratio);

    while (splitOffset > 12 && !/\s/.test(text.charAt(splitOffset))) {
      splitOffset -= 1;
    }

    if (splitOffset <= 12 || splitOffset >= text.length - 8) return false;

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let textNode = walker.nextNode() as Text | null;
    let splitNode: Text | null = null;
    let localOffset = 0;

    while (textNode) {
      const length = textNode.data.length;
      if (consumed + length >= splitOffset) {
        splitNode = textNode;
        localOffset = Math.max(0, splitOffset - consumed);
        break;
      }
      consumed += length;
      textNode = walker.nextNode() as Text | null;
    }

    if (!splitNode) return false;

    const range = document.createRange();
    range.setStart(splitNode, localOffset);
    range.setEnd(block, block.childNodes.length);

    const tailContent = range.extractContents();
    const tail = block.cloneNode(false) as HTMLElement;
    tail.dataset.tamishraId = createId(block.tagName.toLowerCase());
    tail.appendChild(tailContent);

    if (!tail.textContent?.trim()) return false;

    nextEditor.insertBefore(tail, nextEditor.firstChild);
    return true;
  };

  const updateActivePageFromSelection = () => {
    const anchor = window.getSelection()?.anchorNode;
    if (!anchor) return;

    const index = pageEditorsRef.current.findIndex(
      (editor) => Boolean(editor?.contains(anchor))
    );

    if (index >= 0) {
      activePageRef.current = index;
      setActivePage(index + 1);
      editorRef.current = pageEditorsRef.current[index];
    }
  };

  const rebalancePages = () => {
    const editors = getEditors();
    if (!editors.length) return;

    for (let index = 0; index < editors.length; index += 1) {
      const editor = editors[index];

      const manualBreak = Array.from(editor.children).find(
        (child) => (child as HTMLElement).dataset.pageBreak === "true"
      ) as HTMLElement | undefined;

      if (manualBreak && manualBreak.nextSibling) {
        const nextEditor = pageEditorsRef.current[index + 1];
        if (!nextEditor) {
          setPageCount((count) => Math.max(count, index + 2));
          scheduleReflow();
          return;
        }

        const afterBreak: Node[] = [];
        let node: ChildNode | null = manualBreak.nextSibling;
        while (node) {
          const followingSibling: ChildNode | null = node.nextSibling;
          afterBreak.push(node);
          node = followingSibling;
        }
        prependNodes(nextEditor, afterBreak);
      }

      let guard = 0;
      while (pageOverflows(editor) && guard < 250) {
        guard += 1;

        let nextEditor = pageEditorsRef.current[index + 1];
        if (!nextEditor) {
          setPageCount((count) => Math.max(count, index + 2));
          scheduleReflow();
          return;
        }

        const children = Array.from(editor.children);
        if (!children.length) break;

        if (children.length === 1) {
          const onlyChild = children[0] as HTMLElement;
          if (!splitOversizedTextBlock(onlyChild, editor, nextEditor)) {
            onlyChild.dataset.paginationOverflow = "true";
            break;
          }
          continue;
        }

        let candidate = editor.lastElementChild as HTMLElement | null;
        if (candidate?.dataset.pageBreak === "true") {
          candidate = candidate.previousElementSibling as HTMLElement | null;
        }
        if (!candidate) break;

        candidate.removeAttribute("data-pagination-overflow");
        nextEditor.insertBefore(candidate, nextEditor.firstChild);
      }
    }

    const refreshed = getEditors();

    for (let index = 0; index < refreshed.length - 1; index += 1) {
      const editor = refreshed[index];
      const nextEditor = refreshed[index + 1];
      const hasManualBreak = Array.from(editor.children).some(
        (child) => (child as HTMLElement).dataset.pageBreak === "true"
      );

      if (hasManualBreak) continue;

      let guard = 0;
      while (nextEditor.firstElementChild && guard < 250) {
        guard += 1;
        const candidate = nextEditor.firstElementChild as HTMLElement;

        editor.appendChild(candidate);
        if (pageOverflows(editor)) {
          nextEditor.insertBefore(candidate, nextEditor.firstChild);
          break;
        }
      }
    }

    let lastUsed = Math.max(0, pageEditorsRef.current.length - 1);
    while (lastUsed > 0) {
      const editor = pageEditorsRef.current[lastUsed];
      if (editor && (editor.childNodes.length > 0 || editor.innerText.trim())) break;
      lastUsed -= 1;
    }

    const desiredCount = Math.max(1, lastUsed + 1);
    if (desiredCount !== pageCount) {
      setPageCount(desiredCount);

      if (activePageRef.current >= desiredCount) {
        const nextActiveIndex = desiredCount - 1;
        activePageRef.current = nextActiveIndex;
        setActivePage(desiredCount);
        editorRef.current = pageEditorsRef.current[nextActiveIndex];
      }
    }

    ensureBlockIds();
    updateActivePageFromSelection();

    const text = getDocumentText();
    const trimmed = text.trim();
    setCharCount(text.length);
    setWordCount(trimmed ? trimmed.split(/\s+/).length : 0);
    setSavedState("Saving…");
  };

  const scheduleReflow = () => {
    if (reflowFrameRef.current !== null) {
      cancelAnimationFrame(reflowFrameRef.current);
    }

    reflowFrameRef.current = requestAnimationFrame(() => {
      reflowFrameRef.current = null;
      rebalancePages();
    });
  };

  const ensureBlockIds = () => {
    const editors = getEditors();
    if (!editors.length) return;

    const assign = (element: Element, prefix: string) => {
      if (element instanceof HTMLElement && !element.dataset.tamishraId) {
        element.dataset.tamishraId = createId(prefix);
      }
    };

    editors.forEach((editor) => {
      Array.from(editor.children).forEach((element) => assign(element, "block"));
      editor
        .querySelectorAll("a, img, hr, ul, ol, li, table, tr, th, td, [data-page-break]")
        .forEach((element) => assign(element, element.tagName.toLowerCase()));
    });
  };

  const saveDocument = () => {
    ensureBlockIds();
    const html = getDocumentHtml();
    const safeTitle = title.trim() || "Untitled document";
    const nextDraft = draftRef.current
      ? updateDraft(draftRef.current, {
          title: safeTitle,
          editorHtml: html,
          page,
          headerHtml: chromeTextToHtml(headerText),
          footerHtml: chromeTextToHtml(footerText),
          headerFooter
        })
      : createDraftFromHtml(safeTitle, html, page, {
          headerHtml: chromeTextToHtml(headerText),
          footerHtml: chromeTextToHtml(footerText),
          headerFooter
        });

    draftRef.current = nextDraft;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDraft));
    localStorage.removeItem(LEGACY_STORAGE_KEY);

    const result = upsertDocsRecord(workspaceRef.current, {
      id: currentDocumentIdRef.current ?? undefined,
      title: safeTitle,
      draft: nextDraft
    });
    commitWorkspace(result.snapshot);

    if (currentDocumentIdRef.current !== result.record.id) {
      selectDocumentId(result.record.id);
    }

    mutateWorkspaceFileIndex((index) =>
      upsertWorkspaceFile(index, {
        id: `docs:${result.record.id}`,
        title: safeTitle,
        kind: "docs",
        appHref: "/apps/docs",
        nativeExtension: ".tmdoc",
        nativeMime: TMDOC_MIME_TYPE,
        sourceId: result.record.id,
        sizeBytes: new Blob([JSON.stringify(nextDraft)]).size,
        storage: cloudAuthenticatedRef.current ? "cloud" : "local"
      })
    );

    setSavedState("Saved locally");

    collaborationChannelRef.current?.postMessage({
      type: "document",
      source: collaborationClientIdRef.current,
      documentId: result.record.id,
      draft: nextDraft
    });

    return nextDraft;
  };

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);

    try {
      let draft: PersistedDocsDraft | null = null;
      const storedDocumentId = localStorage.getItem(CURRENT_DOCUMENT_ID_KEY);
      const workspaceSnapshot = loadDocsWorkspace();
      workspaceRef.current = workspaceSnapshot;
      setWorkspace(workspaceSnapshot);

      if (storedDocumentId) {
        const libraryRecord = workspaceSnapshot.records.find(
          (item) => item.id === storedDocumentId && !item.trashedAt
        );
        if (libraryRecord) {
          draft = libraryRecord.draft;
          selectDocumentId(libraryRecord.id);
        }
      }

      if (!draft && raw) {
        draft = JSON.parse(raw) as PersistedDocsDraft;
      } else if (!draft && legacyRaw) {
        const legacy = JSON.parse(legacyRaw) as SavedDocument;
        draft = migrateLegacyDraft(legacy);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }

      const firstEditor = pageEditorsRef.current[0];

      if (!draft) {
        if (firstEditor && !firstEditor.innerHTML.trim()) {
          firstEditor.innerHTML =
            "<h1>Untitled document</h1><p>Start writing here. Tamishra Docs now supports real multi-page document flow, autosave, formatting and print/PDF output.</p>";
        }
        ensureBlockIds();
        updateCounts();
        scheduleReflow();
        return;
      }

      draftRef.current = draft;
      setTitle(draft.document.title || "Untitled document");
      const section = draft.document.sections[0];
      setPage(section?.page ?? createPageConfig());
      setHeaderText(chromeHtmlToText(draft.headerHtml));
      setFooterText(chromeHtmlToText(draft.footerHtml));
      setHeaderFooter({
        ...defaultHeaderFooterSettings,
        ...(section?.headerFooter ?? {})
      });

      if (firstEditor && draft.editorHtml) {
        firstEditor.innerHTML = draft.editorHtml;
        ensureBlockIds();
      }

      updateCounts();
      setSavedState("Recovered local draft");
      scheduleReflow();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      updateCounts();
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveDocument();
    }, 700);

    return () => window.clearTimeout(timer);
  }, [title, wordCount, charCount, page, headerText, footerText, headerFooter]);

  useEffect(() => {
    updateCounts();
    scheduleReflow();
  }, [page, pageCount]);

  useEffect(() => {
    return () => {
      if (reflowFrameRef.current !== null) {
        cancelAnimationFrame(reflowFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    registerDocsDocxAdapter(browserDocsDocxAdapter);
  }, []);

  useEffect(() => {
    const createRequest = sessionStorage.getItem("tamishra.workspace.create");
    if (createRequest === "docs") {
      sessionStorage.removeItem("tamishra.workspace.create");
      window.setTimeout(() => handleNewDocument(), 0);
      return;
    }

    void consumeNativeFileHandoff()
      .then(async (handoff) => {
        if (!handoff) return;
        const name = handoff.name.toLowerCase();

        if (name.endsWith(".tmdoc")) {
          importNativePackage(handoff.bytes, ".tmdoc opened from Workspace");
          return;
        }

        if (name.endsWith(".docx")) {
          await importDocxBytes(handoff.bytes, handoff.name);
        }
      })
      .catch((error) => {
        console.error("Workspace Docs handoff failed", error);
        setSavedState("Workspace file could not be opened");
      });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let cancelled = false;

    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("startup_tmdoc"))
      .then((raw) => {
        if (cancelled || !raw) return;
        importNativePackage(new TextEncoder().encode(raw), ".tmdoc opened from desktop");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Could not open startup .tmdoc", error);
        setSavedState("Startup .tmdoc could not be opened");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void pullDocsCloudWorkspace()
      .then((remote) => {
        if (cancelled) return;

        cloudHydratedRef.current = true;
        if (!remote) {
          cloudAuthenticatedRef.current = false;
          setCloudStatus("Local");
          return;
        }

        cloudAuthenticatedRef.current = true;
        cloudRevisionRef.current = remote.revision;
        const merged = mergeDocsWorkspaces(workspaceRef.current, remote.workspace);
        commitWorkspace(merged);
        setCloudStatus("Cloud synced");
      })
      .catch(() => {
        if (cancelled) return;
        cloudHydratedRef.current = true;
        cloudAuthenticatedRef.current = false;
        setCloudStatus("Offline");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!cloudHydratedRef.current || !cloudAuthenticatedRef.current) return;

    setCloudStatus("Cloud saving…");
    const timer = window.setTimeout(() => {
      void pushDocsCloudWorkspace(workspace, cloudRevisionRef.current)
        .then((saved) => {
          if (!saved) {
            cloudAuthenticatedRef.current = false;
            setCloudStatus("Local");
            return;
          }
          cloudRevisionRef.current = saved.revision;
          setCloudStatus("Cloud synced");
        })
        .catch(async (error) => {
          if ((error as { status?: number }).status === 409) {
            try {
              const remote = await pullDocsCloudWorkspace();
              if (remote) {
                cloudRevisionRef.current = remote.revision;
                const merged = mergeDocsWorkspaces(workspaceRef.current, remote.workspace);
                commitWorkspace(merged);
                setCloudStatus("Cloud merged");
                return;
              }
            } catch {
              // Fall through to offline state.
            }
          }
          setCloudStatus("Offline");
        });
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [workspace]);

  useEffect(() => {
    collaborationChannelRef.current?.close();
    collaborationChannelRef.current = null;
    setCollaborators([]);

    if (!currentDocumentId || typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(`tamishra-docs-${currentDocumentId}`);
    collaborationChannelRef.current = channel;
    const peers = new Map<string, string>();

    const publishPresence = () => {
      channel.postMessage({
        type: "presence",
        source: collaborationClientIdRef.current,
        name: "Collaborator",
        documentId: currentDocumentId
      });
    };

    channel.onmessage = (event) => {
      const message = event.data as {
        type?: string;
        source?: string;
        name?: string;
        documentId?: string;
        draft?: PersistedDocsDraft;
      };

      if (!message.source || message.source === collaborationClientIdRef.current) return;
      if (message.documentId !== currentDocumentId) return;

      if (message.type === "presence") {
        peers.set(message.source, message.name || "Collaborator");
        setCollaborators(Array.from(peers.values()));
        return;
      }

      if (message.type === "leave") {
        peers.delete(message.source);
        setCollaborators(Array.from(peers.values()));
        return;
      }

      if (message.type === "document" && message.draft) {
        const focused = getEditors().some((editor) => editor.contains(document.activeElement));
        const localTimestamp = draftRef.current?.updatedAt ?? "";
        if (!focused && message.draft.updatedAt > localTimestamp) {
          applyDraftToEditor(message.draft, currentDocumentId, "Live update received");
        }
      }
    };

    publishPresence();
    const heartbeat = window.setInterval(publishPresence, 5000);

    return () => {
      window.clearInterval(heartbeat);
      channel.postMessage({
        type: "leave",
        source: collaborationClientIdRef.current,
        documentId: currentDocumentId
      });
      channel.close();
      if (collaborationChannelRef.current === channel) {
        collaborationChannelRef.current = null;
      }
    };
  }, [currentDocumentId]);

  const applyDraftToEditor = (
    draft: PersistedDocsDraft,
    documentId: string | null,
    status = "Document opened"
  ) => {
    const editors = getEditors();
    editors.forEach((editor) => {
      editor.innerHTML = "";
    });

    const firstEditor = pageEditorsRef.current[0];
    if (firstEditor) {
      firstEditor.innerHTML = draft.editorHtml || "<p><br></p>";
    }

    draftRef.current = draft;
    selectDocumentId(documentId);
    setTitle(draft.document.title || "Untitled document");
    const section = draft.document.sections[0];
    setPage(section?.page ?? createPageConfig());
    setHeaderText(chromeHtmlToText(draft.headerHtml));
    setFooterText(chromeHtmlToText(draft.footerHtml));
    setHeaderFooter({
      ...defaultHeaderFooterSettings,
      ...(section?.headerFooter ?? {})
    });
    setPageCount(1);
    activePageRef.current = 0;
    setActivePage(1);
    setSelectedImageId(null);
    selectedTableCellRef.current = null;
    setTableActive(false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    ensureBlockIds();
    updateCounts();
    setSavedState(status);
    scheduleReflow();
  };

  const handleNewDocument = () => {
    if (draftRef.current || getDocumentText().trim()) {
      saveDocument();
    }

    const draft = createDraftFromHtml(
      "Untitled document",
      "<h1>Untitled document</h1><p><br></p>",
      createPageConfig(),
      {
        headerHtml: "",
        footerHtml: "",
        headerFooter: { ...defaultHeaderFooterSettings }
      }
    );
    applyDraftToEditor(draft, null, "New document");
    setActivePanel("files");
  };

  const handleSaveAs = () => {
    const source = saveDocument();
    const requested = window.prompt(
      "Save document as",
      title.trim() ? `${title.trim()} copy` : "Untitled document copy"
    );
    if (!requested?.trim()) return;

    const draft = updateDraft(source, { title: requested.trim() });
    const result = upsertDocsRecord(workspaceRef.current, {
      title: requested.trim(),
      draft
    });
    commitWorkspace(result.snapshot);
    applyDraftToEditor(draft, result.record.id, "Saved as new document");
  };

  const handleOpenRecord = (record: DocsLibraryRecord) => {
    if (currentDocumentIdRef.current !== record.id) {
      saveDocument();
    }

    const next = {
      ...workspaceRef.current,
      records: workspaceRef.current.records.map((item) =>
        item.id === record.id
          ? { ...item, lastOpenedAt: new Date().toISOString() }
          : item
      )
    };
    commitWorkspace(next);
    applyDraftToEditor(record.draft, record.id);
  };

  const handleDuplicateRecord = (id: string) => {
    const result = duplicateDocsRecord(workspaceRef.current, id);
    commitWorkspace(result.snapshot);
    if (result.record) applyDraftToEditor(result.record.draft, result.record.id, "Document duplicated");
  };

  const handleTrashRecord = (id: string) => {
    const next = trashDocsRecord(workspaceRef.current, id);
    commitWorkspace(next);
    mutateWorkspaceFileIndex((index) => trashWorkspaceFile(index, `docs:${id}`));

    if (currentDocumentIdRef.current === id) {
      handleNewDocument();
    }
  };

  const handleRestoreRecord = (id: string) => {
    commitWorkspace(restoreDocsRecord(workspaceRef.current, id));
    mutateWorkspaceFileIndex((index) => restoreWorkspaceFile(index, `docs:${id}`));
  };

  const handleDeleteRecordForever = (id: string) => {
    if (!window.confirm("Permanently delete this document and its versions/comments?")) return;
    commitWorkspace(permanentlyDeleteDocsRecord(workspaceRef.current, id));
    mutateWorkspaceFileIndex((index) =>
      permanentlyDeleteWorkspaceFile(index, `docs:${id}`)
    );
  };

  const handleSuggestReplacement = () => {
    let documentId = currentDocumentIdRef.current;
    if (!documentId) {
      saveDocument();
      documentId = currentDocumentIdRef.current;
    }
    if (!documentId) return;

    const context = selectionContext();
    if (!context || context.range.collapsed || !context.text.trim()) {
      setSavedState("Select text to suggest a replacement");
      return;
    }

    const replacement = window.prompt("Suggested replacement", context.text);
    if (replacement === null || replacement === context.text) return;

    const result = addDocsSuggestion(workspaceRef.current, {
      documentId,
      kind: "insert",
      blockId: context.blockId,
      beforeText: context.text,
      afterText: replacement,
      authorId: "local-user",
      authorName: "You"
    });
    commitWorkspace(result.snapshot);

    const del = document.createElement("del");
    del.dataset.suggestionId = result.suggestion.id;
    del.className = "docsSuggestionDelete";
    const ins = document.createElement("ins");
    ins.dataset.suggestionId = result.suggestion.id;
    ins.className = "docsSuggestionInsert";
    ins.textContent = replacement;

    const contents = context.range.extractContents();
    del.appendChild(contents);
    context.range.insertNode(ins);
    context.range.insertNode(del);
    context.selection.removeAllRanges();
    updateCounts();
    scheduleReflow();
  };

  const unwrapElement = (element: HTMLElement) => {
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
  };

  const handleResolveSuggestion = (
    suggestionId: string,
    status: "accepted" | "rejected"
  ) => {
    const nodes = queryDocumentAll(
      `[data-suggestion-id="${CSS.escape(suggestionId)}"]`
    ) as HTMLElement[];
    const deletion = nodes.find((node) => node.tagName.toLowerCase() === "del");
    const insertion = nodes.find((node) => node.tagName.toLowerCase() === "ins");

    if (status === "accepted") {
      deletion?.remove();
      if (insertion) unwrapElement(insertion);
    } else {
      insertion?.remove();
      if (deletion) unwrapElement(deletion);
    }

    commitWorkspace(updateDocsSuggestion(workspaceRef.current, suggestionId, status));
    updateCounts();
    scheduleReflow();
  };

  const createVersionSnapshot = (label?: string) => {
    const draft = saveDocument();
    const documentId = currentDocumentIdRef.current;
    if (!documentId) return;

    const result = addDocsVersion(workspaceRef.current, {
      documentId,
      authorId: "local-user",
      authorName: "You",
      label: label || null,
      reason: "manual-save",
      draft
    });
    commitWorkspace(result.snapshot);
    setSavedState("Version saved");
  };

  const restoreVersionSnapshot = (version: DocsVersion) => {
    if (!window.confirm("Restore this version as the current document?")) return;

    const before = saveDocument();
    const documentId = currentDocumentIdRef.current;
    if (documentId) {
      const backup = addDocsVersion(workspaceRef.current, {
        documentId,
        authorId: "local-user",
        authorName: "You",
        label: "Before restore",
        reason: "restore",
        draft: before
      });
      commitWorkspace(backup.snapshot);
    }

    applyDraftToEditor(version.draft, version.documentId, "Version restored");
    saveDocument();
  };

  const handleCreateFolder = (name: string) => {
    const result = createDocsFolder(workspaceRef.current, name);
    commitWorkspace(result.snapshot);
  };

  const handleMoveCurrentToFolder = (folderId: string | null) => {
    const documentId = currentDocumentIdRef.current;
    if (!documentId) return;
    commitWorkspace(
      moveDocsRecordToFolder(workspaceRef.current, documentId, folderId)
    );
  };

  const importNativePackage = (
    input: ArrayBuffer | Uint8Array,
    successStatus = ".tmdoc opened"
  ) => {
    const packageData = parseTamishraDocument(input);
    const record = {
      ...packageData.record,
      lastOpenedAt: new Date().toISOString(),
      trashedAt: null
    };

    const current = workspaceRef.current;
    const next: DocsWorkspaceSnapshot = {
      ...current,
      records: [
        record,
        ...current.records.filter((item) => item.id !== record.id)
      ],
      comments: [
        ...packageData.comments,
        ...current.comments.filter((item) => item.documentId !== record.id)
      ],
      suggestions: [
        ...packageData.suggestions,
        ...current.suggestions.filter((item) => item.documentId !== record.id)
      ],
      versions: [
        ...packageData.versions,
        ...current.versions.filter((item) => item.documentId !== record.id)
      ].slice(0, 100),
      grants: [
        ...packageData.grants,
        ...current.grants.filter((item) => item.documentId !== record.id)
      ]
    };

    commitWorkspace(next);
    applyDraftToEditor(record.draft, record.id, successStatus);
  };

  const handleNativeInput = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      setSavedState("Opening .tmdoc…");
      importNativePackage(await file.arrayBuffer());
    } catch (error) {
      setSavedState("Could not open .tmdoc");
      window.alert(
        error instanceof Error
          ? error.message
          : "Could not open the Tamishra document."
      );
    }
  };

  const handleExportNative = () => {
    try {
      const draft = saveDocument();
      const documentId = currentDocumentIdRef.current;
      if (!documentId) return;

      const record =
        workspaceRef.current.records.find((item) => item.id === documentId) ??
        upsertDocsRecord(workspaceRef.current, {
          id: documentId,
          title: title.trim() || "Untitled document",
          draft
        }).record;

      const packageData = createTamishraDocumentPackage({
        record: { ...record, draft },
        comments: workspaceRef.current.comments.filter(
          (item) => item.documentId === documentId
        ),
        suggestions: workspaceRef.current.suggestions.filter(
          (item) => item.documentId === documentId
        ),
        versions: workspaceRef.current.versions.filter(
          (item) => item.documentId === documentId
        ),
        grants: workspaceRef.current.grants.filter(
          (item) => item.documentId === documentId
        )
      });

      const bytes = serializeTamishraDocument(packageData);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const blob = new Blob([buffer], { type: TMDOC_MIME_TYPE });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = tamishraDocumentFilename(
        title.trim() || "Untitled document"
      );
      anchor.click();
      URL.revokeObjectURL(href);
      setSavedState(".tmdoc exported");
    } catch (error) {
      setSavedState(".tmdoc export failed");
      window.alert(
        error instanceof Error
          ? error.message
          : "Could not export the Tamishra document."
      );
    }
  };

  const importDocxBytes = async (bytes: ArrayBuffer, fileName: string) => {
    setSavedState("Importing DOCX…");
    const result = await importDocsDocx(bytes);
    const name = fileName.replace(/\.docx$/i, "") || "Imported document";
    const draft = createDraftFromHtml(name, result.html, page, {
      headerHtml: "",
      footerHtml: "",
      headerFooter
    });
    const recordResult = upsertDocsRecord(workspaceRef.current, {
      title: name,
      draft
    });
    commitWorkspace(recordResult.snapshot);
    applyDraftToEditor(
      draft,
      recordResult.record.id,
      result.warnings.length
        ? `Imported with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`
        : "DOCX imported"
    );

    const versionResult = addDocsVersion(workspaceRef.current, {
      documentId: recordResult.record.id,
      authorId: "local-user",
      authorName: "You",
      label: "DOCX import",
      reason: "import",
      draft
    });
    commitWorkspace(versionResult.snapshot);
    saveDocument();
  };

  const handleDocxInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      await importDocxBytes(await file.arrayBuffer(), file.name);
    } catch (error) {
      setSavedState("DOCX import failed");
      window.alert(error instanceof Error ? error.message : "Could not import DOCX.");
    }
  };

  const handleExportDocx = async () => {
    try {
      saveDocument();
      setSavedState("Creating DOCX…");
      const blob = await exportDocsDocx({
        title: title.trim() || "Untitled document",
        html: getDocumentHtml(),
        headerText,
        footerText
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${(title.trim() || "document").replace(/[^a-z0-9-_]+/gi, "-")}.docx`;
      anchor.click();
      URL.revokeObjectURL(href);
      setSavedState("DOCX exported");
    } catch (error) {
      setSavedState("DOCX export failed");
      window.alert(error instanceof Error ? error.message : "Could not export DOCX.");
    }
  };

  const selectionContext = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const editor = getEditors().find((item) => item.contains(range.commonAncestorContainer));
    if (!editor) return null;

    const parent =
      range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const block = parent?.closest<HTMLElement>("[data-tamishra-id]") ?? null;

    return {
      selection,
      range,
      text: selection.toString(),
      blockId: block?.dataset.tamishraId ?? null
    };
  };

  const handleAddComment = () => {
    const documentId = currentDocumentIdRef.current;
    if (!documentId) {
      saveDocument();
    }
    const id = currentDocumentIdRef.current;
    if (!id) return;

    const context = selectionContext();
    const body = window.prompt("Comment");
    if (!body?.trim()) return;

    const result = addDocsComment(workspaceRef.current, {
      documentId: id,
      blockId: context?.blockId ?? null,
      quotedText: context?.text ?? "",
      body: body.trim(),
      authorId: "local-user",
      authorName: "You"
    });
    commitWorkspace(result.snapshot);

    if (context && !context.range.collapsed) {
      const marker = document.createElement("span");
      marker.dataset.commentId = result.comment.id;
      marker.className = "docsCommentAnchor";
      try {
        context.range.surroundContents(marker);
      } catch {
        const contents = context.range.extractContents();
        marker.appendChild(contents);
        context.range.insertNode(marker);
      }
      context.selection.removeAllRanges();
      updateCounts();
    }
  };

  const handleReplyComment = (commentId: string, body: string) => {
    const next = updateDocsComment(workspaceRef.current, commentId, (comment) => {
      comment.replies.push({
        id: createId("reply"),
        authorId: "local-user",
        authorName: "You",
        body,
        createdAt: new Date().toISOString()
      });
    });
    commitWorkspace(next);
  };

  const handleToggleResolveComment = (commentId: string) => {
    const next = updateDocsComment(workspaceRef.current, commentId, (comment) => {
      comment.resolvedAt = comment.resolvedAt ? null : new Date().toISOString();
    });
    commitWorkspace(next);
  };

  const handleAddGrant = (
    principal: string,
    role: "editor" | "commenter" | "viewer"
  ) => {
    const documentId = currentDocumentIdRef.current;
    if (!documentId) return;
    commitWorkspace(
      addDocsShareGrant(workspaceRef.current, {
        documentId,
        principal,
        role
      })
    );
  };

  const handleRemoveGrant = (grantId: string) => {
    commitWorkspace(removeDocsShareGrant(workspaceRef.current, grantId));
  };

  const refreshDocumentMetadata = () => {
    const editors = getEditors();
    const nextOutline = editors.flatMap((editor) => extractDocsOutline(editor));
    setOutline(nextOutline);

    const text = getDocumentText();
    const stats = calculateDocsProofingStats(text);
    setProofing({
      ...stats,
      paragraphs: queryDocumentAll("p, li, blockquote").length,
      headings: queryDocumentAll("h1, h2, h3, h4").length
    });
  };

  const handleGoToOutline = (entry: DocsOutlineEntry) => {
    const target = queryDocument<HTMLElement>(
      `[data-tamishra-id="${CSS.escape(entry.blockId)}"]`
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus?.();
  };

  const selectedParagraphBlock = () => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    if (!anchor) return null;
    const element = anchor instanceof HTMLElement ? anchor : anchor.parentElement;
    return element?.closest<HTMLElement>(
      "p, div, blockquote, h1, h2, h3, h4, li, td, th"
    ) ?? null;
  };

  const applyInlineSelectionStyle = (property: string, value: string) => {
    const context = selectionContext();
    if (!context || context.range.collapsed) {
      setSavedState("Select text to format");
      return;
    }

    const span = document.createElement("span");
    span.style.setProperty(property, value);
    try {
      context.range.surroundContents(span);
    } catch {
      const contents = context.range.extractContents();
      span.appendChild(contents);
      context.range.insertNode(span);
    }
    context.selection.removeAllRanges();
    updateCounts();
    scheduleReflow();
  };

  const applyFontFamily = (family: string) => {
    applyInlineSelectionStyle("font-family", family);
  };

  const applyExactFontSize = (points: number) => {
    if (!Number.isFinite(points)) return;
    applyInlineSelectionStyle("font-size", `${Math.max(6, Math.min(96, points))}pt`);
  };

  const applyLineHeight = (value: number) => {
    const block = selectedParagraphBlock();
    if (!block) return;
    block.style.lineHeight = String(value);
    updateCounts();
    scheduleReflow();
  };

  const applyParagraphSpacing = (before: number, after: number) => {
    const block = selectedParagraphBlock();
    if (!block) return;
    block.style.marginTop = `${before}px`;
    block.style.marginBottom = `${after}px`;
    updateCounts();
    scheduleReflow();
  };

  const applyIndent = (
    kind: "first-line" | "hanging" | "left" | "right",
    value: number
  ) => {
    const block = selectedParagraphBlock();
    if (!block) return;

    if (kind === "first-line") block.style.textIndent = `${value}px`;
    if (kind === "hanging") {
      block.style.paddingLeft = `${value}px`;
      block.style.textIndent = `-${value}px`;
    }
    if (kind === "left") {
      const current = Number.parseFloat(block.style.marginLeft || "0") || 0;
      block.style.marginLeft = `${current + value}px`;
    }
    if (kind === "right") {
      const current = Number.parseFloat(block.style.marginRight || "0") || 0;
      block.style.marginRight = `${current + value}px`;
    }

    updateCounts();
    scheduleReflow();
  };

  const handleTableAction = (
    action:
      | "row-above"
      | "row-below"
      | "column-left"
      | "column-right"
      | "delete-row"
      | "delete-column"
      | "delete-table"
      | "merge-right"
      | "split-cell"
      | "header-row"
      | "distribute-columns"
  ) => {
    const cell = selectedTableCellRef.current;
    const table = cell?.closest("table");
    const row = cell?.parentElement as HTMLTableRowElement | null;
    if (!cell || !table || !row) return;

    const rowIndex = row.rowIndex;
    const cellIndex = cell.cellIndex;

    if (action === "row-above" || action === "row-below") {
      const targetIndex = action === "row-above" ? rowIndex : rowIndex + 1;
      const nextRow = table.insertRow(targetIndex);
      const count = Math.max(1, row.cells.length);
      for (let index = 0; index < count; index += 1) {
        const nextCell = nextRow.insertCell();
        nextCell.innerHTML = "Cell";
        nextCell.dataset.tamishraId = createId("cell");
      }
    }

    if (action === "column-left" || action === "column-right") {
      const targetIndex = action === "column-left" ? cellIndex : cellIndex + 1;
      Array.from(table.rows).forEach((tableRow) => {
        const nextCell = tableRow.insertCell(Math.min(targetIndex, tableRow.cells.length));
        nextCell.innerHTML = "Cell";
        nextCell.dataset.tamishraId = createId("cell");
      });
    }

    if (action === "delete-row") {
      table.deleteRow(rowIndex);
      if (!table.rows.length) table.remove();
    }

    if (action === "delete-column") {
      Array.from(table.rows).forEach((tableRow) => {
        if (cellIndex < tableRow.cells.length) tableRow.deleteCell(cellIndex);
      });
      if (!table.rows[0]?.cells.length) table.remove();
    }

    if (action === "delete-table") {
      table.remove();
      selectedTableCellRef.current = null;
      setTableActive(false);
    }

    if (action === "merge-right") {
      const next = cell.nextElementSibling as HTMLTableCellElement | null;
      if (next) {
        cell.innerHTML = `${cell.innerHTML} ${next.innerHTML}`;
        cell.colSpan = (cell.colSpan || 1) + (next.colSpan || 1);
        next.remove();
      }
    }

    if (action === "split-cell" && cell.colSpan > 1) {
      const count = cell.colSpan;
      cell.colSpan = 1;
      for (let index = 1; index < count; index += 1) {
        const next = document.createElement(cell.tagName.toLowerCase());
        next.textContent = "Cell";
        next.dataset.tamishraId = createId("cell");
        cell.insertAdjacentElement("afterend", next);
      }
    }

    if (action === "header-row") {
      const first = table.rows[0];
      if (first) {
        Array.from(first.cells).forEach((source) => {
          if (source.tagName.toLowerCase() === "th") return;
          const th = document.createElement("th");
          th.innerHTML = source.innerHTML;
          th.dataset.tamishraId = source.dataset.tamishraId || createId("cell");
          source.replaceWith(th);
        });
      }
    }

    if (action === "distribute-columns") {
      table.style.tableLayout = "fixed";
      const maxCells = Math.max(...Array.from(table.rows).map((item) => item.cells.length), 1);
      Array.from(table.rows).forEach((tableRow) => {
        Array.from(tableRow.cells).forEach((tableCell) => {
          (tableCell as HTMLElement).style.width = `${100 / maxCells}%`;
        });
      });
    }

    ensureBlockIds();
    updateCounts();
    scheduleReflow();
  };

  const handleInsertAction = (
    action:
      | "toc"
      | "footnote"
      | "endnote"
      | "equation"
      | "symbol"
      | "date"
      | "bookmark"
      | "section-break"
      | "columns-1"
      | "columns-2"
      | "columns-3"
  ) => {
    focusEditor();

    if (action === "toc") {
      refreshDocumentMetadata();
      const entries = getEditors().flatMap((editor) => extractDocsOutline(editor));
      const html = entries.length
        ? entries.map((entry) => {
            const target = queryDocument<HTMLElement>(
              `[data-tamishra-id="${CSS.escape(entry.blockId)}"]`
            );
            if (target) target.id = entry.blockId;
            return `<p class="docsTocLevel${entry.level}"><a href="#${entry.blockId}">${escapeHtml(entry.text)}</a></p>`;
          }).join("")
        : "<p>No headings found.</p>";
      applyCommand(
        "insertHTML",
        `<div class="docsToc" data-tamishra-id="${createId("toc")}"><h2>Table of contents</h2>${html}</div><p><br></p>`
      );
    }

    if (action === "footnote" || action === "endnote") {
      const note = window.prompt(action === "footnote" ? "Footnote text" : "Endnote text");
      if (!note?.trim()) return;
      const number = queryDocumentAll(
        action === "footnote" ? "[data-footnote-ref]" : "[data-endnote-ref]"
      ).length + 1;
      const attr = action === "footnote" ? "data-footnote-ref" : "data-endnote-ref";
      applyCommand(
        "insertHTML",
        `<sup ${attr}="${number}">[${number}]</sup>`
      );
      const lastEditor = getEditors().at(-1);
      if (lastEditor) {
        const className = action === "footnote" ? "docsFootnotes" : "docsEndnotes";
        let container = lastEditor.querySelector<HTMLElement>(`.${className}`);
        if (!container) {
          container = document.createElement("section");
          container.className = className;
          container.dataset.tamishraId = createId(action);
          container.innerHTML = `<hr><strong>${action === "footnote" ? "Footnotes" : "Endnotes"}</strong>`;
          lastEditor.appendChild(container);
        }
        const paragraph = document.createElement("p");
        paragraph.textContent = `[${number}] ${note.trim()}`;
        container.appendChild(paragraph);
      }
    }

    if (action === "equation") {
      const equation = window.prompt("Equation or formula");
      if (!equation?.trim()) return;
      applyCommand(
        "insertHTML",
        `<span class="docsEquation" data-equation="${escapeHtml(equation.trim())}">${escapeHtml(equation.trim())}</span>`
      );
    }

    if (action === "symbol") {
      const symbol = window.prompt("Insert symbol", "°");
      if (symbol) applyCommand("insertText", symbol);
    }

    if (action === "date") {
      applyCommand(
        "insertText",
        new Intl.DateTimeFormat(language, { dateStyle: "long", timeStyle: "short" }).format(new Date())
      );
    }

    if (action === "bookmark") {
      const block = selectedParagraphBlock();
      if (!block) return;
      const name = window.prompt("Bookmark name");
      if (!name?.trim()) return;
      const bookmarkId = `bookmark-${name.trim().replace(/[^a-z0-9-_]+/gi, "-")}`;
      block.dataset.bookmark = name.trim();
      block.id = bookmarkId;
      setSavedState("Bookmark added");
    }

    if (action === "section-break") {
      const id = createId("section-break");
      applyCommand(
        "insertHTML",
        `<div data-section-break="true" data-page-break="true" data-tamishra-id="${id}" contenteditable="false" class="docsSectionBreak"><span>Section break</span></div><p><br></p>`
      );
    }

    if (action.startsWith("columns-")) {
      const count = Number(action.split("-")[1]);
      const context = selectionContext();
      const wrapper = document.createElement("div");
      wrapper.dataset.columns = String(count);
      wrapper.dataset.tamishraId = createId("columns");
      wrapper.className = "docsColumns";
      wrapper.style.columnCount = String(count);
      wrapper.style.columnGap = "32px";

      if (context && !context.range.collapsed) {
        const contents = context.range.extractContents();
        wrapper.appendChild(contents);
        context.range.insertNode(wrapper);
        context.selection.removeAllRanges();
      } else {
        wrapper.innerHTML = "<p>Column content</p>";
        applyCommand("insertHTML", wrapper.outerHTML);
      }
    }

    ensureBlockIds();
    updateCounts();
    scheduleReflow();
  };

  const updateCounts = () => {
    const text = getDocumentText();
    const trimmed = text.trim();

    setCharCount(text.length);
    setWordCount(trimmed ? trimmed.split(/\s+/).length : 0);
    const stats = calculateDocsProofingStats(text);
    setProofing({
      ...stats,
      paragraphs: queryDocumentAll("p, li, blockquote").length,
      headings: queryDocumentAll("h1, h2, h3, h4").length
    });
    setOutline(getEditors().flatMap((editor) => extractDocsOutline(editor)));
    setSavedState("Saving…");
  };

  const command = (name: string, value?: string) => {
    focusEditor();
    applyCommand(name, value);
    updateCounts();
    scheduleReflow();
  };

  const formatBlock = (tag: "p" | "h1" | "h2" | "h3" | "blockquote") => {
    focusEditor();
    applyCommand("formatBlock", tag);
    updateCounts();
    scheduleReflow();
  };

  const insertLink = () => {
    const url = window.prompt("Paste a link");
    if (!url) return;

    focusEditor();
    applyCommand("createLink", url);
    updateCounts();
    scheduleReflow();
  };

  const clearFormatting = () => {
    command("removeFormat");
  };

  const updatePageConfig = (next: PageConfig, label: string) => {
    pageHistoryRef.current.push(label, page, next);
    setPage(next);
    setSavedState("Saving…");
  };

  const undoAction = () => {
    const previousPage = pageHistoryRef.current.undo();

    if (previousPage) {
      setPage(previousPage);
      setSavedState("Saving…");
      return;
    }

    command("undo");
  };

  const redoAction = () => {
    const nextPage = pageHistoryRef.current.redo();

    if (nextPage) {
      setPage(nextPage);
      setSavedState("Saving…");
      return;
    }

    command("redo");
  };

  const insertTable = () => {
    focusEditor();
    applyCommand(
      "insertHTML",
      '<table><tbody><tr><th>Heading 1</th><th>Heading 2</th></tr><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></tbody></table><p><br></p>'
    );
    updateCounts();
    scheduleReflow();
  };

  const insertDivider = () => {
    command("insertHorizontalRule");
  };

  const insertPageBreak = () => {
    focusEditor();
    const id = createId("page-break");
    applyCommand(
      "insertHTML",
      `<div data-page-break="true" data-tamishra-id="${id}" contenteditable="false" class="docsManualPageBreak"><span>Page break</span></div><p><br></p>`
    );
    updateCounts();
    scheduleReflow();
  };

  const selectImageElement = (image: HTMLImageElement | null) => {
    queryDocumentAll("img.docsSelectedImage").forEach((element) =>
      element.classList.remove("docsSelectedImage")
    );

    if (!image) {
      setSelectedImageId(null);
      return;
    }

    if (!image.dataset.tamishraId) {
      image.dataset.tamishraId = createId("img");
    }

    image.classList.add("docsSelectedImage");
    setSelectedImageId(image.dataset.tamishraId);
    setSelectedImageWidth(Math.round(image.getBoundingClientRect().width || image.width || 320));
    setSelectedImageAlt(image.alt || "");
    setSelectedImageLayout(image.dataset.layout || "inline");
  };

  const findSelectedImage = () => {
    if (!selectedImageId) return null;
    return queryDocument<HTMLImageElement>(
      `img[data-tamishra-id="${CSS.escape(selectedImageId)}"]`
    );
  };

  const insertImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;

    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      if (!src) return;

      focusEditor();
      const id = createId("img");
      const escapedName = file.name.replace(/[&<>"']/g, "");
      applyCommand(
        "insertHTML",
        `<img data-tamishra-id="${id}" data-layout="inline" src="${src}" alt="${escapedName}" style="width:320px;max-width:100%;height:auto;" /><p><br></p>`
      );
      ensureBlockIds();
      updateCounts();
      scheduleReflow();

      requestAnimationFrame(() => {
        const image = queryDocument<HTMLImageElement>(
          `img[data-tamishra-id="${CSS.escape(id)}"]`
        );
        selectImageElement(image);

        if (image && !image.complete) {
          image.addEventListener("load", scheduleReflow, { once: true });
        } else {
          scheduleReflow();
        }
      });
    };
    reader.readAsDataURL(file);
  };

  const handleImageInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) insertImageFile(file);
    event.target.value = "";
  };

  const handleEditorPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith("image/")
    );

    const file = imageItem?.getAsFile();
    if (!file) return;

    event.preventDefault();
    insertImageFile(file);
  };

  const handleEditorDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const file = Array.from(event.dataTransfer.files).find((item) =>
      item.type.startsWith("image/")
    );
    if (!file) return;

    event.preventDefault();
    insertImageFile(file);
  };

  const updateSelectedImageWidth = (width: number) => {
    const image = findSelectedImage();
    if (!image) return;

    const safeWidth = Math.max(80, Math.min(700, width));
    image.style.width = `${safeWidth}px`;
    image.style.height = "auto";
    setSelectedImageWidth(safeWidth);
    updateCounts();
    scheduleReflow();
  };

  const updateSelectedImageAlt = (alt: string) => {
    const image = findSelectedImage();
    if (!image) return;

    image.alt = alt;
    setSelectedImageAlt(alt);
    setSavedState("Saving…");
  };

  const updateSelectedImageLayout = (layout: string) => {
    const image = findSelectedImage();
    if (!image) return;

    image.dataset.layout = layout;
    image.classList.remove(
      "docsImageInline",
      "docsImageBlock",
      "docsImageCenter",
      "docsImageWrapLeft",
      "docsImageWrapRight"
    );

    const className: Record<string, string> = {
      inline: "docsImageInline",
      block: "docsImageBlock",
      center: "docsImageCenter",
      "wrap-left": "docsImageWrapLeft",
      "wrap-right": "docsImageWrapRight"
    };

    image.classList.add(className[layout] ?? "docsImageInline");
    setSelectedImageLayout(layout);
    updateCounts();
    scheduleReflow();
  };

  const deleteSelectedImage = () => {
    const image = findSelectedImage();
    if (!image) return;

    image.remove();
    setSelectedImageId(null);
    updateCounts();
    scheduleReflow();
  };

  const selectionAtBoundary = (editor: HTMLDivElement, edge: "start" | "end") => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return false;

    const probe = document.createRange();
    probe.selectNodeContents(editor);

    if (edge === "start") {
      probe.setEnd(range.startContainer, range.startOffset);
      return probe.toString().length === 0;
    }

    probe.setStart(range.endContainer, range.endOffset);
    return probe.toString().length === 0;
  };

  const placeCaret = (editor: HTMLDivElement, edge: "start" | "end") => {
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(edge === "start");
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const activatePageEditor = (index: number, editor: HTMLDivElement) => {
    activePageRef.current = index;
    editorRef.current = editor;
    setActivePage(index + 1);
  };

  const handlePageKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLDivElement>
  ) => {
    const currentEditor = pageEditorsRef.current[index];
    if (!currentEditor) return;

    if (event.key === "Backspace" && index > 0 && selectionAtBoundary(currentEditor, "start")) {
      const previous = pageEditorsRef.current[index - 1];
      if (!previous) return;

      event.preventDefault();
      const manualBreak = previous.lastElementChild as HTMLElement | null;

      if (manualBreak?.dataset.pageBreak === "true") {
        manualBreak.remove();
      }

      activatePageEditor(index - 1, previous);
      placeCaret(previous, "end");

      if (!manualBreak || manualBreak.dataset.pageBreak !== "true") {
        applyCommand("delete");
      }

      updateCounts();
      scheduleReflow();
      return;
    }

    if (event.key === "ArrowUp" && index > 0 && selectionAtBoundary(currentEditor, "start")) {
      const previous = pageEditorsRef.current[index - 1];
      if (!previous) return;

      event.preventDefault();
      activatePageEditor(index - 1, previous);
      placeCaret(previous, "end");
      return;
    }

    if (
      event.key === "ArrowDown" &&
      index < pageCount - 1 &&
      selectionAtBoundary(currentEditor, "end")
    ) {
      const next = pageEditorsRef.current[index + 1];
      if (!next) return;

      event.preventDefault();
      activatePageEditor(index + 1, next);
      placeCaret(next, "start");
    }
  };

  const findInDocument = (backwards = false) => {
    if (!findQuery) {
      setFindStatus("Enter text to find");
      return;
    }

    focusEditor();
    const nativeFind = (
      window as Window & {
        find?: (
          searchString: string,
          caseSensitive?: boolean,
          backwards?: boolean,
          wrapAround?: boolean,
          wholeWord?: boolean,
          searchInFrames?: boolean,
          showDialog?: boolean
        ) => boolean;
      }
    ).find;

    const found = nativeFind
      ? nativeFind.call(
          window,
          findQuery,
          matchCase,
          backwards,
          true,
          wholeWord,
          false,
          false
        )
      : false;

    setFindStatus(found ? "Match selected" : "No match");
  };

  const selectionMatchesFind = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;

    const selected = selection.toString();
    const expected = findQuery;
    if (!selected || !expected) return false;

    if (wholeWord && selected.length !== expected.length) return false;
    return matchCase
      ? selected === expected
      : selected.toLowerCase() === expected.toLowerCase();
  };

  const replaceCurrent = () => {
    if (!findQuery) return;

    if (!selectionMatchesFind()) {
      findInDocument(false);
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!getEditors().some((editor) => editor.contains(range.commonAncestorContainer))) {
      findInDocument(false);
      return;
    }

    range.deleteContents();
    const replacement = document.createTextNode(replaceQuery);
    range.insertNode(replacement);
    range.setStartAfter(replacement);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    updateCounts();
    scheduleReflow();
    setFindStatus("Replaced");
    requestAnimationFrame(() => findInDocument(false));
  };

  const replaceAll = () => {
    const editors = getEditors();
    if (!editors.length || !findQuery) return;

    const escaped = findQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(
      wholeWord ? `\\b${escaped}\\b` : escaped,
      matchCase ? "g" : "gi"
    );

    const nodes: Text[] = [];
    editors.forEach((editor) => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let currentNode = walker.nextNode();

      while (currentNode) {
        nodes.push(currentNode as Text);
        currentNode = walker.nextNode();
      }
    });

    let replacements = 0;
    for (const node of nodes) {
      const original = node.nodeValue ?? "";
      const matches = original.match(expression);
      if (!matches?.length) continue;

      replacements += matches.length;
      node.nodeValue = original.replace(expression, replaceQuery);
    }

    updateCounts();
    scheduleReflow();
    setFindStatus(replacements ? `Replaced ${replacements} match${replacements === 1 ? "" : "es"}` : "No match");
  };

  const handleExportText = () => {
    const text = getDocumentText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${(title.trim() || "document").replace(/[^a-z0-9-_]+/gi, "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  const handlePrint = () => {
    window.print();
  };

  const handleExportHtml = () => {
    const html = getDocumentHtml();
    const fullDocument = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
body{font-family:Arial,sans-serif;max-width:820px;margin:48px auto;padding:0 32px;line-height:1.65;color:#172033}
img{max-width:100%}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #d0d5dd;padding:8px}
</style>
</head>
<body>${html}</body>
</html>`;

    const blob = new Blob([fullDocument], { type: "text/html;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${(title.trim() || "document").replace(/[^a-z0-9-_]+/gi, "-")}.html`;
    anchor.click();
    URL.revokeObjectURL(href);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveDocument();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        handlePrint();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setShowFind(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [title, page, headerText, footerText, headerFooter]);

  const resolveChromeText = (value: string, pageIndex: number) => {
    const pageNumber = headerFooter.pageNumberStart + pageIndex;

    return value
      .replaceAll("{title}", title.trim() || "Untitled document")
      .replaceAll("{page}", String(pageNumber))
      .replaceAll("{pages}", String(pageCount));
  };

  const formatPageNumber = (pageIndex: number) => {
    const number = headerFooter.pageNumberStart + pageIndex;

    if (headerFooter.pageNumberFormat === "page-number") {
      return `Page ${number}`;
    }

    if (headerFooter.pageNumberFormat === "page-number-of-total") {
      return `Page ${number} of ${pageCount}`;
    }

    return String(number);
  };

  const getChromeSlot = (
    region: "header" | "footer",
    alignment: HeaderFooterAlignment,
    pageIndex: number
  ) => {
    if (headerFooter.hideOnFirstPage && pageIndex === 0) return [];

    const content: string[] = [];
    const regionEnabled =
      region === "header" ? headerFooter.headerEnabled : headerFooter.footerEnabled;
    const regionAlignment =
      region === "header" ? headerFooter.headerAlignment : headerFooter.footerAlignment;
    const regionText = region === "header" ? headerText : footerText;

    if (regionEnabled && regionAlignment === alignment && regionText.trim()) {
      content.push(resolveChromeText(regionText, pageIndex));
    }

    if (
      headerFooter.pageNumberEnabled &&
      headerFooter.pageNumberPosition === `${region}-${alignment}`
    ) {
      content.push(formatPageNumber(pageIndex));
    }

    return content;
  };

  const pageStyle = useMemo(
    () => ({
      width: mmToCssPx(page.widthMm),
      height: mmToCssPx(page.heightMm),
      transform: `scale(${zoom / 100})`,
      transformOrigin: "top center"
    }),
    [page, zoom]
  );

  const editorStyle = useMemo(
    () => ({
      width: "100%",
      height: "100%",
      boxSizing: "border-box" as const,
      overflow: "hidden",
      paddingTop: mmToCssPx(page.margins.topMm),
      paddingRight: mmToCssPx(page.margins.rightMm),
      paddingBottom: mmToCssPx(page.margins.bottomMm),
      paddingLeft: mmToCssPx(page.margins.leftMm)
    }),
    [page]
  );

  return (
    <main className="docsApp">
      <header className="docsTopbar">
        <a className="docsBack" href="/" aria-label="Back to workspace">T</a>

        <div className="docsIdentity">
          <div className="docsTitleRow">
            <input
              className="docsTitleInput"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setSavedState("Saving…");
              }}
              aria-label="Document title"
            />
            <span className="docsSaveState">{savedState}</span>
          </div>
          <div className="docsMenuRow" aria-label="Document menu">
            <button onClick={() => setActivePanel("files")}>File</button>
            <button onClick={() => setActivePanel("comments")}>Review</button>
            <button onClick={() => setActivePanel("insert")}>Insert</button>
            <button onClick={() => setActivePanel("format")}>Format</button>
            <button onClick={() => setActivePanel("proofing")}>Tools</button>
            <button onClick={() => window.alert("Tamishra Docs keyboard shortcuts: Ctrl/Cmd+S save version, Ctrl/Cmd+F find, Ctrl/Cmd+P print/PDF.")}>Help</button>
          </div>
        </div>

        <div className="docsTopActions">
          <button className="docsIconButton" onClick={() => createVersionSnapshot()} title="Save version">✓</button>
          <button className="docsIconButton" onClick={handlePrint} title="Print or save as PDF">⎙</button>
          <button className="docsShareButton" onClick={() => setActivePanel("share")}>Share</button>
          <button className="docsProfile">DK</button>
        </div>
      </header>

      <section className="docsToolbar" aria-label="Formatting toolbar">
        <div className="docsToolGroup">
          <button onClick={undoAction} title="Undo">↶</button>
          <button onClick={redoAction} title="Redo">↷</button>
        </div>

        <div className="docsToolDivider" />

        <select
          aria-label="Text style"
          defaultValue="p"
          onChange={(event) => formatBlock(event.target.value as "p" | "h1" | "h2" | "h3" | "blockquote")}
        >
          <option value="p">Normal text</option>
          <option value="h1">Title</option>
          <option value="h2">Heading 1</option>
          <option value="h3">Heading 2</option>
          <option value="blockquote">Quote</option>
        </select>

        <div className="docsToolDivider" />

        <select
          aria-label="Font size"
          value={fontSize}
          onChange={(event) => {
            setFontSize(event.target.value);
            command("fontSize", event.target.value);
          }}
        >
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="4">Medium</option>
          <option value="5">Large</option>
          <option value="6">Extra large</option>
        </select>

        <input
          className="docsColorPicker"
          type="color"
          value={textColor}
          aria-label="Text color"
          title="Text color"
          onChange={(event) => {
            setTextColor(event.target.value);
            command("foreColor", event.target.value);
          }}
        />

        <div className="docsToolDivider" />

        <div className="docsToolGroup">
          <button onClick={() => command("bold")} title="Bold"><strong>B</strong></button>
          <button onClick={() => command("italic")} title="Italic"><em>I</em></button>
          <button onClick={() => command("underline")} title="Underline"><u>U</u></button>
          <button onClick={() => command("strikeThrough")} title="Strikethrough">S̶</button>
        </div>

        <div className="docsToolDivider" />

        <div className="docsToolGroup">
          <button onClick={() => command("justifyLeft")} title="Align left">≡</button>
          <button onClick={() => command("justifyCenter")} title="Align center">≣</button>
          <button onClick={() => command("justifyRight")} title="Align right">≡</button>
        </div>

        <div className="docsToolDivider" />

        <div className="docsToolGroup">
          <button onClick={() => command("insertUnorderedList")} title="Bulleted list">•≡</button>
          <button onClick={() => command("insertOrderedList")} title="Numbered list">1≡</button>
          <button onClick={() => command("outdent")} title="Decrease indent">⇤</button>
          <button onClick={() => command("indent")} title="Increase indent">⇥</button>
        </div>

        <div className="docsToolDivider" />

        <div className="docsToolGroup">
          <button onClick={insertLink} title="Insert link">⌁</button>
          <button onClick={() => imageInputRef.current?.click()} title="Insert image">Img</button>
          <button onClick={insertTable} title="Insert table">▦</button>
          <button onClick={insertDivider} title="Insert divider">—</button>
          <button onClick={insertPageBreak} title="Insert page break">PB</button>
          <button onClick={clearFormatting} title="Clear formatting">Tx</button>
        </div>

        <div className="docsToolbarSpacer" />

        <select
          className="docsZoom"
          value={zoom}
          aria-label="Zoom"
          onChange={(event) => setZoom(Number(event.target.value))}
        >
          <option value={75}>75%</option>
          <option value={90}>90%</option>
          <option value={100}>100%</option>
          <option value={110}>110%</option>
          <option value={125}>125%</option>
          <option value={150}>150%</option>
        </select>

        <button className="docsExportButton" onClick={() => setShowFind((value) => !value)}>Find</button>
        <button className="docsExportButton" onClick={handleExportText}>TXT</button>
        <button className="docsExportButton" onClick={handleExportHtml}>HTML</button>
      </section>

      {showFind && (
        <section className="docsFindReplace" aria-label="Find and replace">
          <input
            autoFocus
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindStatus("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") findInDocument(event.shiftKey);
              if (event.key === "Escape") setShowFind(false);
            }}
            placeholder="Find in document"
            aria-label="Find text"
          />
          <input
            value={replaceQuery}
            onChange={(event) => setReplaceQuery(event.target.value)}
            placeholder="Replace with"
            aria-label="Replacement text"
          />
          <button onClick={() => findInDocument(true)} title="Previous match">↑</button>
          <button onClick={() => findInDocument(false)} title="Next match">↓</button>
          <button onClick={replaceCurrent}>Replace</button>
          <button onClick={replaceAll}>Replace all</button>
          <label className="docsFindOption">
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(event) => setMatchCase(event.target.checked)}
            />
            Match case
          </label>
          <label className="docsFindOption">
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(event) => setWholeWord(event.target.checked)}
            />
            Whole word
          </label>
          <span className="docsFindStatus">{findStatus}</span>
          <button className="docsFindClose" onClick={() => setShowFind(false)} aria-label="Close find">
            ×
          </button>
        </section>
      )}

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={handleImageInput}
      />
      <input
        ref={nativeInputRef}
        type="file"
        accept=".tmdoc,application/vnd.tamishra.document"
        hidden
        onChange={handleNativeInput}
      />
      <input
        ref={docxInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        hidden
        onChange={handleDocxInput}
      />

      <div className="docsWorkArea">
        <aside className="docsLeftRail">
          <button className={`docsRailButton ${activePanel === "files" ? "active" : ""}`} title="Documents" onClick={() => setActivePanel("files")}>▤</button>
          <button className={`docsRailButton ${activePanel === "outline" ? "active" : ""}`} title="Document outline" onClick={() => setActivePanel("outline")}>☷</button>
          <button className={`docsRailButton ${activePanel === "comments" ? "active" : ""}`} title="Comments & review" onClick={() => setActivePanel("comments")}>◫</button>
          <button className={`docsRailButton ${activePanel === "versions" ? "active" : ""}`} title="Versions" onClick={() => setActivePanel("versions")}>◴</button>
          <button className={`docsRailButton ${activePanel === "share" ? "active" : ""}`} title="Share" onClick={() => setActivePanel("share")}>◎</button>
          <button className={`docsRailButton ${activePanel === "format" ? "active" : ""}`} title="Advanced format" onClick={() => setActivePanel("format")}>Aa</button>
          <button className={`docsRailButton ${activePanel === "table" ? "active" : ""}`} title="Table tools" onClick={() => setActivePanel("table")}>▦</button>
          <button className={`docsRailButton ${activePanel === "insert" ? "active" : ""}`} title="Insert tools" onClick={() => setActivePanel("insert")}>＋</button>
          <button className={`docsRailButton ${activePanel === "proofing" ? "active" : ""}`} title="Proofing" onClick={() => setActivePanel("proofing")}>✓</button>
        </aside>

        <section className="docsCanvasWrap">
          <div className="docsRuler">
            <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span>
          </div>

          <div className="docsPageStage">
            {Array.from({ length: pageCount }, (_, index) => (
              <article
                key={index}
                className={`docsPage ${activePage === index + 1 ? "active" : ""}`}
                style={pageStyle}
                data-page-index={index}
              >
                <div
                  ref={(element) => setActiveEditor(index, element)}
                  className="docsEditor docsPageEditor"
                  style={editorStyle}
                  contentEditable={editingMode !== "viewing"}
                  suppressContentEditableWarning
                  onFocus={(event) => activatePageEditor(index, event.currentTarget)}
                  onInput={() => {
                    const editor = pageEditorsRef.current[index];
                    if (editor) activatePageEditor(index, editor);
                    updateCounts();
                    scheduleReflow();
                  }}
                  onKeyDown={(event) => handlePageKeyDown(index, event)}
                  onBlur={saveDocument}
                  onPaste={handleEditorPaste}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleEditorDrop}
                  onClick={(event) => {
                    const editor = pageEditorsRef.current[index];
                    if (editor) activatePageEditor(index, editor);
                    const target = event.target;
                    selectImageElement(target instanceof HTMLImageElement ? target : null);
                    const element = target instanceof HTMLElement ? target : null;
                    const cell = element?.closest("td, th") as HTMLTableCellElement | null;
                    selectedTableCellRef.current = cell;
                    setTableActive(Boolean(cell));
                  }}
                  spellCheck={spellcheck}
                  lang={language}
                  aria-label={`Document page ${index + 1}`}
                />
                {(headerFooter.headerEnabled ||
                  (headerFooter.pageNumberEnabled &&
                    headerFooter.pageNumberPosition.startsWith("header"))) && (
                  <div
                    className="docsPageChrome docsPageHeader"
                    contentEditable={false}
                    style={{
                      top: mmToCssPx(headerFooter.headerDistanceMm),
                      left: mmToCssPx(page.margins.leftMm),
                      right: mmToCssPx(page.margins.rightMm)
                    }}
                  >
                    {(["left", "center", "right"] as HeaderFooterAlignment[]).map((alignment) => (
                      <div key={alignment} className={`docsChromeSlot ${alignment}`}>
                        {getChromeSlot("header", alignment, index).map((value, itemIndex) => (
                          <span key={itemIndex}>{value}</span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {(headerFooter.footerEnabled ||
                  (headerFooter.pageNumberEnabled &&
                    headerFooter.pageNumberPosition.startsWith("footer"))) && (
                  <div
                    className="docsPageChrome docsPageFooter"
                    contentEditable={false}
                    style={{
                      bottom: mmToCssPx(headerFooter.footerDistanceMm),
                      left: mmToCssPx(page.margins.leftMm),
                      right: mmToCssPx(page.margins.rightMm)
                    }}
                  >
                    {(["left", "center", "right"] as HeaderFooterAlignment[]).map((alignment) => (
                      <div key={alignment} className={`docsChromeSlot ${alignment}`}>
                        {getChromeSlot("footer", alignment, index).map((value, itemIndex) => (
                          <span key={itemIndex}>{value}</span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        {activePanel ? (
          <DocsProductionPanel
            tab={activePanel}
            workspace={workspace}
            currentDocumentId={currentDocumentId}
            outline={outline}
            comments={currentComments}
            versions={currentVersions}
            grants={currentGrants}
            suggestions={currentSuggestions}
            collaborators={collaborators}
            proofing={proofing}
            editingMode={editingMode}
            language={language}
            spellcheck={spellcheck}
            tableActive={tableActive}
            onClose={() => setActivePanel(null)}
            onNew={handleNewDocument}
            onSaveAs={handleSaveAs}
            onOpen={handleOpenRecord}
            onDuplicate={handleDuplicateRecord}
            onTrash={handleTrashRecord}
            onRestore={handleRestoreRecord}
            onDeleteForever={handleDeleteRecordForever}
            onCreateFolder={handleCreateFolder}
            onMoveCurrentToFolder={handleMoveCurrentToFolder}
            onImportNative={() => nativeInputRef.current?.click()}
            onExportNative={handleExportNative}
            onImportDocx={() => docxInputRef.current?.click()}
            onExportDocx={handleExportDocx}
            onGoToOutline={handleGoToOutline}
            onAddComment={handleAddComment}
            onReplyComment={handleReplyComment}
            onToggleResolveComment={handleToggleResolveComment}
            onSuggestReplacement={handleSuggestReplacement}
            onResolveSuggestion={handleResolveSuggestion}
            onCreateVersion={createVersionSnapshot}
            onRestoreVersion={restoreVersionSnapshot}
            onAddGrant={handleAddGrant}
            onRemoveGrant={handleRemoveGrant}
            onEditingModeChange={setEditingMode}
            onLanguageChange={setLanguage}
            onSpellcheckChange={setSpellcheck}
            onApplyFontFamily={applyFontFamily}
            onApplyExactFontSize={applyExactFontSize}
            onApplyLineHeight={applyLineHeight}
            onApplyParagraphSpacing={applyParagraphSpacing}
            onApplyIndent={applyIndent}
            onTableAction={handleTableAction}
            onInsertAction={handleInsertAction}
          />
        ) : (
          <aside className="docsRightRail">
            <div className="docsInfoCard">
              <span className="docsInfoLabel">Page setup</span>
              <PageSettings page={page} onChange={updatePageConfig} />
            </div>
  
            <div className="docsInfoCard">
              <span className="docsInfoLabel">Header & footer</span>
              <HeaderFooterSettingsPanel
                settings={headerFooter}
                headerText={headerText}
                footerText={footerText}
                onSettingsChange={(next) => {
                  setHeaderFooter(next);
                  setSavedState("Saving…");
                }}
                onHeaderTextChange={(value) => {
                  setHeaderText(value);
                  setSavedState("Saving…");
                }}
                onFooterTextChange={(value) => {
                  setFooterText(value);
                  setSavedState("Saving…");
                }}
              />
            </div>
  
            {selectedImageId && (
              <div className="docsInfoCard">
                <span className="docsInfoLabel">Image</span>
                <div className="docsImageInspector">
                  <label>
                    <span>Width</span>
                    <input
                      type="range"
                      min="80"
                      max="700"
                      step="10"
                      value={selectedImageWidth}
                      onChange={(event) => updateSelectedImageWidth(Number(event.target.value))}
                    />
                    <small>{selectedImageWidth}px</small>
                  </label>
  
                  <label>
                    <span>Layout</span>
                    <select
                      value={selectedImageLayout}
                      onChange={(event) => updateSelectedImageLayout(event.target.value)}
                    >
                      <option value="inline">Inline</option>
                      <option value="block">Block</option>
                      <option value="center">Centered</option>
                      <option value="wrap-left">Wrap left</option>
                      <option value="wrap-right">Wrap right</option>
                    </select>
                  </label>
  
                  <label>
                    <span>Alt text</span>
                    <input
                      type="text"
                      value={selectedImageAlt}
                      onChange={(event) => updateSelectedImageAlt(event.target.value)}
                      placeholder="Describe this image"
                    />
                  </label>
  
                  <button className="docsDangerButton" onClick={deleteSelectedImage}>
                    Delete image
                  </button>
                </div>
              </div>
            )}
  
            <div className="docsInfoCard">
              <span className="docsInfoLabel">Document</span>
              <strong>{wordCount} words</strong>
              <span>{charCount} characters</span>
            </div>
  
            <div className="docsInfoCard">
              <span className="docsInfoLabel">Storage</span>
              <strong>Local autosave</strong>
              <span>Cloud sync comes next</span>
            </div>
  
            <div className="docsInfoCard">
              <span className="docsInfoLabel">Output</span>
              <strong>Print / PDF</strong>
              <span>HTML export available</span>
            </div>
          </aside>
        )}

      </div>

      <footer className="docsStatusBar">
        <span>Page {activePage} of {pageCount}</span>
        <span>{wordCount} words</span>
        <span>{page.size} · {page.orientation}</span>
        <span>{language}</span>
        <span>{editingMode}</span>
        <span className="docsStatusSpacer" />
        <span>{savedState}</span>
        <span>{cloudStatus}</span>
        <span>{zoom}%</span>
      </footer>
    </main>
  );
}
