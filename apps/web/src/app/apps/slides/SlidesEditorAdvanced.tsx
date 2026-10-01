"use client";

import {
  ChangeEvent,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  alignSelection,
  alignSelectionToSlide,
  distributeSelection,
  expandSelectionForGroups,
  groupSelection,
  selectionBounds,
  selectionFromClickedElement,
  ungroupSelection,
  type AlignMode,
  type DistributeAxis
} from "@tamishra/slides-core";
import styles from "./slides.module.css";

type ElementType = "text" | "shape" | "image" | "line" | "table" | "chart";
type ShapeType = "rect" | "ellipse" | "rounded";
type Transition = "none" | "fade" | "slide" | "zoom";
type ChartKind = "bar" | "line" | "donut";
type SlideLayout = "title" | "content" | "section" | "two-column" | "blank";
type Placeholder = "title" | "body" | "body2";

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
  groupId?: string;
  placeholder?: Placeholder;
  tableData?: string[][];
  chartData?: number[];
  chartLabels?: string[];
  chartKind?: ChartKind;
};

type Slide = {
  id: string;
  background: string;
  transition: Transition;
  notes: string;
  layout?: SlideLayout;
  elements: SlideElement[];
};

type Theme = {
  id: string;
  name: string;
  background: string;
  text: string;
  muted: string;
  accent: string;
};

type GuideState = {
  x?: number;
  y?: number;
};

const SLIDE_W = 960;
const SLIDE_H = 540;
const GUIDE_TOLERANCE = 7;

const themes: Theme[] = [
  { id: "paper", name: "Paper", background: "#ffffff", text: "#172033", muted: "#667085", accent: "#6f5df5" },
  { id: "midnight", name: "Midnight", background: "#111827", text: "#f8fafc", muted: "#cbd5e1", accent: "#8b7cff" },
  { id: "ocean", name: "Ocean", background: "#ecf7ff", text: "#12324a", muted: "#476a82", accent: "#1473e6" },
  { id: "mint", name: "Mint", background: "#effaf6", text: "#17352a", muted: "#587268", accent: "#1b9c73" },
  { id: "sand", name: "Sand", background: "#fff8ed", text: "#412f21", muted: "#7c6756", accent: "#d87927" },
  { id: "graphite", name: "Graphite", background: "#f3f4f6", text: "#20242b", muted: "#616873", accent: "#4b5563" }
];

const uid = () => Math.random().toString(36).slice(2, 10);

const textElement = (
  placeholder: Placeholder,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fontSize: number,
  fontWeight: number,
  color: string,
  align: "left" | "center" | "right" = "left"
): SlideElement => ({
  id: uid(),
  type: "text",
  placeholder,
  x,
  y,
  w,
  h,
  text,
  fill: "transparent",
  color,
  fontSize,
  fontWeight,
  align
});

const layoutElements = (layout: SlideLayout, theme = themes[0]): SlideElement[] => {
  if (layout === "blank") return [];

  if (layout === "title") {
    return [
      textElement("title", "Presentation title", 90, 168, 780, 116, 54, 780, theme.text, "center"),
      textElement("body", "Subtitle or presenter", 130, 298, 700, 72, 24, 430, theme.muted, "center")
    ];
  }

  if (layout === "section") {
    return [
      textElement("title", "Section title", 100, 170, 760, 118, 52, 780, theme.text, "left"),
      textElement("body", "A short statement that introduces the next idea.", 104, 304, 650, 90, 23, 430, theme.muted, "left"),
      {
        id: uid(),
        type: "shape",
        shape: "rounded",
        x: 100,
        y: 132,
        w: 94,
        h: 9,
        fill: theme.accent,
        color: "#ffffff"
      }
    ];
  }

  if (layout === "two-column") {
    return [
      textElement("title", "Two-column story", 78, 64, 804, 92, 42, 760, theme.text),
      textElement("body", "Left-side message", 82, 182, 370, 250, 24, 430, theme.muted),
      textElement("body2", "Right-side message", 508, 182, 370, 250, 24, 430, theme.muted),
      {
        id: uid(),
        type: "line",
        x: 478,
        y: 184,
        w: 2,
        h: 250,
        fill: theme.accent,
        color: theme.accent,
        rotation: 90
      }
    ];
  }

  return [
    textElement("title", "Slide title", 86, 76, 788, 104, 46, 760, theme.text),
    textElement("body", "Add your message here.", 90, 205, 700, 210, 24, 430, theme.muted)
  ];
};

const starterSlides: Slide[] = [
  {
    id: uid(),
    background: "#ffffff",
    transition: "fade",
    notes: "Open with the purpose of the presentation and the outcome you want from the audience.",
    layout: "content",
    elements: [
      textElement("title", "Build ideas that move people.", 86, 92, 788, 110, 48, 760, "#172033"),
      textElement("body", "Tamishra Slides — a focused, local-first presentation workspace.", 90, 220, 690, 180, 24, 420, "#667085"),
      { id: uid(), type: "shape", shape: "rounded", x: 86, y: 422, w: 220, h: 10, fill: "#6f5df5", color: "#ffffff" }
    ]
  },
  {
    id: uid(),
    background: "#f3f0ff",
    transition: "slide",
    notes: "Use this slide to explain the three core ideas.",
    layout: "content",
    elements: [
      textElement("title", "One canvas. Clear story.", 86, 92, 788, 110, 48, 760, "#2b2358"),
      textElement("body", "Create, arrange and present with a distraction-free editor built into Tamishra Workspace.", 90, 220, 690, 180, 24, 420, "#5f5680"),
      { id: uid(), type: "shape", shape: "rounded", x: 650, y: 190, w: 210, h: 210, fill: "#6f5df5", color: "#ffffff" },
      { id: uid(), type: "text", x: 688, y: 248, w: 134, h: 92, text: "16:9", fill: "transparent", color: "#ffffff", fontSize: 34, fontWeight: 800, align: "center" }
    ]
  },
  {
    id: uid(),
    background: "#111827",
    transition: "zoom",
    notes: "Close with the next action.",
    layout: "content",
    elements: [
      textElement("title", "Ready to present?", 86, 92, 788, 110, 48, 760, "#ffffff"),
      textElement("body", "Press Present to run the deck full-screen. Add speaker notes on the right.", 90, 220, 690, 180, 24, 420, "#cbd5e1"),
      { id: uid(), type: "shape", shape: "rounded", x: 86, y: 414, w: 260, h: 64, fill: "#8b7cff", color: "#ffffff" },
      { id: uid(), type: "text", x: 114, y: 430, w: 204, h: 36, text: "Start presentation", fill: "transparent", color: "#ffffff", fontSize: 20, fontWeight: 750, align: "center" }
    ]
  }
];

