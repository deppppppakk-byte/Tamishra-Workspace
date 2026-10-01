"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "tamishra.docs.current";

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
  const [title, setTitle] = useState("Untitled document");
  const [savedState, setSavedState] = useState("Saved locally");
  const [zoom, setZoom] = useState(100);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);

  const saveDocument = () => {
    const html = editorRef.current?.innerHTML ?? "";
    const payload: SavedDocument = {
      title: title.trim() || "Untitled document",
      html,
      updatedAt: new Date().toISOString()
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    setSavedState("Saved locally");
  };

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
      const saved = JSON.parse(raw) as SavedDocument;
      setTitle(saved.title || "Untitled document");
      if (editorRef.current && saved.html) {
        editorRef.current.innerHTML = saved.html;
      }
      updateCounts();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveDocument();
    }, 700);

    return () => window.clearTimeout(timer);
  }, [title, wordCount, charCount]);

  const updateCounts = () => {
    const text = editorRef.current?.innerText ?? "";
    const trimmed = text.trim();

    setCharCount(text.length);
    setWordCount(trimmed ? trimmed.split(/\s+/).length : 0);
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

  const zoomStyle = useMemo(
    () => ({ transform: `scale(${zoom / 100})`, transformOrigin: "top center" }),
    [zoom]
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
          <button onClick={() => command("undo")} title="Undo">↶</button>
          <button onClick={() => command("redo")} title="Redo">↷</button>
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

        <button className="docsExportButton" onClick={handleExportHtml}>Export</button>
      </section>

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
            <article className="docsPage" style={zoomStyle}>
              <div
                ref={editorRef}
                className="docsEditor"
                contentEditable
                suppressContentEditableWarning
                onInput={updateCounts}
                onBlur={saveDocument}
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
        <span>Page 1</span>
        <span>{wordCount} words</span>
        <span>English</span>
        <span className="docsStatusSpacer" />
        <span>{savedState}</span>
        <span>{zoom}%</span>
      </footer>
    </main>
  );
}
