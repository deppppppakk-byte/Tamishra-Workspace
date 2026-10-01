"use client";

import { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import styles from "./slides.module.css";

type ElementType = "text" | "shape" | "image" | "line" | "table" | "chart";
type ShapeType = "rect" | "ellipse" | "rounded";
type Transition = "none" | "fade" | "slide" | "zoom";

type SlideElement = {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  src?: string;
  fill: string;
  color: string;
  fontSize?: number;
  fontWeight?: number;
  align?: "left" | "center" | "right";
  shape?: ShapeType;
  rotation?: number;
};

type Slide = {
  id: string;
  background: string;
  transition: Transition;
  notes: string;
  elements: SlideElement[];
};

type Theme = {
  id: string;
  name: string;
  background: string;
  text: string;
  accent: string;
};

const themes: Theme[] = [
  { id: "paper", name: "Paper", background: "#ffffff", text: "#172033", accent: "#6f5df5" },
  { id: "midnight", name: "Midnight", background: "#111827", text: "#f8fafc", accent: "#8b7cff" },
  { id: "ocean", name: "Ocean", background: "#ecf7ff", text: "#12324a", accent: "#1473e6" },
  { id: "mint", name: "Mint", background: "#effaf6", text: "#17352a", accent: "#1b9c73" },
  { id: "sand", name: "Sand", background: "#fff8ed", text: "#412f21", accent: "#d87927" },
  { id: "graphite", name: "Graphite", background: "#f3f4f6", text: "#20242b", accent: "#4b5563" }
];

const uid = () => Math.random().toString(36).slice(2, 10);

const titleElement = (text: string, color = "#172033"): SlideElement => ({
  id: uid(),
  type: "text",
  x: 86,
  y: 92,
  w: 788,
  h: 110,
  text,
  fill: "transparent",
  color,
  fontSize: 48,
  fontWeight: 760,
  align: "left"
});

const bodyElement = (text: string, color = "#667085"): SlideElement => ({
  id: uid(),
  type: "text",
  x: 90,
  y: 220,
  w: 690,
  h: 180,
  text,
  fill: "transparent",
  color,
  fontSize: 24,
  fontWeight: 420,
  align: "left"
});

const sampleSlides: Slide[] = [
  {
    id: uid(),
    background: "#ffffff",
    transition: "fade",
    notes: "Open with the purpose of the presentation and the outcome you want from the audience.",
    elements: [
      titleElement("Build ideas that move people."),
      bodyElement("Tamishra Slides — a focused, local-first presentation workspace."),
      {
        id: uid(), type: "shape", shape: "rounded", x: 86, y: 422, w: 220, h: 10,
        fill: "#6f5df5", color: "#ffffff"
      }
    ]
  },
  {
    id: uid(),
    background: "#f3f0ff",
    transition: "slide",
    notes: "Use this slide to explain the three core ideas.",
    elements: [
      titleElement("One canvas. Clear story.", "#2b2358"),
      bodyElement("Create, arrange and present with a distraction-free editor built into Tamishra Workspace.", "#5f5680"),
      {
        id: uid(), type: "shape", shape: "rounded", x: 650, y: 190, w: 210, h: 210,
        fill: "#6f5df5", color: "#ffffff"
      },
      {
        id: uid(), type: "text", x: 688, y: 248, w: 134, h: 92, text: "16:9", fill: "transparent",
        color: "#ffffff", fontSize: 34, fontWeight: 800, align: "center"
      }
    ]
  },
  {
    id: uid(),
    background: "#111827",
    transition: "zoom",
    notes: "Close with the next action.",
    elements: [
      titleElement("Ready to present?", "#ffffff"),
      bodyElement("Press Present to run the deck full-screen. Add speaker notes on the right.", "#cbd5e1"),
      {
        id: uid(), type: "shape", shape: "rounded", x: 86, y: 414, w: 260, h: 64,
        fill: "#8b7cff", color: "#ffffff"
      },
      {
        id: uid(), type: "text", x: 114, y: 430, w: 204, h: 36, text: "Start presentation", fill: "transparent",
        color: "#ffffff", fontSize: 20, fontWeight: 750, align: "center"
      }
    ]
  }
];

const cloneSlides = (slides: Slide[]) => slides.map((slide) => ({
  ...slide,
  elements: slide.elements.map((element) => ({ ...element }))
}));

export default function SlidesEditor() {
  const [deckTitle, setDeckTitle] = useState("Untitled presentation");
  const [slides, setSlides] = useState<Slide[]>(() => cloneSlides(sampleSlides));
  const [activeId, setActiveId] = useState(sampleSlides[0].id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.82);
  const [showGrid, setShowGrid] = useState(false);
  const [snap, setSnap] = useState(true);
  const [inspectorMode, setInspectorMode] = useState<"slide" | "element" | "theme">("slide");
  const [saveState, setSaveState] = useState("Saved locally");
  const [presenterIndex, setPresenterIndex] = useState<number | null>(null);
  const [presenterScale, setPresenterScale] = useState(1);
  const [showPresenterNotes, setShowPresenterNotes] = useState(false);

  const imageInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const undoStack = useRef<Slide[][]>([]);
  const redoStack = useRef<Slide[][]>([]);
  const gesture = useRef<{
    id: string;
    startX: number;
    startY: number;
    start: SlideElement;
    snapshot: Slide[];
    mode: "move" | "resize";
    moved: boolean;
  } | null>(null);

  const activeIndex = Math.max(0, slides.findIndex((slide) => slide.id === activeId));
  const activeSlide = slides[activeIndex] ?? slides[0];
  const selectedElement = activeSlide?.elements.find((element) => element.id === selectedId) ?? null;

  useEffect(() => {
    try {
      const raw = localStorage.getItem("tamishra-slides-deck-v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { title?: string; slides?: Slide[] };
      if (parsed.slides?.length) {
        setSlides(parsed.slides);
        setActiveId(parsed.slides[0].id);
      }
      if (parsed.title) setDeckTitle(parsed.title);
    } catch {
      // Ignore malformed local drafts and keep the starter deck.
    }
  }, []);

  useEffect(() => {
    setSaveState("Saving…");
    const timer = window.setTimeout(() => {
      localStorage.setItem("tamishra-slides-deck-v1", JSON.stringify({ title: deckTitle, slides }));
      setSaveState("Saved locally");
    }, 450);
    return () => window.clearTimeout(timer);
  }, [deckTitle, slides]);

  useEffect(() => {
    if (presenterIndex === null) return;
    const resize = () => {
      const availableW = window.innerWidth * 0.96;
      const availableH = Math.max(240, window.innerHeight - 70);
      setPresenterScale(Math.min(availableW / 960, availableH / 540));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [presenterIndex]);

  const commit = (recipe: (current: Slide[]) => Slide[]) => {
    setSlides((current) => {
      undoStack.current.push(current);
      if (undoStack.current.length > 80) undoStack.current.shift();
      redoStack.current = [];
      return recipe(current);
    });
  };

  const mutateActive = (recipe: (slide: Slide) => Slide, record = true) => {
    const action = (current: Slide[]) =>
      current.map((slide) => slide.id === activeId ? recipe(slide) : slide);
    if (record) commit(action);
    else setSlides(action);
  };

  const undo = () => {
    setSlides((current) => {
      const previous = undoStack.current.pop();
      if (!previous) return current;
      redoStack.current.push(current);
      return previous;
    });
  };

  const redo = () => {
    setSlides((current) => {
      const next = redoStack.current.pop();
      if (!next) return current;
      undoStack.current.push(current);
      return next;
    });
  };

  const selectSlide = (id: string) => {
    setActiveId(id);
    setSelectedId(null);
    setEditingId(null);
    setInspectorMode("slide");
  };

  const addSlide = (layout: "title" | "content" | "blank" = "content") => {
    const theme = themes[0];
    const elements =
      layout === "blank" ? [] :
      layout === "title" ? [
        { ...titleElement("Presentation title", theme.text), y: 178, h: 110, align: "center" as const },
        { ...bodyElement("Subtitle", "#667085"), y: 300, w: 780, h: 70, align: "center" as const }
      ] :
      [titleElement("New slide", theme.text), bodyElement("Add your message here.", "#667085")];

    const slide: Slide = {
      id: uid(),
      background: theme.background,
      transition: "none",
      notes: "",
      elements
    };

    const insertAt = activeIndex + 1;
    commit((current) => [...current.slice(0, insertAt), slide, ...current.slice(insertAt)]);
    setActiveId(slide.id);
    setSelectedId(null);
  };

  const duplicateSlide = (id = activeId) => {
    const index = slides.findIndex((slide) => slide.id === id);
    if (index < 0) return;
    const source = slides[index];
    const copy: Slide = {
      ...source,
      id: uid(),
      elements: source.elements.map((element) => ({ ...element, id: uid() }))
    };
    commit((current) => [...current.slice(0, index + 1), copy, ...current.slice(index + 1)]);
    setActiveId(copy.id);
    setSelectedId(null);
  };

  const deleteSlide = (id = activeId) => {
    if (slides.length <= 1) return;
    const index = slides.findIndex((slide) => slide.id === id);
    const nextId = slides[Math.max(0, index - 1)]?.id ?? slides[0].id;
    commit((current) => current.filter((slide) => slide.id !== id));
    setActiveId(nextId);
    setSelectedId(null);
  };

  const moveSlide = (id: string, direction: -1 | 1) => {
    const index = slides.findIndex((slide) => slide.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= slides.length) return;
    commit((current) => {
      const updated = [...current];
      [updated[index], updated[next]] = [updated[next], updated[index]];
      return updated;
    });
  };

  const addElement = (element: Omit<SlideElement, "id">) => {
    const next = { ...element, id: uid() };
    mutateActive((slide) => ({ ...slide, elements: [...slide.elements, next] }));
    setSelectedId(next.id);
    setInspectorMode("element");
  };

  const addText = () => addElement({
    type: "text", x: 130, y: 150, w: 420, h: 92, text: "Type something",
    fill: "transparent", color: "#172033", fontSize: 34, fontWeight: 650, align: "left"
  });

  const addShape = (shape: ShapeType) => addElement({
    type: "shape", shape, x: 160, y: 170, w: 230, h: 145,
    fill: "#6f5df5", color: "#ffffff"
  });

  const addLine = () => addElement({
    type: "line", x: 160, y: 260, w: 330, h: 24,
    fill: "#6f5df5", color: "#6f5df5", rotation: 0
  });

  const addTable = () => addElement({
    type: "table", x: 150, y: 170, w: 500, h: 245,
    fill: "#6f5df5", color: "#172033"
  });

  const addChart = () => addElement({
    type: "chart", x: 170, y: 150, w: 470, h: 270,
    fill: "#6f5df5", color: "#172033"
  });

  const insertImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addElement({
      type: "image", src: String(reader.result), x: 190, y: 120, w: 420, h: 280,
      fill: "transparent", color: "#172033"
    });
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const updateElement = (id: string, patch: Partial<SlideElement>, record = true) => {
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => element.id === id ? { ...element, ...patch } : element)
    }), record);
  };

  const deleteElement = () => {
    if (!selectedId) return;
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.filter((element) => element.id !== selectedId)
    }));
    setSelectedId(null);
    setEditingId(null);
  };

  const duplicateElement = () => {
    if (!selectedElement) return;
    const copy = { ...selectedElement, id: uid(), x: selectedElement.x + 18, y: selectedElement.y + 18 };
    mutateActive((slide) => ({ ...slide, elements: [...slide.elements, copy] }));
    setSelectedId(copy.id);
  };

  const reorderElement = (direction: "front" | "back") => {
    if (!selectedId) return;
    mutateActive((slide) => {
      const element = slide.elements.find((item) => item.id === selectedId);
      if (!element) return slide;
      const rest = slide.elements.filter((item) => item.id !== selectedId);
      return { ...slide, elements: direction === "front" ? [...rest, element] : [element, ...rest] };
    });
  };

  const applyTheme = (theme: Theme, all = false) => {
    const styleSlide = (slide: Slide): Slide => ({
      ...slide,
      background: theme.background,
      elements: slide.elements.map((element) => {
        if (element.type === "text") return { ...element, color: element.fontSize && element.fontSize >= 32 ? theme.text : theme.text };
        if (element.type === "shape" || element.type === "line" || element.type === "chart") return { ...element, fill: theme.accent };
        return element;
      })
    });
    if (all) commit((current) => current.map(styleSlide));
    else mutateActive(styleSlide);
  };

  const setLayout = (layout: "title" | "content" | "blank") => {
    const title = activeSlide.elements.find((element) => element.type === "text" && (element.fontSize ?? 0) >= 32);
    const body = activeSlide.elements.find((element) => element.type === "text" && element.id !== title?.id);
    mutateActive((slide) => {
      const decorative = slide.elements.filter((element) => element.id !== title?.id && element.id !== body?.id);
      if (layout === "blank") return { ...slide, elements: decorative };
      const nextTitle = title ? { ...title } : titleElement("Slide title");
      if (layout === "title") {
        nextTitle.x = 90; nextTitle.y = 175; nextTitle.w = 780; nextTitle.h = 110; nextTitle.align = "center";
        const nextBody = body ? { ...body } : bodyElement("Subtitle");
        nextBody.x = 130; nextBody.y = 298; nextBody.w = 700; nextBody.h = 70; nextBody.align = "center";
        return { ...slide, elements: [nextTitle, nextBody, ...decorative] };
      }
      nextTitle.x = 86; nextTitle.y = 78; nextTitle.w = 788; nextTitle.h = 100; nextTitle.align = "left";
      const nextBody = body ? { ...body } : bodyElement("Add your message here.");
      nextBody.x = 90; nextBody.y = 205; nextBody.w = 690; nextBody.h = 200; nextBody.align = "left";
      return { ...slide, elements: [nextTitle, nextBody, ...decorative] };
    });
  };

  const snapValue = (value: number) => snap ? Math.round(value / 10) * 10 : Math.round(value);

  const beginGesture = (event: ReactPointerEvent<HTMLDivElement>, element: SlideElement, mode: "move" | "resize") => {
    if (editingId === element.id) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(element.id);
    setInspectorMode("element");
    gesture.current = {
      id: element.id,
      startX: event.clientX,
      startY: event.clientY,
      start: { ...element },
      snapshot: slides,
      mode,
      moved: false
    };
  };

  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state) return;
    const dx = (event.clientX - state.startX) / zoom;
    const dy = (event.clientY - state.startY) / zoom;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) state.moved = true;

    if (state.mode === "move") {
      updateElement(state.id, {
        x: Math.max(0, Math.min(960 - state.start.w, snapValue(state.start.x + dx))),
        y: Math.max(0, Math.min(540 - state.start.h, snapValue(state.start.y + dy)))
      }, false);
    } else {
      updateElement(state.id, {
        w: Math.max(30, Math.min(960 - state.start.x, snapValue(state.start.w + dx))),
        h: Math.max(24, Math.min(540 - state.start.y, snapValue(state.start.h + dy)))
      }, false);
    }
  };

  const endGesture = () => {
    const state = gesture.current;
    if (state?.moved) {
      undoStack.current.push(state.snapshot);
      redoStack.current = [];
    }
    gesture.current = null;
  };

  const exportDeck = () => {
    const blob = new Blob([JSON.stringify({ version: 1, title: deckTitle, slides }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = (deckTitle.trim() || "presentation").replace(/[^\w-]+/g, "-") + ".tamishra-slides.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importDeck = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as { title?: string; slides?: Slide[] };
        if (!data.slides?.length) return;
        undoStack.current.push(slides);
        redoStack.current = [];
        setSlides(data.slides);
        setActiveId(data.slides[0].id);
        setSelectedId(null);
        if (data.title) setDeckTitle(data.title);
      } catch {
        setSaveState("Import failed");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const shareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setSaveState("Workspace link copied");
    } catch {
      setSaveState("Copy link unavailable");
    }
  };

  const startPresentation = async () => {
    setPresenterIndex(activeIndex);
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Presentation still works in an in-app full-screen overlay.
    }
  };

  const stopPresentation = async () => {
    setPresenterIndex(null);
    setShowPresenterNotes(false);
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* no-op */ }
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable;
      const mod = event.ctrlKey || event.metaKey;

      if (presenterIndex !== null) {
        if (event.key === "Escape") { void stopPresentation(); return; }
        if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
          event.preventDefault();
          setPresenterIndex((index) => index === null ? null : Math.min(slides.length - 1, index + 1));
        }
        if (event.key === "ArrowLeft" || event.key === "PageUp") {
          event.preventDefault();
          setPresenterIndex((index) => index === null ? null : Math.max(0, index - 1));
        }
        return;
      }

      if (editing) return;
      if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if (mod && event.key.toLowerCase() === "d") {
        event.preventDefault();
        selectedId ? duplicateElement() : duplicateSlide();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedId) { event.preventDefault(); deleteElement(); }
        return;
      }
      if (event.key === "Escape") {
        setSelectedId(null);
        setEditingId(null);
        return;
      }
      if (selectedElement && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        const patch: Partial<SlideElement> = {};
        if (event.key === "ArrowLeft") patch.x = Math.max(0, selectedElement.x - amount);
        if (event.key === "ArrowRight") patch.x = Math.min(960 - selectedElement.w, selectedElement.x + amount);
        if (event.key === "ArrowUp") patch.y = Math.max(0, selectedElement.y - amount);
        if (event.key === "ArrowDown") patch.y = Math.min(540 - selectedElement.h, selectedElement.y + amount);
        updateElement(selectedElement.id, patch);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const animationClass = (transition: Transition) =>
    transition === "fade" ? styles.fadeIn :
    transition === "slide" ? styles.slideIn :
    transition === "zoom" ? styles.zoomIn : "";

  const renderElement = (element: SlideElement, interactive: boolean) => {
    const isSelected = interactive && selectedId === element.id;
    const style: CSSProperties = {
      left: element.x,
      top: element.y,
      width: element.w,
      height: element.h,
      transform: element.rotation ? "rotate(" + element.rotation + "deg)" : undefined
    };

    const content =
      element.type === "text" ? (
        <div
          className={styles.elementText}
          contentEditable={interactive && editingId === element.id}
          suppressContentEditableWarning
          onDoubleClick={(event) => { event.stopPropagation(); setEditingId(element.id); }}
          onKeyDown={(event) => event.stopPropagation()}
          onBlur={(event) => {
            if (!interactive) return;
            updateElement(element.id, { text: event.currentTarget.textContent ?? "" });
            setEditingId(null);
          }}
          style={{
            color: element.color,
            fontSize: element.fontSize ?? 28,
            fontWeight: element.fontWeight ?? 500,
            textAlign: element.align ?? "left",
            justifyContent: element.align === "center" ? "center" : undefined,
            alignItems: "center"
          }}
        >
          {element.text}
        </div>
      ) : element.type === "shape" ? (
        <div
          className={styles.shape + " " + (element.shape === "ellipse" ? styles.ellipse : element.shape === "rounded" ? styles.rounded : "")}
          style={{ background: element.fill }}
        />
      ) : element.type === "image" ? (
        <img className={styles.image} src={element.src} alt="" draggable={false} />
      ) : element.type === "line" ? (
        <div className={styles.line} style={{ background: element.fill }} />
      ) : element.type === "table" ? (
        <div className={styles.table}>
          {["Q1","Q2","Q3","42","58","73","64","81","92"].map((value, index) => (
            <div className={styles.tableCell} key={index}>{value}</div>
          ))}
        </div>
      ) : (
        <div className={styles.chart}>
          {[44,72,58,88].map((value, index) => (
            <div className={styles.bar} key={index} style={{ height: value + "%", background: element.fill }} />
          ))}
        </div>
      );

    return (
      <div
        key={element.id}
        className={styles.element + (isSelected ? " " + styles.elementSelected : "")}
        style={style}
        onPointerDown={interactive ? (event) => beginGesture(event, element, "move") : undefined}
        onPointerMove={interactive ? moveGesture : undefined}
        onPointerUp={interactive ? endGesture : undefined}
        onClick={interactive ? (event) => {
          event.stopPropagation();
          setSelectedId(element.id);
          setInspectorMode("element");
        } : undefined}
      >
        {content}
        {isSelected && editingId !== element.id && (
          <div
            className={styles.resizeHandle}
            onPointerDown={(event) => beginGesture(event, element, "resize")}
            onPointerMove={moveGesture}
            onPointerUp={endGesture}
          />
        )}
      </div>
    );
  };

  const renderSlide = (slide: Slide, interactive = false, className = "") => (
    <div
      className={styles.canvas + (showGrid && interactive ? " " + styles.grid : "") + (className ? " " + className : "")}
      style={{ background: slide.background }}
      onClick={interactive ? () => {
        setSelectedId(null);
        setEditingId(null);
        setInspectorMode("slide");
      } : undefined}
    >
      {slide.elements.map((element) => renderElement(element, interactive))}
    </div>
  );

  const printSlides = useMemo(() => slides.map((slide) => (
    <div className={styles.printSlide} key={slide.id}>
      <div style={{ transform: "scale(1.333333)", transformOrigin: "top left" }}>
        {renderSlide(slide)}
      </div>
    </div>
  )), [slides]);

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <a href="/" className={styles.back} aria-label="Back to workspace">←</a>
        <div className={styles.appMark}>P</div>
        <div className={styles.titleWrap}>
          <input className={styles.fileTitle} value={deckTitle} onChange={(event) => setDeckTitle(event.target.value)} aria-label="Presentation title" />
          <span className={styles.fileMeta}>{saveState} · {slides.length} slides</span>
        </div>
        <div className={styles.headerSpacer} />
        <button className={styles.iconBtn} onClick={undo} title="Undo (Ctrl+Z)">↶</button>
        <button className={styles.iconBtn} onClick={redo} title="Redo (Ctrl+Y)">↷</button>
        <button className={styles.ghostBtn} onClick={shareLink}>Share</button>
        <button className={styles.primaryBtn} onClick={startPresentation}>▶ Present</button>
      </header>

      <nav className={styles.menuBar} aria-label="Presentation menu">
        <button className={styles.menuItem} onClick={() => addSlide("content")}>New slide</button>
        <button className={styles.menuItem} onClick={() => importInput.current?.click()}>Import</button>
        <button className={styles.menuItem} onClick={exportDeck}>Export</button>
        <button className={styles.menuItem} onClick={() => window.print()}>Print / PDF</button>
        <button className={styles.menuItem} onClick={duplicateSlide}>Duplicate slide</button>
        <button className={styles.menuItem} onClick={() => setInspectorMode("theme")}>Theme</button>
      </nav>

      <section className={styles.toolbar}>
        <button className={styles.toolbarBtn} onClick={addText}>Text</button>
        <button className={styles.toolbarBtn} onClick={() => addShape("rect")}>Rectangle</button>
        <button className={styles.toolbarBtn} onClick={() => addShape("ellipse")}>Circle</button>
        <button className={styles.toolbarBtn} onClick={() => addShape("rounded")}>Rounded</button>
        <button className={styles.toolbarBtn} onClick={addLine}>Line</button>
        <button className={styles.toolbarBtn} onClick={() => imageInput.current?.click()}>Image</button>
        <button className={styles.toolbarBtn} onClick={addTable}>Table</button>
        <button className={styles.toolbarBtn} onClick={addChart}>Chart</button>
        <span className={styles.divider} />
        <button className={styles.toolbarBtn} onClick={() => setLayout("title")}>Title layout</button>
        <button className={styles.toolbarBtn} onClick={() => setLayout("content")}>Content layout</button>
        <button className={styles.toolbarBtn} onClick={() => setLayout("blank")}>Blank</button>
        <span className={styles.divider} />
        <button className={styles.toolbarBtn + (showGrid ? " " + styles.toolbarBtnActive : "")} onClick={() => setShowGrid((value) => !value)}>Grid</button>
        <button className={styles.toolbarBtn + (snap ? " " + styles.toolbarBtnActive : "")} onClick={() => setSnap((value) => !value)}>Snap</button>
        {selectedElement && (
          <>
            <span className={styles.divider} />
            <button className={styles.toolbarBtn} onClick={duplicateElement}>Duplicate object</button>
            <button className={styles.toolbarBtn} onClick={deleteElement}>Delete object</button>
          </>
        )}
      </section>

      <section className={styles.workspace}>
        <aside className={styles.navigator}>
          <div className={styles.navTop}>
            <button className={styles.primaryBtn} onClick={() => addSlide("content")}>+ Slide</button>
            <button className={styles.ghostBtn} onClick={() => addSlide("blank")} title="Add blank slide">Blank</button>
          </div>
          {slides.map((slide, index) => (
            <div
              className={styles.slideRow + (slide.id === activeId ? " " + styles.slideRowActive : "")}
              key={slide.id}
              onClick={() => selectSlide(slide.id)}
            >
              <span className={styles.slideNumber}>{index + 1}</span>
              <div className={styles.thumbnail}>
                <div className={styles.thumbCanvas}>{renderSlide(slide)}</div>
              </div>
              <div className={styles.navActions}>
                <button className={styles.miniBtn} onClick={(event) => { event.stopPropagation(); moveSlide(slide.id, -1); }} title="Move up">↑</button>
                <button className={styles.miniBtn} onClick={(event) => { event.stopPropagation(); moveSlide(slide.id, 1); }} title="Move down">↓</button>
                <button className={styles.miniBtn} onClick={(event) => { event.stopPropagation(); duplicateSlide(slide.id); }} title="Duplicate">⧉</button>
                <button className={styles.miniBtn} onClick={(event) => { event.stopPropagation(); deleteSlide(slide.id); }} title="Delete">×</button>
              </div>
            </div>
          ))}
        </aside>

        <div className={styles.stageArea}>
          <div className={styles.stageScroll}>
            <div className={styles.stageFrame} style={{ width: 960 * zoom, height: 540 * zoom }}>
              <div style={{ transform: "scale(" + zoom + ")", transformOrigin: "top left" }}>
                {renderSlide(activeSlide, true)}
              </div>
            </div>
          </div>
        </div>

        <aside className={styles.inspector}>
          <div className={styles.inspectorHeader}>
            <button className={styles.inspectorTab + (inspectorMode === "slide" ? " " + styles.inspectorTabActive : "")} onClick={() => setInspectorMode("slide")}>Slide</button>
            <button className={styles.inspectorTab + (inspectorMode === "element" ? " " + styles.inspectorTabActive : "")} onClick={() => setInspectorMode("element")}>Object</button>
            <button className={styles.inspectorTab + (inspectorMode === "theme" ? " " + styles.inspectorTabActive : "")} onClick={() => setInspectorMode("theme")}>Theme</button>
          </div>

          {inspectorMode === "slide" && (
            <>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Slide setup</h3>
                <div className={styles.field}>
                  <label>Background</label>
                  <div className={styles.colorRow}>
                    <input type="color" value={activeSlide.background} onChange={(event) => mutateActive((slide) => ({ ...slide, background: event.target.value }))} />
                    <input value={activeSlide.background} onChange={(event) => mutateActive((slide) => ({ ...slide, background: event.target.value }))} />
                  </div>
                </div>
                <div className={styles.field}>
                  <label>Transition</label>
                  <select value={activeSlide.transition} onChange={(event) => mutateActive((slide) => ({ ...slide, transition: event.target.value as Transition }))}>
                    <option value="none">None</option>
                    <option value="fade">Fade</option>
                    <option value="slide">Slide</option>
                    <option value="zoom">Zoom</option>
                  </select>
                </div>
              </div>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Speaker notes</h3>
                <div className={styles.field}>
                  <textarea
                    value={activeSlide.notes}
                    placeholder="Add notes for the presenter…"
                    onChange={(event) => mutateActive((slide) => ({ ...slide, notes: event.target.value }))}
                  />
                </div>
              </div>
            </>
          )}

          {inspectorMode === "element" && selectedElement && (
            <>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Position & size</h3>
                <div className={styles.fieldRow}>
                  <div className={styles.field}><label>X</label><input type="number" value={Math.round(selectedElement.x)} onChange={(e) => updateElement(selectedElement.id, { x: Number(e.target.value) })} /></div>
                  <div className={styles.field}><label>Y</label><input type="number" value={Math.round(selectedElement.y)} onChange={(e) => updateElement(selectedElement.id, { y: Number(e.target.value) })} /></div>
                  <div className={styles.field}><label>Width</label><input type="number" value={Math.round(selectedElement.w)} onChange={(e) => updateElement(selectedElement.id, { w: Math.max(20, Number(e.target.value)) })} /></div>
                  <div className={styles.field}><label>Height</label><input type="number" value={Math.round(selectedElement.h)} onChange={(e) => updateElement(selectedElement.id, { h: Math.max(20, Number(e.target.value)) })} /></div>
                </div>
                <div className={styles.field}><label>Rotation</label><input type="number" value={selectedElement.rotation ?? 0} onChange={(e) => updateElement(selectedElement.id, { rotation: Number(e.target.value) })} /></div>
              </div>

              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Appearance</h3>
                {(selectedElement.type === "shape" || selectedElement.type === "line" || selectedElement.type === "chart") && (
                  <div className={styles.field}>
                    <label>Fill / accent</label>
                    <div className={styles.colorRow}>
                      <input type="color" value={selectedElement.fill} onChange={(e) => updateElement(selectedElement.id, { fill: e.target.value })} />
                      <input value={selectedElement.fill} onChange={(e) => updateElement(selectedElement.id, { fill: e.target.value })} />
                    </div>
                  </div>
                )}
                {selectedElement.type === "text" && (
                  <>
                    <div className={styles.field}>
                      <label>Text color</label>
                      <div className={styles.colorRow}>
                        <input type="color" value={selectedElement.color} onChange={(e) => updateElement(selectedElement.id, { color: e.target.value })} />
                        <input value={selectedElement.color} onChange={(e) => updateElement(selectedElement.id, { color: e.target.value })} />
                      </div>
                    </div>
                    <div className={styles.fieldRow}>
                      <div className={styles.field}><label>Font size</label><input type="number" value={selectedElement.fontSize ?? 28} onChange={(e) => updateElement(selectedElement.id, { fontSize: Number(e.target.value) })} /></div>
                      <div className={styles.field}><label>Weight</label><input type="number" min="100" max="900" step="50" value={selectedElement.fontWeight ?? 500} onChange={(e) => updateElement(selectedElement.id, { fontWeight: Number(e.target.value) })} /></div>
                    </div>
                    <div className={styles.field}>
                      <label>Alignment</label>
                      <select value={selectedElement.align ?? "left"} onChange={(e) => updateElement(selectedElement.id, { align: e.target.value as "left" | "center" | "right" })}>
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </div>
                  </>
                )}
                <button className={styles.inspectorBtn} onClick={() => reorderElement("front")}>Bring to front</button>
                <button className={styles.inspectorBtn} onClick={() => reorderElement("back")}>Send to back</button>
                <button className={styles.inspectorBtn} onClick={duplicateElement}>Duplicate object</button>
                <button className={styles.inspectorBtn} onClick={deleteElement}>Delete object</button>
              </div>
            </>
          )}

          {inspectorMode === "element" && !selectedElement && (
            <div className={styles.emptyInspector}>Select an object on the slide to edit its position, size, color and typography.</div>
          )}

          {inspectorMode === "theme" && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Presentation themes</h3>
              <div className={styles.themeGrid}>
                {themes.map((theme) => (
                  <button className={styles.themeBtn} key={theme.id} onClick={() => applyTheme(theme)}>
                    <div className={styles.themeSwatch} style={{ background: "linear-gradient(135deg, " + theme.background + " 0 68%, " + theme.accent + " 68%)" }} />
                    <span className={styles.themeName}>{theme.name}</span>
                  </button>
                ))}
              </div>
              <button className={styles.inspectorBtn} onClick={() => applyTheme(themes[0], true)}>Apply Paper to all slides</button>
              <button className={styles.inspectorBtn} onClick={() => {
                const currentTheme = themes.find((theme) => theme.background === activeSlide.background) ?? themes[0];
                applyTheme(currentTheme, true);
              }}>Apply current theme to all</button>
            </div>
          )}
        </aside>
      </section>

      <footer className={styles.statusBar}>
        <span>Slide {activeIndex + 1} of {slides.length}</span>
        <span>16:9 widescreen</span>
        <span>{snap ? "Snapping on" : "Snapping off"}</span>
        <span className={styles.statusSpacer} />
        <div className={styles.zoomControl}>
          <span>{Math.round(zoom * 100)}%</span>
          <input type="range" min="0.45" max="1.25" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
        </div>
      </footer>

      <input ref={imageInput} type="file" accept="image/*" hidden onChange={insertImage} />
      <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={importDeck} />

      <div className={styles.printDeck}>{printSlides}</div>

      {presenterIndex !== null && slides[presenterIndex] && (
        <div className={styles.presenter}>
          <div className={styles.presenterStage}>
            <div
              key={slides[presenterIndex].id}
              className={styles.presenterCanvas + " " + animationClass(slides[presenterIndex].transition)}
              style={{ transform: "scale(" + presenterScale + ")" }}
            >
              {renderSlide(slides[presenterIndex])}
            </div>
          </div>
          {showPresenterNotes && slides[presenterIndex].notes && (
            <div className={styles.presenterNotes}>{slides[presenterIndex].notes}</div>
          )}
          <div className={styles.presenterControls}>
            <button onClick={() => setPresenterIndex((index) => index === null ? null : Math.max(0, index - 1))}>← Previous</button>
            <span>{presenterIndex + 1} / {slides.length}</span>
            <button onClick={() => setPresenterIndex((index) => index === null ? null : Math.min(slides.length - 1, index + 1))}>Next →</button>
            <button onClick={() => setShowPresenterNotes((value) => !value)}>Notes</button>
            <button onClick={() => void stopPresentation()}>Exit</button>
          </div>
        </div>
      )}
    </main>
  );
}