const cloneSlides = (slides: Slide[]) => slides.map((slide) => ({
  ...slide,
  elements: slide.elements.map((element) => ({
    ...element,
    tableData: element.tableData?.map((row) => [...row]),
    chartData: element.chartData ? [...element.chartData] : undefined,
    chartLabels: element.chartLabels ? [...element.chartLabels] : undefined
  }))
}));

const closestTheme = (background: string) =>
  themes.find((theme) => theme.background.toLowerCase() === background.toLowerCase()) ?? themes[0];

const cloneElements = (elements: SlideElement[], offset = 18) => {
  const groupMap = new Map<string, string>();
  return elements.map((element) => {
    let groupId: string | undefined;
    if (element.groupId) {
      groupId = groupMap.get(element.groupId);
      if (!groupId) {
        groupId = uid();
        groupMap.set(element.groupId, groupId);
      }
    }
    return {
      ...element,
      id: uid(),
      groupId,
      x: Math.max(0, Math.min(SLIDE_W - element.w, element.x + offset)),
      y: Math.max(0, Math.min(SLIDE_H - element.h, element.y + offset)),
      tableData: element.tableData?.map((row) => [...row]),
      chartData: element.chartData ? [...element.chartData] : undefined,
      chartLabels: element.chartLabels ? [...element.chartLabels] : undefined
    };
  });
};

const linePoints = (values: number[]) => {
  if (!values.length) return "";
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  return values.map((value, index) => {
    const x = values.length === 1 ? 50 : 6 + (index / (values.length - 1)) * 88;
    const y = 92 - ((value - min) / range) * 82;
    return x + "," + y;
  }).join(" ");
};

const donutGradient = (values: number[], fill: string) => {
  const safe = values.map((value) => Math.max(0, value));
  const total = safe.reduce((sum, value) => sum + value, 0) || 1;
  const colors = [fill, "#9b8ff7", "#c4bdfc", "#dcd8fe", "#5c4bd6", "#b8adff"];
  let cursor = 0;
  const stops = safe.map((value, index) => {
    const start = cursor;
    cursor += (value / total) * 100;
    return colors[index % colors.length] + " " + start + "% " + cursor + "%";
  });
  return "conic-gradient(" + stops.join(", ") + ")";
};

