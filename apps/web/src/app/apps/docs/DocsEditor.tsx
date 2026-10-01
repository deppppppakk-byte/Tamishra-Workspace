"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createId,
  createPageConfig,
  type PageConfig
} from "@tamishra/document-model";
import {
  createDraftFromHtml,
  migrateLegacyDraft,
  mmToCssPx,
  updateDraft,
  type PersistedDocsDraft
} from "@tamishra/docs-engine";
import { TransactionHistory } from "@tamishra/history";
import PageSettings from "./PageSettings";

const STORAGE_KEY = "tamishra.docs.current.v2";
const LEGACY_STORAGE_KEY = "tamishra.docs.current";

type SavedDocument = {
  title: string;
  html: string;
  updatedAt: string;
};

function applyCommand(command: string, value?: string) {
  document.execCommand(command, false, value);
}

export default function DocsEditor() {
  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<PersistedDocsDraft | null>(null);
  const pageHistoryRef = useRef(new TransactionHistory<PageConfig>(100));
  const [title, setTitle] = useState("Untitled document");
  const [page, setPage] = useState<PageConfig>(() => createPageConfig());
  const [savedState, setSavedState] = useState("Saved locally");
  const [zoom, setZoom] = useState(100);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [pageCount, setPageCount] = useState(1);
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

  const ensureBlockIds = () => {
    const editor = editorRef.current;
    if (!editor) return;

    const assign = (element: Element, prefix: string) => {
      if (element instanceof HTMLElement && !element.dataset.tamishraId) {
        element.dataset.tamishraId = createId(prefix);
      }
    };

    Array.from(editor.children).forEach((element) => assign(element, "block"));
    editor
      .querySelectorAll("a, img, hr, ul, ol, li, table, tr, th, td, [data-page-break]")
      .forEach((element) => assign(element, element.tagName.toLowerCase()));
  };

  const saveDocument = () => {
    ensureBlockIds();
    const html = editorRef.current?.innerHTML ?? "";
    const safeTitle = title.trim() || "Untitled document";
    const nextDraft = draftRef.current
      ? updateDraft(draftRef.current, {
          title: safeTitle,
          editorHtml: html,
          page
        })
      : createDraftFromHtml(safeTitle, html, page);

    draftRef.current = nextDraft;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDraft));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    setSavedState("Saved locally");
  };

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);

    try {
      let draft: PersistedDocsDraft | null = null;

      if (raw) {
        draft = JSON.parse(raw) as PersistedDocsDraft;
      } else if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw) as SavedDocument;
        draft = migrateLegacyDraft(legacy);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }

      if (!draft) {
        updateCounts();
        return;
      }

      draftRef.current = draft;
      setTitle(draft.document.title || "Untitled document");
      setPage(draft.document.sections[0]?.page ?? createPageConfig());

      if (editorRef.current && draft.editorHtml) {
        editorRef.current.innerHTML = draft.editorHtml;
        ensureBlockIds();
      }

      updateCounts();
      setSavedState("Recovered local draft");
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
  }, [title, wordCount, charCount, page]);

  useEffect(() => {
    updateCounts();
  }, [page]);

  const updateCounts = () => {
    const editor = editorRef.current;
    const text = editor?.innerText ?? "";
    const trimmed = text.trim();

    setCharCount(text.length);
    setWordCount(trimmed ? trimmed.split(/\s+/).length : 0);

    if (editor) {
      const printableHeight =
        mmToCssPx(page.heightMm) -
        mmToCssPx(page.margins.topMm) -
        mmToCssPx(page.margins.bottomMm);

      const explicitBreaks = editor.querySelectorAll('[data-page-break="true"]').length;
      const verticalPadding =
        mmToCssPx(page.margins.topMm) + mmToCssPx(page.margins.bottomMm);
      const contentHeight = Math.max(0, editor.scrollHeight - verticalPadding);
      const measuredPages = printableHeight > 0
        ? Math.max(1, Math.ceil(contentHeight / printableHeight))
        : 1;

      setPageCount(Math.max(measuredPages, explicitBreaks + 1));
    }

    setSavedState("Saving…");
  };

  const command = (name: string, value?: string) => {
    editorRef.current?.focus();
    applyCommand(name, value);
    updateCounts();
  };

  const formatBlock = (tag: "p" | "h1" | "h2" | "h3" | "blockquote") => {
    editorRef.current?.focus();
    applyCommand("formatBlock", tag);
    updateCounts();
  };

  const insertLink = () => {
    const url = window.prompt("Paste a link");
    if (!url) return;

    editorRef.current?.focus();
    applyCommand("createLink", url);
    updateCounts();
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
    editorRef.current?.focus();
    applyCommand(
      "insertHTML",
      '<table><tbody><tr><th>Heading 1</th><th>Heading 2</th></tr><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></tbody></table><p><br></p>'
    );
    updateCounts();
  };

  const insertDivider = () => {
    command("insertHorizontalRule");
  };

  const insertPageBreak = () => {
    editorRef.current?.focus();
    const id = createId("page-break");
    applyCommand(
      "insertHTML",
      `<div data-page-break="true" data-tamishra-id="${id}" contenteditable="false" class="docsManualPageBreak"><span>Page break</span></div><p><br></p>`
    );
    updateCounts();
  };

  const selectImageElement = (image: HTMLImageElement | null) => {
    editorRef.current
      ?.querySelectorAll("img.docsSelectedImage")
      .forEach((element) => element.classList.remove("docsSelectedImage"));

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
    return editorRef.current?.querySelector(
      `img[data-tamishra-id="${CSS.escape(selectedImageId)}"]`
    ) as HTMLImageElement | null;
  };

  const insertImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;

    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      if (!src) return;

      editorRef.current?.focus();
      const id = createId("img");
      const escapedName = file.name.replace(/[&<>"']/g, "");
      applyCommand(
        "insertHTML",
        `<img data-tamishra-id="${id}" data-layout="inline" src="${src}" alt="${escapedName}" style="width:320px;max-width:100%;height:auto;" /><p><br></p>`
      );
      ensureBlockIds();
      updateCounts();

      requestAnimationFrame(() => {
        const image = editorRef.current?.querySelector(
          `img[data-tamishra-id="${CSS.escape(id)}"]`
        ) as HTMLImageElement | null;
        selectImageElement(image);
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
  };

  const deleteSelectedImage = () => {
    const image = findSelectedImage();
    if (!image) return;

    image.remove();
    setSelectedImageId(null);
    updateCounts();
  };

  const findInDocument = (backwards = false) => {
    if (!findQuery) {
      setFindStatus("Enter text to find");
      return;
    }

    editorRef.current?.focus();
    const found =
      typeof window.find === "function"
        ? window.find(findQuery, matchCase, backwards, true, wholeWord, false, false)
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
    if (!editorRef.current?.contains(range.commonAncestorContainer)) {
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
    setFindStatus("Replaced");
    requestAnimationFrame(() => findInDocument(false));
  };

  const replaceAll = () => {
    const editor = editorRef.current;
    if (!editor || !findQuery) return;

    const escaped = findQuery.replace(/[.*+?^\${}()|[\]\\\\]/g, "\\\\    const escaped = findQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\  const handleExportText = () => {");");
    const expression = new RegExp(
      wholeWord ? `\\b${escaped}\\b` : escaped,
      matchCase ? "g" : "gi"
    );

    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let currentNode = walker.nextNode();

    while (currentNode) {
      nodes.push(currentNode as Text);
      currentNode = walker.nextNode();
    }

    let replacements = 0;
    for (const node of nodes) {
      const original = node.nodeValue ?? "";
      const matches = original.match(expression);
      if (!matches?.length) continue;

      replacements += matches.length;
      node.nodeValue = original.replace(expression, replaceQuery);
    }

    updateCounts();
    setFindStatus(replacements ? `Replaced ${replacements} match${replacements === 1 ? "" : "es"}` : "No match");
  };

  const handleExportText = () => {
    const text = editorRef.current?.innerText ?? "";
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
    const html = editorRef.current?.innerHTML ?? "";
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
  }, [title, page]);

  const pageStyle = useMemo(
    () => ({
      width: mmToCssPx(page.widthMm),
      minHeight: mmToCssPx(page.heightMm),
      transform: `scale(${zoom / 100})`,
      transformOrigin: "top center"
    }),
    [page, zoom]
  );

  const editorStyle = useMemo(
    () => ({
      minHeight: mmToCssPx(page.heightMm),
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
            <button>File</button>
            <button>Edit</button>
            <button>Insert</button>
            <button>Format</button>
            <button>Tools</button>
            <button>Help</button>
          </div>
        </div>

        <div className="docsTopActions">
          <button className="docsIconButton" onClick={saveDocument} title="Save">✓</button>
          <button className="docsIconButton" onClick={handlePrint} title="Print or save as PDF">⎙</button>
          <button className="docsShareButton">Share</button>
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

      <div className="docsWorkArea">
        <aside className="docsLeftRail">
          <button className="docsRailButton active" title="Document outline">☷</button>
          <button className="docsRailButton" title="Comments">◫</button>
          <button className="docsRailButton" title="Versions">◴</button>
        </aside>

        <section className="docsCanvasWrap">
          <div className="docsRuler">
            <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span>
          </div>

          <div className="docsPageStage">
            <article className="docsPage" style={pageStyle}>
              <div
                ref={editorRef}
                className="docsEditor"
                style={editorStyle}
                contentEditable
                suppressContentEditableWarning
                onInput={updateCounts}
                onBlur={saveDocument}
                onPaste={handleEditorPaste}
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleEditorDrop}
                onClick={(event) => {
                  const target = event.target;
                  selectImageElement(target instanceof HTMLImageElement ? target : null);
                }}
                spellCheck
                aria-label="Document editor"
              >
                <h1>Untitled document</h1>
                <p>
                  Start writing here. Tamishra Docs now has a functional editing foundation with
                  formatting, local autosave, document statistics and print/PDF output.
                </p>
              </div>
            </article>
          </div>
        </section>

        <aside className="docsRightRail">
          <div className="docsInfoCard">
            <span className="docsInfoLabel">Page setup</span>
            <PageSettings page={page} onChange={updatePageConfig} />
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
      </div>

      <footer className="docsStatusBar">
        <span>Page 1 of {pageCount}</span>
        <span>{wordCount} words</span>
        <span>{page.size} · {page.orientation}</span>
        <span>English</span>
        <span className="docsStatusSpacer" />
        <span>{savedState}</span>
        <span>{zoom}%</span>
      </footer>
    </main>
  );
}