export default function SlidesEditorAdvanced() {
  const [deckTitle, setDeckTitle] = useState("Untitled presentation");
  const [slides, setSlides] = useState<Slide[]>(() => cloneSlides(starterSlides));
  const [activeId, setActiveId] = useState(starterSlides[0].id);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.82);
  const [showGrid, setShowGrid] = useState(false);
  const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState<GuideState>({});
  const [inspectorMode, setInspectorMode] = useState<"slide" | "element" | "theme">("slide");
  const [saveState, setSaveState] = useState("Saved locally");
  const [presenterIndex, setPresenterIndex] = useState<number | null>(null);
  const [presenterScale, setPresenterScale] = useState(1);
  const [showPresenterNotes, setShowPresenterNotes] = useState(false);

  const imageInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const undoStack = useRef<Slide[][]>([]);
  const redoStack = useRef<Slide[][]>([]);
  const internalClipboard = useRef<SlideElement[]>([]);
  const gesture = useRef<{
    primaryId: string;
    movingIds: string[];
    startX: number;
    startY: number;
    starts: Map<string, SlideElement>;
    snapshot: Slide[];
    mode: "move" | "resize";
    moved: boolean;
  } | null>(null);

  const activeIndex = Math.max(0, slides.findIndex((slide) => slide.id === activeId));
  const activeSlide = slides[activeIndex] ?? slides[0];
  const selectedElements = activeSlide?.elements.filter((element) => selectedIds.includes(element.id)) ?? [];
  const primaryElement = selectedElements[selectedElements.length - 1] ?? null;
  const expandedSelection = activeSlide ? expandSelectionForGroups(activeSlide.elements, selectedIds) : [];
  const hasGroupSelection = selectedElements.some((element) => element.groupId);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("tamishra-slides-deck-v2") ?? localStorage.getItem("tamishra-slides-deck-v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { title?: string; slides?: Slide[] };
      if (parsed.slides?.length) {
        const normalized = parsed.slides.map((slide) => ({
          ...slide,
          layout: slide.layout ?? "content",
          elements: slide.elements.map((element) => ({ ...element }))
        }));
        setSlides(normalized);
        setActiveId(normalized[0].id);
      }
      if (parsed.title) setDeckTitle(parsed.title);
    } catch {
      // Keep the starter deck if a local draft is malformed.
    }
  }, []);

  useEffect(() => {
    setSaveState("Saving…");
    const timer = window.setTimeout(() => {
      localStorage.setItem("tamishra-slides-deck-v2", JSON.stringify({ title: deckTitle, slides }));
      setSaveState("Saved locally");
    }, 420);
    return () => window.clearTimeout(timer);
  }, [deckTitle, slides]);

  useEffect(() => {
    if (presenterIndex === null) return;
    const resize = () => {
      const availableW = window.innerWidth * 0.96;
      const availableH = Math.max(240, window.innerHeight - 70);
      setPresenterScale(Math.min(availableW / SLIDE_W, availableH / SLIDE_H));
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [presenterIndex]);

  const commit = (recipe: (current: Slide[]) => Slide[]) => {
    setSlides((current) => {
      undoStack.current.push(current);
      if (undoStack.current.length > 100) undoStack.current.shift();
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
    setSelectedIds([]);
    setEditingId(null);
  };

  const redo = () => {
    setSlides((current) => {
      const next = redoStack.current.pop();
      if (!next) return current;
      undoStack.current.push(current);
      return next;
    });
    setSelectedIds([]);
    setEditingId(null);
  };

  const clearSelection = () => {
    setSelectedIds([]);
    setEditingId(null);
    setGuides({});
    setInspectorMode("slide");
  };

  const selectSlide = (id: string) => {
    setActiveId(id);
    clearSelection();
  };

  const addSlide = (layout: SlideLayout = "content") => {
    const theme = closestTheme(activeSlide?.background ?? "#ffffff");
    const slide: Slide = {
      id: uid(),
      background: theme.background,
      transition: "none",
      notes: "",
      layout,
      elements: layoutElements(layout, theme)
    };
    const insertAt = activeIndex + 1;
    commit((current) => [...current.slice(0, insertAt), slide, ...current.slice(insertAt)]);
    setActiveId(slide.id);
    setSelectedIds([]);
  };

  const duplicateSlide = (id = activeId) => {
    const index = slides.findIndex((slide) => slide.id === id);
    if (index < 0) return;
    const source = slides[index];
    const copy: Slide = {
      ...source,
      id: uid(),
      elements: cloneElements(source.elements, 0)
    };
    commit((current) => [...current.slice(0, index + 1), copy, ...current.slice(index + 1)]);
    setActiveId(copy.id);
    setSelectedIds([]);
  };

  const deleteSlide = (id = activeId) => {
    if (slides.length <= 1) return;
    const index = slides.findIndex((slide) => slide.id === id);
    const nextId = slides[Math.max(0, index - 1)]?.id ?? slides[0].id;
    commit((current) => current.filter((slide) => slide.id !== id));
    setActiveId(nextId);
    setSelectedIds([]);
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
    setSelectedIds([next.id]);
    setInspectorMode("element");
  };

  const addText = () => addElement({
    type: "text",
    x: 130,
    y: 150,
    w: 420,
    h: 92,
    text: "Type something",
    fill: "transparent",
    color: "#172033",
    fontSize: 34,
    fontWeight: 650,
    align: "left"
  });

  const addShape = (shape: ShapeType) => addElement({
    type: "shape",
    shape,
    x: 160,
    y: 170,
    w: 230,
    h: 145,
    fill: "#6f5df5",
    color: "#ffffff"
  });

  const addLine = () => addElement({
    type: "line",
    x: 160,
    y: 260,
    w: 330,
    h: 24,
    fill: "#6f5df5",
    color: "#6f5df5",
    rotation: 0
  });

  const addTable = () => addElement({
    type: "table",
    x: 150,
    y: 170,
    w: 500,
    h: 245,
    fill: "#6f5df5",
    color: "#172033",
    tableData: [
      ["Quarter", "Plan", "Actual"],
      ["Q1", "42", "39"],
      ["Q2", "58", "61"],
      ["Q3", "73", "76"]
    ]
  });

  const addChart = () => addElement({
    type: "chart",
    x: 170,
    y: 150,
    w: 470,
    h: 270,
    fill: "#6f5df5",
    color: "#172033",
    chartKind: "bar",
    chartData: [44, 72, 58, 88],
    chartLabels: ["Q1", "Q2", "Q3", "Q4"]
  });

  const insertImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => addElement({
      type: "image",
      src: String(reader.result),
      x: 190,
      y: 120,
      w: 420,
      h: 280,
      fill: "transparent",
      color: "#172033"
    });
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const updateElement = (id: string, patch: Partial<SlideElement>, record = true) => {
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.map((element) =>
        element.id === id ? { ...element, ...patch } : element
      )
    }), record);
  };

  const updateSelection = (patch: Partial<SlideElement>) => {
    if (!expandedSelection.length) return;
    const ids = new Set(expandedSelection);
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.map((element) =>
        ids.has(element.id) ? { ...element, ...patch } : element
      )
    }));
  };

  const deleteSelection = () => {
    if (!expandedSelection.length) return;
    const ids = new Set(expandedSelection);
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.filter((element) => !ids.has(element.id))
    }));
    setSelectedIds([]);
    setEditingId(null);
  };

  const duplicateSelection = () => {
    if (!expandedSelection.length) return;
    const selectedSet = new Set(expandedSelection);
    const source = activeSlide.elements.filter((element) => selectedSet.has(element.id));
    const copies = cloneElements(source);
    mutateActive((slide) => ({ ...slide, elements: [...slide.elements, ...copies] }));
    setSelectedIds(copies.map((element) => element.id));
    setInspectorMode("element");
  };

  const reorderSelection = (direction: "front" | "back") => {
    if (!expandedSelection.length) return;
    const selectedSet = new Set(expandedSelection);
    mutateActive((slide) => {
      const selected = slide.elements.filter((element) => selectedSet.has(element.id));
      const rest = slide.elements.filter((element) => !selectedSet.has(element.id));
      return {
        ...slide,
        elements: direction === "front" ? [...rest, ...selected] : [...selected, ...rest]
      };
    });
  };

  const groupSelected = () => {
    if (expandedSelection.length < 2) return;
    const ids = new Set(expandedSelection);
    mutateActive((slide) => ({
      ...slide,
      elements: groupSelection(slide.elements, ids, uid())
    }));
  };

  const ungroupSelected = () => {
    if (!expandedSelection.length) return;
    const ids = new Set(expandedSelection);
    mutateActive((slide) => ({
      ...slide,
      elements: ungroupSelection(slide.elements, ids)
    }));
  };

  const alignSelected = (mode: AlignMode, toSlide = false) => {
    if (!expandedSelection.length) return;
    const ids = new Set(expandedSelection);
    mutateActive((slide) => ({
      ...slide,
      elements: toSlide
        ? alignSelectionToSlide(slide.elements, ids, mode)
        : alignSelection(slide.elements, ids, mode)
    }));
  };

  const distributeSelected = (axis: DistributeAxis) => {
    if (expandedSelection.length < 3) return;
    const ids = new Set(expandedSelection);
    mutateActive((slide) => ({
      ...slide,
      elements: distributeSelection(slide.elements, ids, axis)
    }));
  };

  const copySelection = () => {
    if (!expandedSelection.length) return;
    const ids = new Set(expandedSelection);
    internalClipboard.current = activeSlide.elements
      .filter((element) => ids.has(element.id))
      .map((element) => ({
        ...element,
        tableData: element.tableData?.map((row) => [...row]),
        chartData: element.chartData ? [...element.chartData] : undefined,
        chartLabels: element.chartLabels ? [...element.chartLabels] : undefined
      }));
    setSaveState(expandedSelection.length + " object" + (expandedSelection.length === 1 ? "" : "s") + " copied");
  };

  const cutSelection = () => {
    copySelection();
    deleteSelection();
  };

  const pasteSelection = () => {
    if (!internalClipboard.current.length) return;
    const copies = cloneElements(internalClipboard.current, 24);
    mutateActive((slide) => ({ ...slide, elements: [...slide.elements, ...copies] }));
    setSelectedIds(copies.map((element) => element.id));
    setInspectorMode("element");
  };

  const applyTheme = (theme: Theme, all = false) => {
    const styleSlide = (slide: Slide): Slide => ({
      ...slide,
      background: theme.background,
      elements: slide.elements.map((element) => {
        if (element.type === "text") {
          const isTitle = element.placeholder === "title" || (element.fontSize ?? 0) >= 32;
          return { ...element, color: isTitle ? theme.text : theme.muted };
        }
        if (element.type === "shape" || element.type === "line" || element.type === "chart") {
          return { ...element, fill: theme.accent };
        }
        return element;
      })
    });
    if (all) commit((current) => current.map(styleSlide));
    else mutateActive(styleSlide);
  };

  const relayoutSlide = (slide: Slide, layout: SlideLayout): Slide => {
    const theme = closestTheme(slide.background);
    if (layout === "blank") {
      return {
        ...slide,
        layout,
        elements: slide.elements.filter((element) => element.type !== "text" || !element.placeholder)
      };
    }

    const currentTexts = slide.elements.filter((element) => element.type === "text");
    const titleText =
      currentTexts.find((element) => element.placeholder === "title")?.text ??
      currentTexts[0]?.text ??
      "Slide title";
    const bodyText =
      currentTexts.find((element) => element.placeholder === "body")?.text ??
      currentTexts[1]?.text ??
      "Add your message here.";
    const body2Text =
      currentTexts.find((element) => element.placeholder === "body2")?.text ??
      currentTexts[2]?.text ??
      "Add a second message here.";

    const template = layoutElements(layout, theme).map((element) => {
      if (element.placeholder === "title") return { ...element, text: titleText };
      if (element.placeholder === "body") return { ...element, text: bodyText };
      if (element.placeholder === "body2") return { ...element, text: body2Text };
      return element;
    });

    const placeholderIds = new Set(
      currentTexts
        .filter((element) => element.placeholder)
        .map((element) => element.id)
    );
    if (!placeholderIds.size) {
      currentTexts.slice(0, layout === "two-column" ? 3 : 2).forEach((element) => placeholderIds.add(element.id));
    }

    const preserved = slide.elements.filter((element) => !placeholderIds.has(element.id));
    return { ...slide, layout, elements: [...template, ...preserved] };
  };

  const applyLayout = (layout: SlideLayout) => {
    mutateActive((slide) => relayoutSlide(slide, layout));
    setSelectedIds([]);
  };

  const applyLayoutToAll = (layout: SlideLayout) => {
    commit((current) => current.map((slide) => relayoutSlide(slide, layout)));
    setSelectedIds([]);
  };

  const snapValue = (value: number) => snap ? Math.round(value / 10) * 10 : Math.round(value);

  const smartGuideDelta = (
    primary: SlideElement,
    dx: number,
    dy: number,
    movingIds: string[]
  ) => {
    const proposed = {
      x: primary.x + dx,
      y: primary.y + dy,
      w: primary.w,
      h: primary.h
    };
    const others = activeSlide.elements.filter((element) => !movingIds.includes(element.id));

    const targetXs = [0, SLIDE_W / 2, SLIDE_W];
    const targetYs = [0, SLIDE_H / 2, SLIDE_H];

    for (const element of others) {
      targetXs.push(element.x, element.x + element.w / 2, element.x + element.w);
      targetYs.push(element.y, element.y + element.h / 2, element.y + element.h);
    }

    const anchorsX = [proposed.x, proposed.x + proposed.w / 2, proposed.x + proposed.w];
    const anchorsY = [proposed.y, proposed.y + proposed.h / 2, proposed.y + proposed.h];

    let xAdjust = 0;
    let yAdjust = 0;
    let guideX: number | undefined;
    let guideY: number | undefined;
    let bestX = GUIDE_TOLERANCE + 1;
    let bestY = GUIDE_TOLERANCE + 1;

    for (const target of targetXs) {
      for (const anchor of anchorsX) {
        const distance = Math.abs(target - anchor);
        if (distance < bestX && distance <= GUIDE_TOLERANCE) {
          bestX = distance;
          xAdjust = target - anchor;
          guideX = target;
        }
      }
    }

    for (const target of targetYs) {
      for (const anchor of anchorsY) {
        const distance = Math.abs(target - anchor);
        if (distance < bestY && distance <= GUIDE_TOLERANCE) {
          bestY = distance;
          yAdjust = target - anchor;
          guideY = target;
        }
      }
    }

    return {
      dx: dx + (snap ? xAdjust : 0),
      dy: dy + (snap ? yAdjust : 0),
      guides: { x: guideX, y: guideY }
    };
  };

  const beginGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    element: SlideElement,
    mode: "move" | "resize"
  ) => {
    if (editingId === element.id) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const clickedSelection = selectionFromClickedElement(activeSlide.elements, element.id);
    let nextSelection: string[];

    if (event.shiftKey && mode === "move") {
      const selected = new Set(selectedIds);
      const allSelected = clickedSelection.every((id) => selected.has(id));
      for (const id of clickedSelection) {
        if (allSelected) selected.delete(id);
        else selected.add(id);
      }
      nextSelection = [...selected];
      if (!nextSelection.length) nextSelection = clickedSelection;
    } else if (selectedIds.includes(element.id) && mode === "move") {
      nextSelection = selectedIds;
    } else {
      nextSelection = clickedSelection;
    }

    const movingIds = mode === "resize"
      ? [element.id]
      : expandSelectionForGroups(activeSlide.elements, nextSelection);

    const starts = new Map<string, SlideElement>();
    for (const item of activeSlide.elements) {
      if (movingIds.includes(item.id)) starts.set(item.id, { ...item });
    }

    setSelectedIds(nextSelection);
    setInspectorMode("element");

    gesture.current = {
      primaryId: element.id,
      movingIds,
      startX: event.clientX,
      startY: event.clientY,
      starts,
      snapshot: slides,
      mode,
      moved: false
    };
  };

  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state) return;

    const rawDx = (event.clientX - state.startX) / zoom;
    const rawDy = (event.clientY - state.startY) / zoom;
    if (Math.abs(rawDx) > 1 || Math.abs(rawDy) > 1) state.moved = true;

    if (state.mode === "resize") {
      const start = state.starts.get(state.primaryId);
      if (!start) return;
      setGuides({});
      updateElement(state.primaryId, {
        w: Math.max(30, Math.min(SLIDE_W - start.x, snapValue(start.w + rawDx))),
        h: Math.max(24, Math.min(SLIDE_H - start.y, snapValue(start.h + rawDy)))
      }, false);
      return;
    }

    const primary = state.starts.get(state.primaryId);
    if (!primary) return;
    const guided = smartGuideDelta(primary, rawDx, rawDy, state.movingIds);
    setGuides(guided.guides);

    const startBounds = selectionBounds([...state.starts.values()], state.movingIds);
    let dx = guided.dx;
    let dy = guided.dy;
    if (startBounds) {
      dx = Math.max(-startBounds.x, Math.min(SLIDE_W - startBounds.right, dx));
      dy = Math.max(-startBounds.y, Math.min(SLIDE_H - startBounds.bottom, dy));
    }

    const moving = new Set(state.movingIds);
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.map((item) => {
        if (!moving.has(item.id)) return item;
        const start = state.starts.get(item.id);
        if (!start) return item;
        return {
          ...item,
          x: snap ? snapValue(start.x + dx) : Math.round(start.x + dx),
          y: snap ? snapValue(start.y + dy) : Math.round(start.y + dy)
        };
      })
    }), false);
  };

  const endGesture = () => {
    const state = gesture.current;
    if (state?.moved) {
      undoStack.current.push(state.snapshot);
      redoStack.current = [];
    }
    gesture.current = null;
    setGuides({});
  };

  const nudgeSelection = (dx: number, dy: number) => {
    if (!expandedSelection.length) return;
    const ids = new Set(expandedSelection);
    const bounds = selectionBounds(activeSlide.elements, ids);
    if (!bounds) return;
    const safeDx = Math.max(-bounds.x, Math.min(SLIDE_W - bounds.right, dx));
    const safeDy = Math.max(-bounds.y, Math.min(SLIDE_H - bounds.bottom, dy));
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.map((element) =>
        ids.has(element.id)
          ? { ...element, x: element.x + safeDx, y: element.y + safeDy }
          : element
      )
    }));
  };

  const exportDeck = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 2, title: deckTitle, slides }, null, 2)],
      { type: "application/json" }
    );
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
        setSlides(data.slides.map((slide) => ({ ...slide, layout: slide.layout ?? "content" })));
        setActiveId(data.slides[0].id);
        setSelectedIds([]);
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
      // The in-app presenter remains available if browser fullscreen is unavailable.
    }
  };

  const stopPresentation = async () => {
    setPresenterIndex(null);
    setShowPresenterNotes(false);
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // No-op.
      }
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      const mod = event.ctrlKey || event.metaKey;

      if (presenterIndex !== null) {
        if (event.key === "Escape") {
          void stopPresentation();
          return;
        }
        if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
          event.preventDefault();
          setPresenterIndex((index) =>
            index === null ? null : Math.min(slides.length - 1, index + 1)
          );
        }
        if (event.key === "ArrowLeft" || event.key === "PageUp") {
          event.preventDefault();
          setPresenterIndex((index) =>
            index === null ? null : Math.max(0, index - 1)
          );
        }
        return;
      }

      if (editing) return;

      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(activeSlide.elements.map((element) => element.id));
        setInspectorMode("element");
        return;
      }
      if (mod && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelection();
        return;
      }
      if (mod && event.key.toLowerCase() === "x") {
        event.preventDefault();
        cutSelection();
        return;
      }
      if (mod && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteSelection();
        return;
      }
      if (mod && event.key.toLowerCase() === "d") {
        event.preventDefault();
        expandedSelection.length ? duplicateSelection() : duplicateSlide();
        return;
      }
      if (mod && event.key.toLowerCase() === "g") {
        event.preventDefault();
        event.shiftKey ? ungroupSelected() : groupSelected();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (expandedSelection.length) {
          event.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (event.key === "Escape") {
        clearSelection();
        return;
      }
      if (expandedSelection.length && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        if (event.key === "ArrowLeft") nudgeSelection(-amount, 0);
        if (event.key === "ArrowRight") nudgeSelection(amount, 0);
        if (event.key === "ArrowUp") nudgeSelection(0, -amount);
        if (event.key === "ArrowDown") nudgeSelection(0, amount);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const animationClass = (transition: Transition) =>
    transition === "fade" ? styles.fadeIn :
    transition === "slide" ? styles.slideIn :
    transition === "zoom" ? styles.zoomIn : "";

  const renderTable = (element: SlideElement) => {
    const data = element.tableData?.length
      ? element.tableData
      : [["A", "B", "C"], ["1", "2", "3"], ["4", "5", "6"]];
    const columns = Math.max(1, ...data.map((row) => row.length));
    const flat = data.flatMap((row) =>
      Array.from({ length: columns }, (_, index) => row[index] ?? "")
    );

    return (
      <div
        className={styles.table}
        style={{
          gridTemplateColumns: "repeat(" + columns + ", 1fr)",
          gridTemplateRows: "repeat(" + data.length + ", 1fr)"
        }}
      >
        {flat.map((value, index) => (
          <div
            className={styles.tableCell}
            key={index}
            style={index < columns ? { fontWeight: 700, background: element.fill + "18" } : undefined}
          >
            {value}
          </div>
        ))}
      </div>
    );
  };

  const renderChart = (element: SlideElement) => {
    const values = element.chartData?.length ? element.chartData : [44, 72, 58, 88];
    const labels = element.chartLabels?.length ? element.chartLabels : values.map((_, index) => "S" + (index + 1));
    const kind = element.chartKind ?? "bar";
    const max = Math.max(1, ...values.map((value) => Math.abs(value)));

    if (kind === "line") {
      return (
        <div className={styles.chartLineWrap}>
          <svg className={styles.chartSvg} viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Line chart">
            <polyline points={linePoints(values)} fill="none" stroke={element.fill} strokeWidth="3" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className={styles.chartLabels}>
            {labels.map((label, index) => <span key={index}>{label}</span>)}
          </div>
        </div>
      );
    }

    if (kind === "donut") {
      return (
        <div className={styles.donutWrap}>
          <div className={styles.donut} style={{ background: donutGradient(values, element.fill) }}>
            <div className={styles.donutHole}>{values.reduce((sum, value) => sum + value, 0)}</div>
          </div>
          <div className={styles.donutLegend}>
            {labels.slice(0, 6).map((label, index) => (
              <span key={index}>{label}: {values[index] ?? 0}</span>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className={styles.chart}>
        {values.map((value, index) => (
          <div className={styles.barGroup} key={index}>
            <div
              className={styles.bar}
              style={{
                height: Math.max(3, Math.abs(value) / max * 100) + "%",
                background: element.fill
              }}
              title={String(value)}
            />
            <span>{labels[index] ?? ""}</span>
          </div>
        ))}
      </div>
    );
  };

  const renderElement = (element: SlideElement, interactive: boolean) => {
    const isSelected = interactive && selectedIds.includes(element.id);
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
          onDoubleClick={(event) => {
            event.stopPropagation();
            setEditingId(element.id);
            setSelectedIds(selectionFromClickedElement(activeSlide.elements, element.id));
          }}
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
          className={
            styles.shape + " " +
            (element.shape === "ellipse"
              ? styles.ellipse
              : element.shape === "rounded"
                ? styles.rounded
                : "")
          }
          style={{ background: element.fill }}
        />
      ) : element.type === "image" ? (
        <img className={styles.image} src={element.src} alt="" draggable={false} />
      ) : element.type === "line" ? (
        <div className={styles.line} style={{ background: element.fill }} />
      ) : element.type === "table" ? (
        renderTable(element)
      ) : (
        renderChart(element)
      );

    return (
      <div
        key={element.id}
        className={
          styles.element +
          (isSelected ? " " + styles.elementSelected : "") +
          (element.groupId ? " " + styles.groupedElement : "")
        }
        style={style}
        onPointerDown={interactive ? (event) => beginGesture(event, element, "move") : undefined}
        onPointerMove={interactive ? moveGesture : undefined}
        onPointerUp={interactive ? endGesture : undefined}
        onClick={interactive ? (event) => {
          event.stopPropagation();
          if (!event.shiftKey) {
            setSelectedIds((current) =>
              current.includes(element.id)
                ? current
                : selectionFromClickedElement(activeSlide.elements, element.id)
            );
          }
          setInspectorMode("element");
        } : undefined}
      >
        {content}
        {isSelected && editingId !== element.id && selectedIds.length === 1 && (
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
      className={
        styles.canvas +
        (showGrid && interactive ? " " + styles.grid : "") +
        (className ? " " + className : "")
      }
      style={{ background: slide.background }}
      onClick={interactive ? clearSelection : undefined}
    >
      {slide.elements.map((element) => renderElement(element, interactive))}
      {interactive && guides.x !== undefined && (
        <div className={styles.guideVertical} style={{ left: guides.x }} />
      )}
      {interactive && guides.y !== undefined && (
        <div className={styles.guideHorizontal} style={{ top: guides.y }} />
      )}
      {interactive && selectedIds.length > 1 && (
        <div className={styles.multiSelectionBadge}>
          {expandedSelection.length} selected
        </div>
      )}
    </div>
  );

  const printSlides = useMemo(() => slides.map((slide) => (
    <div className={styles.printSlide} key={slide.id}>
      <div style={{ transform: "scale(1.333333)", transformOrigin: "top left" }}>
        {renderSlide(slide)}
      </div>
    </div>
  )), [slides]);

  const selectionBoundsValue = selectionBounds(activeSlide.elements, expandedSelection);
  const tableCsv = primaryElement?.type === "table"
    ? (primaryElement.tableData ?? []).map((row) => row.join(",")).join("\n")
    : "";
  const chartValues = primaryElement?.type === "chart"
    ? (primaryElement.chartData ?? []).join(", ")
    : "";
  const chartLabels = primaryElement?.type === "chart"
    ? (primaryElement.chartLabels ?? []).join(", ")
    : "";

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <a href="/" className={styles.back} aria-label="Back to workspace">←</a>
        <div className={styles.appMark}>P</div>
        <div className={styles.titleWrap}>
          <input
            className={styles.fileTitle}
            value={deckTitle}
            onChange={(event) => setDeckTitle(event.target.value)}
            aria-label="Presentation title"
          />
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
        <button className={styles.menuItem} onClick={() => duplicateSlide()}>Duplicate slide</button>
        <button className={styles.menuItem} onClick={() => setInspectorMode("theme")}>Master & theme</button>
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

        <button className={styles.toolbarBtn} onClick={() => applyLayout("title")}>Title</button>
        <button className={styles.toolbarBtn} onClick={() => applyLayout("content")}>Content</button>
        <button className={styles.toolbarBtn} onClick={() => applyLayout("section")}>Section</button>
        <button className={styles.toolbarBtn} onClick={() => applyLayout("two-column")}>2 columns</button>
        <button className={styles.toolbarBtn} onClick={() => applyLayout("blank")}>Blank</button>

        <span className={styles.divider} />

        <button
          className={styles.toolbarBtn + (showGrid ? " " + styles.toolbarBtnActive : "")}
          onClick={() => setShowGrid((value) => !value)}
        >
          Grid
        </button>
        <button
          className={styles.toolbarBtn + (snap ? " " + styles.toolbarBtnActive : "")}
          onClick={() => setSnap((value) => !value)}
        >
          Smart snap
        </button>

        {expandedSelection.length > 0 && (
          <>
            <span className={styles.divider} />
            <button className={styles.toolbarBtn} onClick={duplicateSelection}>Duplicate</button>
            <button className={styles.toolbarBtn} onClick={copySelection}>Copy</button>
            <button className={styles.toolbarBtn} onClick={deleteSelection}>Delete</button>
          </>
        )}

        {expandedSelection.length > 1 && (
          <>
            <button className={styles.toolbarBtn} onClick={groupSelected}>Group</button>
            {hasGroupSelection && <button className={styles.toolbarBtn} onClick={ungroupSelected}>Ungroup</button>}
          </>
        )}
      </section>

      <section className={styles.workspace}>
        <aside className={styles.navigator}>
          <div className={styles.navTop}>
            <button className={styles.primaryBtn} onClick={() => addSlide("content")}>+ Slide</button>
            <button className={styles.ghostBtn} onClick={() => addSlide("blank")}>Blank</button>
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
            <div
              className={styles.stageFrame}
              style={{ width: SLIDE_W * zoom, height: SLIDE_H * zoom }}
            >
              <div style={{ transform: "scale(" + zoom + ")", transformOrigin: "top left" }}>
                {renderSlide(activeSlide, true)}
              </div>
            </div>
          </div>
        </div>

        <aside className={styles.inspector}>
          <div className={styles.inspectorHeader}>
            <button
              className={styles.inspectorTab + (inspectorMode === "slide" ? " " + styles.inspectorTabActive : "")}
              onClick={() => setInspectorMode("slide")}
            >
              Slide
            </button>
            <button
              className={styles.inspectorTab + (inspectorMode === "element" ? " " + styles.inspectorTabActive : "")}
              onClick={() => setInspectorMode("element")}
            >
              Object
            </button>
            <button
              className={styles.inspectorTab + (inspectorMode === "theme" ? " " + styles.inspectorTabActive : "")}
              onClick={() => setInspectorMode("theme")}
            >
              Master
            </button>
          </div>

          {inspectorMode === "slide" && (
            <>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Slide setup</h3>

                <div className={styles.field}>
                  <label>Layout</label>
                  <select
                    value={activeSlide.layout ?? "content"}
                    onChange={(event) => applyLayout(event.target.value as SlideLayout)}
                  >
                    <option value="title">Title</option>
                    <option value="content">Content</option>
                    <option value="section">Section</option>
                    <option value="two-column">Two columns</option>
                    <option value="blank">Blank</option>
                  </select>
                </div>

                <div className={styles.field}>
                  <label>Background</label>
                  <div className={styles.colorRow}>
                    <input
                      type="color"
                      value={activeSlide.background}
                      onChange={(event) =>
                        mutateActive((slide) => ({ ...slide, background: event.target.value }))
                      }
                    />
                    <input
                      value={activeSlide.background}
                      onChange={(event) =>
                        mutateActive((slide) => ({ ...slide, background: event.target.value }))
                      }
                    />
                  </div>
                </div>

                <div className={styles.field}>
                  <label>Transition</label>
                  <select
                    value={activeSlide.transition}
                    onChange={(event) =>
                      mutateActive((slide) => ({
                        ...slide,
                        transition: event.target.value as Transition
                      }))
                    }
                  >
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
                    onChange={(event) =>
                      mutateActive((slide) => ({ ...slide, notes: event.target.value }))
                    }
                  />
                </div>
              </div>
            </>
          )}

          {inspectorMode === "element" && expandedSelection.length > 1 && (
            <>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>{expandedSelection.length} objects selected</h3>
                {selectionBoundsValue && (
                  <div className={styles.selectionSummary}>
                    <span>X {Math.round(selectionBoundsValue.x)}</span>
                    <span>Y {Math.round(selectionBoundsValue.y)}</span>
                    <span>W {Math.round(selectionBoundsValue.w)}</span>
                    <span>H {Math.round(selectionBoundsValue.h)}</span>
                  </div>
                )}
              </div>

              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Align objects</h3>
                <div className={styles.alignGrid}>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("left")}>Left</button>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("center")}>Center</button>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("right")}>Right</button>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("top")}>Top</button>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("middle")}>Middle</button>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("bottom")}>Bottom</button>
                </div>

                <h3 className={styles.panelTitle + " " + styles.panelTitleSpaced}>Distribute</h3>
                <div className={styles.alignGrid}>
                  <button className={styles.inspectorBtn} onClick={() => distributeSelected("horizontal")}>Horizontal</button>
                  <button className={styles.inspectorBtn} onClick={() => distributeSelected("vertical")}>Vertical</button>
                </div>

                <h3 className={styles.panelTitle + " " + styles.panelTitleSpaced}>Align to slide</h3>
                <div className={styles.alignGrid}>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("center", true)}>Center X</button>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("middle", true)}>Center Y</button>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("left", true)}>Left edge</button>
                  <button className={styles.inspectorBtn} onClick={() => alignSelected("right", true)}>Right edge</button>
                </div>
              </div>

              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Selection</h3>
                <button className={styles.inspectorBtn} onClick={groupSelected}>Group selection</button>
                {hasGroupSelection && <button className={styles.inspectorBtn} onClick={ungroupSelected}>Ungroup</button>}
                <button className={styles.inspectorBtn} onClick={duplicateSelection}>Duplicate selection</button>
                <button className={styles.inspectorBtn} onClick={() => reorderSelection("front")}>Bring to front</button>
                <button className={styles.inspectorBtn} onClick={() => reorderSelection("back")}>Send to back</button>
                <button className={styles.inspectorBtn} onClick={deleteSelection}>Delete selection</button>
              </div>
            </>
          )}

          {inspectorMode === "element" && expandedSelection.length === 1 && primaryElement && (
            <>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Position & size</h3>
                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label>X</label>
                    <input type="number" value={Math.round(primaryElement.x)} onChange={(event) => updateElement(primaryElement.id, { x: Number(event.target.value) })} />
                  </div>
                  <div className={styles.field}>
                    <label>Y</label>
                    <input type="number" value={Math.round(primaryElement.y)} onChange={(event) => updateElement(primaryElement.id, { y: Number(event.target.value) })} />
                  </div>
                  <div className={styles.field}>
                    <label>Width</label>
                    <input type="number" value={Math.round(primaryElement.w)} onChange={(event) => updateElement(primaryElement.id, { w: Math.max(20, Number(event.target.value)) })} />
                  </div>
                  <div className={styles.field}>
                    <label>Height</label>
                    <input type="number" value={Math.round(primaryElement.h)} onChange={(event) => updateElement(primaryElement.id, { h: Math.max(20, Number(event.target.value)) })} />
                  </div>
                </div>
                <div className={styles.field}>
                  <label>Rotation</label>
                  <input type="number" value={primaryElement.rotation ?? 0} onChange={(event) => updateElement(primaryElement.id, { rotation: Number(event.target.value) })} />
                </div>
              </div>

              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Appearance</h3>

                {(primaryElement.type === "shape" || primaryElement.type === "line" || primaryElement.type === "chart") && (
                  <div className={styles.field}>
                    <label>Fill / accent</label>
                    <div className={styles.colorRow}>
                      <input type="color" value={primaryElement.fill} onChange={(event) => updateElement(primaryElement.id, { fill: event.target.value })} />
                      <input value={primaryElement.fill} onChange={(event) => updateElement(primaryElement.id, { fill: event.target.value })} />
                    </div>
                  </div>
                )}

                {primaryElement.type === "text" && (
                  <>
                    <div className={styles.field}>
                      <label>Text color</label>
                      <div className={styles.colorRow}>
                        <input type="color" value={primaryElement.color} onChange={(event) => updateElement(primaryElement.id, { color: event.target.value })} />
                        <input value={primaryElement.color} onChange={(event) => updateElement(primaryElement.id, { color: event.target.value })} />
                      </div>
                    </div>

                    <div className={styles.fieldRow}>
                      <div className={styles.field}>
                        <label>Font size</label>
                        <input type="number" value={primaryElement.fontSize ?? 28} onChange={(event) => updateElement(primaryElement.id, { fontSize: Number(event.target.value) })} />
                      </div>
                      <div className={styles.field}>
                        <label>Weight</label>
                        <input type="number" min="100" max="900" step="50" value={primaryElement.fontWeight ?? 500} onChange={(event) => updateElement(primaryElement.id, { fontWeight: Number(event.target.value) })} />
                      </div>
                    </div>

                    <div className={styles.field}>
                      <label>Alignment</label>
                      <select
                        value={primaryElement.align ?? "left"}
                        onChange={(event) => updateElement(primaryElement.id, { align: event.target.value as "left" | "center" | "right" })}
                      >
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </div>
                  </>
                )}

                {primaryElement.type === "table" && (
                  <div className={styles.field}>
                    <label>Table data (CSV)</label>
                    <textarea
                      value={tableCsv}
                      onChange={(event) => {
                        const tableData = event.target.value
                          .split("\n")
                          .map((row) => row.split(",").map((cell) => cell.trim()));
                        updateElement(primaryElement.id, { tableData });
                      }}
                    />
                  </div>
                )}

                {primaryElement.type === "chart" && (
                  <>
                    <div className={styles.field}>
                      <label>Chart type</label>
                      <select
                        value={primaryElement.chartKind ?? "bar"}
                        onChange={(event) => updateElement(primaryElement.id, { chartKind: event.target.value as ChartKind })}
                      >
                        <option value="bar">Bar</option>
                        <option value="line">Line</option>
                        <option value="donut">Donut</option>
                      </select>
                    </div>
                    <div className={styles.field}>
                      <label>Values</label>
                      <input
                        value={chartValues}
                        onChange={(event) => updateElement(primaryElement.id, {
                          chartData: event.target.value
                            .split(",")
                            .map((value) => Number(value.trim()))
                            .filter((value) => Number.isFinite(value))
                        })}
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Labels</label>
                      <input
                        value={chartLabels}
                        onChange={(event) => updateElement(primaryElement.id, {
                          chartLabels: event.target.value.split(",").map((value) => value.trim())
                        })}
                      />
                    </div>
                  </>
                )}

                <button className={styles.inspectorBtn} onClick={() => alignSelected("center", true)}>Center on slide</button>
                <button className={styles.inspectorBtn} onClick={() => reorderSelection("front")}>Bring to front</button>
                <button className={styles.inspectorBtn} onClick={() => reorderSelection("back")}>Send to back</button>
                <button className={styles.inspectorBtn} onClick={duplicateSelection}>Duplicate object</button>
                <button className={styles.inspectorBtn} onClick={deleteSelection}>Delete object</button>
              </div>
            </>
          )}

          {inspectorMode === "element" && expandedSelection.length === 0 && (
            <div className={styles.emptyInspector}>
              Select an object. Shift-click adds to the selection. Ctrl/Cmd+A selects every object on the slide.
            </div>
          )}

          {inspectorMode === "theme" && (
            <>
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Presentation master</h3>
                <div className={styles.themeGrid}>
                  {themes.map((theme) => (
                    <button className={styles.themeBtn} key={theme.id} onClick={() => applyTheme(theme)}>
                      <div
                        className={styles.themeSwatch}
                        style={{
                          background:
                            "linear-gradient(135deg, " +
                            theme.background +
                            " 0 68%, " +
                            theme.accent +
                            " 68%)"
                        }}
                      />
                      <span className={styles.themeName}>{theme.name}</span>
                    </button>
                  ))}
                </div>
                <button className={styles.inspectorBtn} onClick={() => applyTheme(closestTheme(activeSlide.background), true)}>
                  Apply current theme to all slides
                </button>
              </div>

              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Master layouts</h3>
                <button className={styles.inspectorBtn} onClick={() => applyLayoutToAll("content")}>Content master · all slides</button>
                <button className={styles.inspectorBtn} onClick={() => applyLayoutToAll("section")}>Section master · all slides</button>
                <button className={styles.inspectorBtn} onClick={() => applyLayoutToAll("two-column")}>Two-column master · all slides</button>
              </div>
            </>
          )}
        </aside>
      </section>

      <footer className={styles.statusBar}>
        <span>Slide {activeIndex + 1} of {slides.length}</span>
        <span>{activeSlide.layout ?? "content"} layout</span>
        <span>{expandedSelection.length ? expandedSelection.length + " selected" : "16:9 widescreen"}</span>
        <span>{snap ? "Smart guides on" : "Smart guides view-only"}</span>
        <span className={styles.statusSpacer} />
        <div className={styles.zoomControl}>
          <span>{Math.round(zoom * 100)}%</span>
          <input
            type="range"
            min="0.45"
            max="1.25"
            step="0.05"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
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
              className={
                styles.presenterCanvas +
                " " +
                animationClass(slides[presenterIndex].transition)
              }
              style={{ transform: "scale(" + presenterScale + ")" }}
            >
              {renderSlide(slides[presenterIndex])}
            </div>
          </div>

          {showPresenterNotes && slides[presenterIndex].notes && (
            <div className={styles.presenterNotes}>
              {slides[presenterIndex].notes}
            </div>
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
