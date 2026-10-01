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
import { exportDeckToPptx } from "./pptxExport";
import {
  decodeTmsl,
  downloadTmsl,
  encodeTmsl,
  TMSL_EXTENSION,
  TMSL_MIME
} from "./nativeFormat";
import styles from "./slides.module.css";

type ElementType = "text" | "shape" | "image" | "line" | "table" | "chart";
type ShapeType = "rect" | "ellipse" | "rounded";
type Transition = "none" | "fade" | "slide" | "zoom";
type ChartKind = "bar" | "line" | "donut";
type SlideLayout = "title" | "content" | "section" | "two-column" | "blank";
type Placeholder = "title" | "body" | "body2";
type ObjectAnimation = "none" | "fade" | "float-up" | "zoom" | "wipe";
type ImageFit = "cover" | "contain";
type ImageMask = "rect" | "rounded" | "circle";

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
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;
  shadow?: boolean;
  fontFamily?: string;
  italic?: boolean;
  underline?: boolean;
  letterSpacing?: number;
  animation?: ObjectAnimation;
  animationDuration?: number;
  animationDelay?: number;
  imageFit?: ImageFit;
  imageMask?: ImageMask;
  imageX?: number;
  imageY?: number;
  name?: string;
  locked?: boolean;
  hidden?: boolean;
};

type SlideComment = {
  id: string;
  text: string;
  createdAt: string;
  resolved: boolean;
};

type Slide = {
  id: string;
  background: string;
  transition: Transition;
  notes: string;
  layout?: SlideLayout;
  section?: string;
  guides?: {
    vertical: number[];
    horizontal: number[];
  };
  comments?: SlideComment[];
  elements: SlideElement[];
};

type VersionSnapshot = {
  id: string;
  label: string;
  createdAt: string;
  title: string;
  slides: Slide[];
};

type SavedComponent = {
  id: string;
  name: string;
  createdAt: string;
  width: number;
  height: number;
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

type NativeTmslFile = {
  path: string;
  name: string;
  bytes: number[];
};

type MarqueeState = {
  startX: number;
  startY: number;
  x: number;
  y: number;
  base: string[];
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
    section: "Opening",
    guides: { vertical: [], horizontal: [] },
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
    section: "Story",
    guides: { vertical: [], horizontal: [] },
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
    section: "Closing",
    guides: { vertical: [], horizontal: [] },
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
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [inspectorMode, setInspectorMode] = useState<
    "slide" | "element" | "layers" | "review" | "history" | "components" | "theme"
  >("slide");
  const [saveState, setSaveState] = useState("Saved locally");
  const [presenterIndex, setPresenterIndex] = useState<number | null>(null);
  const [presenterScale, setPresenterScale] = useState(1);
  const [showPresenterNotes, setShowPresenterNotes] = useState(false);
  const [presenterStartedAt, setPresenterStartedAt] = useState<number | null>(null);
  const [presenterElapsed, setPresenterElapsed] = useState(0);
  const [presenterBlackout, setPresenterBlackout] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [history, setHistory] = useState<VersionSnapshot[]>([]);
  const [components, setComponents] = useState<SavedComponent[]>([]);
  const [nativePath, setNativePath] = useState<string | null>(null);
  const [recoveryFile, setRecoveryFile] = useState<NativeTmslFile | null>(null);

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
      const raw =
        localStorage.getItem("tamishra-slides-deck-v3") ??
        localStorage.getItem("tamishra-slides-deck-v2") ??
        localStorage.getItem("tamishra-slides-deck-v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { title?: string; slides?: Slide[] };
      if (parsed.slides?.length) {
        const normalized = parsed.slides.map((slide) => ({
          ...slide,
          layout: slide.layout ?? "content",
          section: slide.section ?? "",
          guides: slide.guides ?? { vertical: [], horizontal: [] },
          comments: slide.comments ?? [],
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
    try {
      const rawHistory = localStorage.getItem("tamishra-slides-history-v1");
      if (rawHistory) {
        const parsed = JSON.parse(rawHistory) as VersionSnapshot[];
        if (Array.isArray(parsed)) setHistory(parsed.slice(0, 30));
      }
      const rawComponents = localStorage.getItem("tamishra-slides-components-v1");
      if (rawComponents) {
        const parsed = JSON.parse(rawComponents) as SavedComponent[];
        if (Array.isArray(parsed)) setComponents(parsed);
      }
    } catch {
      // Ignore malformed optional workspace data.
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("tamishra-slides-history-v1", JSON.stringify(history.slice(0, 30)));
  }, [history]);

  useEffect(() => {
    localStorage.setItem("tamishra-slides-components-v1", JSON.stringify(components));
  }, [components]);

  useEffect(() => {
    setSaveState("Saving…");
    const timer = window.setTimeout(() => {
      localStorage.setItem("tamishra-slides-deck-v3", JSON.stringify({ title: deckTitle, slides }));
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
      section: activeSlide?.section ?? "",
      guides: { vertical: [], horizontal: [] },
      comments: [],
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
      color: "#172033",
      imageFit: "cover",
      imageMask: "rect",
      imageX: 50,
      imageY: 50
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

  const setLayerState = (id: string, patch: Partial<SlideElement>) => {
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.map((element) =>
        element.id === id ? { ...element, ...patch } : element
      )
    }));
  };

  const addComment = () => {
    const text = commentDraft.trim();
    if (!text) return;
    const comment: SlideComment = {
      id: uid(),
      text,
      createdAt: new Date().toISOString(),
      resolved: false
    };
    mutateActive((slide) => ({
      ...slide,
      comments: [...(slide.comments ?? []), comment]
    }));
    setCommentDraft("");
  };

  const toggleComment = (id: string) => {
    mutateActive((slide) => ({
      ...slide,
      comments: (slide.comments ?? []).map((comment) =>
        comment.id === id ? { ...comment, resolved: !comment.resolved } : comment
      )
    }));
  };

  const removeComment = (id: string) => {
    mutateActive((slide) => ({
      ...slide,
      comments: (slide.comments ?? []).filter((comment) => comment.id !== id)
    }));
  };

  const createSnapshot = () => {
    const snapshot: VersionSnapshot = {
      id: uid(),
      label: "Snapshot " + (history.length + 1),
      createdAt: new Date().toISOString(),
      title: deckTitle,
      slides: cloneSlides(slides)
    };
    setHistory((current) => [snapshot, ...current].slice(0, 30));
    setSaveState("Version snapshot created");
  };

  const restoreSnapshot = (snapshot: VersionSnapshot) => {
    undoStack.current.push(slides);
    redoStack.current = [];
    const restored = cloneSlides(snapshot.slides);
    setSlides(restored);
    setDeckTitle(snapshot.title);
    setActiveId(restored[0]?.id ?? activeId);
    setSelectedIds([]);
    setSaveState("Version restored");
  };

  const deleteSnapshot = (id: string) => {
    setHistory((current) => current.filter((snapshot) => snapshot.id !== id));
  };

  const saveSelectionAsComponent = () => {
    if (!expandedSelection.length) return;
    const ids = new Set(expandedSelection);
    const source = activeSlide.elements.filter((element) => ids.has(element.id));
    const bounds = selectionBounds(source, source.map((element) => element.id));
    if (!bounds) return;
    const groupMap = new Map<string, string>();
    const elements = source.map((element) => {
      let groupId = element.groupId;
      if (groupId) {
        if (!groupMap.has(groupId)) groupMap.set(groupId, uid());
        groupId = groupMap.get(groupId);
      }
      return {
        ...element,
        id: uid(),
        groupId,
        x: element.x - bounds.x,
        y: element.y - bounds.y
      };
    });
    const component: SavedComponent = {
      id: uid(),
      name:
        source.length === 1
          ? (source[0].name || source[0].type) + " component"
          : "Component " + (components.length + 1),
      createdAt: new Date().toISOString(),
      width: bounds.w,
      height: bounds.h,
      elements
    };
    setComponents((current) => [component, ...current]);
    setSaveState("Reusable component saved");
  };

  const insertComponent = (component: SavedComponent) => {
    const groupMap = new Map<string, string>();
    const offsetX = Math.max(20, (SLIDE_W - component.width) / 2);
    const offsetY = Math.max(20, (SLIDE_H - component.height) / 2);
    const elements = component.elements.map((element) => {
      let groupId = element.groupId;
      if (groupId) {
        if (!groupMap.has(groupId)) groupMap.set(groupId, uid());
        groupId = groupMap.get(groupId);
      }
      return {
        ...element,
        id: uid(),
        groupId,
        x: Math.min(SLIDE_W - element.w, offsetX + element.x),
        y: Math.min(SLIDE_H - element.h, offsetY + element.y)
      };
    });
    mutateActive((slide) => ({ ...slide, elements: [...slide.elements, ...elements] }));
    setSelectedIds(elements.map((element) => element.id));
    setInspectorMode("element");
  };

  const deleteComponent = (id: string) => {
    setComponents((current) => current.filter((component) => component.id !== id));
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

  const updateGuideList = (axis: "vertical" | "horizontal", raw: string) => {
    const max = axis === "vertical" ? SLIDE_W : SLIDE_H;
    const values = raw
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(0, Math.min(max, value)));
    mutateActive((slide) => ({
      ...slide,
      guides: {
        vertical: axis === "vertical" ? values : (slide.guides?.vertical ?? []),
        horizontal: axis === "horizontal" ? values : (slide.guides?.horizontal ?? [])
      }
    }));
  };

  const addGuide = (axis: "vertical" | "horizontal") => {
    const value = axis === "vertical" ? SLIDE_W / 2 : SLIDE_H / 2;
    mutateActive((slide) => {
      const current = slide.guides ?? { vertical: [], horizontal: [] };
      const values = current[axis].includes(value)
        ? current[axis]
        : [...current[axis], value].sort((a, b) => a - b);
      return {
        ...slide,
        guides: { ...current, [axis]: values }
      };
    });
  };

  const clearManualGuides = () => {
    mutateActive((slide) => ({
      ...slide,
      guides: { vertical: [], horizontal: [] }
    }));
  };

  const staggerSlideAnimations = () => {
    let order = 0;
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => {
        if (!element.animation || element.animation === "none") return element;
        const delay = order * 180;
        order += 1;
        return { ...element, animationDelay: delay };
      })
    }));
  };

  const clearSlideAnimations = () => {
    mutateActive((slide) => ({
      ...slide,
      elements: slide.elements.map((element) => ({
        ...element,
        animation: "none",
        animationDelay: 0
      }))
    }));
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

    const targetXs = [
      0,
      SLIDE_W / 2,
      SLIDE_W,
      ...(activeSlide.guides?.vertical ?? [])
    ];
    const targetYs = [
      0,
      SLIDE_H / 2,
      SLIDE_H,
      ...(activeSlide.guides?.horizontal ?? [])
    ];

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
    if (element.locked) {
      setSelectedIds(selectionFromClickedElement(activeSlide.elements, element.id));
      setInspectorMode("element");
      return;
    }
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

  const pointerToSlide = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(SLIDE_W, (event.clientX - rect.left) * (SLIDE_W / rect.width))),
      y: Math.max(0, Math.min(SLIDE_H, (event.clientY - rect.top) * (SLIDE_H / rect.height)))
    };
  };

  const beginMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerToSlide(event);
    const base = event.shiftKey ? selectedIds : [];
    if (!event.shiftKey) setSelectedIds([]);
    setEditingId(null);
    setMarquee({
      startX: point.x,
      startY: point.y,
      x: point.x,
      y: point.y,
      base
    });
  };

  const moveMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!marquee) return;
    const point = pointerToSlide(event);
    const left = Math.min(marquee.startX, point.x);
    const top = Math.min(marquee.startY, point.y);
    const right = Math.max(marquee.startX, point.x);
    const bottom = Math.max(marquee.startY, point.y);
    const hits = activeSlide.elements
      .filter((element) =>
        element.x < right &&
        element.x + element.w > left &&
        element.y < bottom &&
        element.y + element.h > top
      )
      .map((element) => element.id);
    const expanded = expandSelectionForGroups(activeSlide.elements, hits);
    setSelectedIds([...new Set([...marquee.base, ...expanded])]);
    setInspectorMode(expanded.length || marquee.base.length ? "element" : "slide");
    setMarquee({ ...marquee, x: point.x, y: point.y });
  };

  const endMarquee = () => {
    setMarquee(null);
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

  const isNativeDesktop = () =>
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const invokeNative = async <T,>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  };

  const nativeBytesForCurrentDeck = () =>
    encodeTmsl<Slide>({
      schemaVersion: 4,
      title: deckTitle,
      slides,
      metadata: {
        createdAt: new Date().toISOString(),
        appVersion: "Tamishra Slides"
      }
    });

  const exportPptx = async () => {
    try {
      setSaveState("Generating PPTX…");
      await exportDeckToPptx({ title: deckTitle, slides });
      setSaveState("PPTX exported");
    } catch {
      setSaveState("PPTX export failed");
    }
  };

  const applyImportedDeck = (data: { title?: string; slides?: Slide[] }) => {
    if (!data.slides?.length) throw new Error("Presentation has no slides.");

    const importedSlides = data.slides.map((slide) => ({
      ...slide,
      layout: slide.layout ?? "content",
      section: slide.section ?? "",
      guides: slide.guides ?? { vertical: [], horizontal: [] },
      comments: slide.comments ?? []
    }));

    undoStack.current.push(slides);
    redoStack.current = [];
    setSlides(importedSlides);
    setActiveId(importedSlides[0].id);
    setSelectedIds([]);
    setEditingId(null);
    if (data.title) setDeckTitle(data.title);
  };

  const saveNativeDeck = async (saveAs = false) => {
    try {
      setSaveState(saveAs ? "Saving TMSL as…" : "Saving TMSL…");

      if (isNativeDesktop()) {
        const bytes = Array.from(await nativeBytesForCurrentDeck());
        const current = saveAs
          ? null
          : await invokeNative<string | null>("current_tmsl_path");

        let savedPath: string | null = null;

        if (current) {
          savedPath = await invokeNative<string>("save_tmsl_current", { bytes });
        } else {
          savedPath = await invokeNative<string | null>("save_tmsl_as", {
            bytes,
            suggestedName:
              (deckTitle.trim() || "presentation").replace(/[^\w-]+/g, "-") +
              TMSL_EXTENSION
          });
        }

        if (!savedPath) {
          setSaveState("Save cancelled");
          return;
        }

        setNativePath(savedPath);
        await invokeNative<void>("clear_tmsl_recovery").catch(() => undefined);
        setRecoveryFile(null);
        setSaveState("Saved to " + savedPath.split(/[\\/]/).pop());
        return;
      }

      await downloadTmsl<Slide>({
        schemaVersion: 4,
        title: deckTitle,
        slides,
        metadata: {
          createdAt: new Date().toISOString(),
          appVersion: "Tamishra Slides"
        }
      });
      setSaveState("TMSL downloaded");
    } catch {
      setSaveState("TMSL save failed");
    }
  };

  const exportNativeDeck = () => saveNativeDeck(false);

  const exportLegacyJson = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 3, title: deckTitle, slides }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download =
      (deckTitle.trim() || "presentation").replace(/[^\w-]+/g, "-") +
      ".tamishra-slides.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const openNativeFile = async (file: NativeTmslFile) => {
    const decoded = await decodeTmsl<Slide>(new Uint8Array(file.bytes));
    applyImportedDeck({
      title: decoded.document.title,
      slides: decoded.document.slides
    });
    setNativePath(file.path);
    setSaveState(file.name + " opened · integrity verified");
  };

  const recoverNativeDeck = async () => {
    if (!recoveryFile) return;
    try {
      const decoded = await decodeTmsl<Slide>(new Uint8Array(recoveryFile.bytes));
      applyImportedDeck({
        title: decoded.document.title,
        slides: decoded.document.slides
      });
      setNativePath(null);
      setSaveState("Recovered unsaved TMSL session");
    } catch {
      setSaveState("Recovery file is invalid");
    }
  };

  const importDeck = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      setSaveState("Opening " + file.name + "…");

      if (
        file.name.toLowerCase().endsWith(TMSL_EXTENSION) ||
        file.type === TMSL_MIME
      ) {
        const decoded = await decodeTmsl<Slide>(await file.arrayBuffer());
        applyImportedDeck({
          title: decoded.document.title,
          slides: decoded.document.slides
        });
        setSaveState("TMSL opened · integrity verified");
      } else {
        const data = JSON.parse(await file.text()) as {
          title?: string;
          slides?: Slide[];
        };
        applyImportedDeck(data);
        setSaveState("Legacy deck imported");
      }
    } catch {
      setSaveState("Import failed or file is invalid");
    } finally {
      input.value = "";
    }
  };

  useEffect(() => {
    if (!isNativeDesktop()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const pending = await invokeNative<NativeTmslFile | null>("take_pending_tmsl");
        if (!disposed && pending) {
          await openNativeFile(pending);
        }

        const recovery = await invokeNative<NativeTmslFile | null>("read_tmsl_recovery");
        if (!disposed && recovery) {
          setRecoveryFile(recovery);
        }

        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("tamishra://open-tmsl", async (event) => {
          try {
            const opened = await invokeNative<NativeTmslFile>("open_tmsl_path", {
              path: event.payload
            });
            if (!disposed) await openNativeFile(opened);
          } catch {
            if (!disposed) setSaveState("Unable to open requested TMSL file");
          }
        });
      } catch {
        // Hosted web builds intentionally have no native bridge.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isNativeDesktop()) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const bytes = Array.from(await nativeBytesForCurrentDeck());
          await invokeNative<string>("write_tmsl_recovery", { bytes });

          if (nativePath) {
            const savedPath = await invokeNative<string>("save_tmsl_current", { bytes });
            setNativePath(savedPath);
            await invokeNative<void>("clear_tmsl_recovery").catch(() => undefined);
            setRecoveryFile(null);
            setSaveState("Autosaved · " + savedPath.split(/[\\/]/).pop());
          }
        } catch {
          setSaveState("Native autosave pending");
        }
      })();
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [deckTitle, slides, nativePath]);

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
    setPresenterStartedAt(Date.now());
    setPresenterElapsed(0);
    setPresenterBlackout(false);
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // The in-app presenter remains available if browser fullscreen is unavailable.
    }
  };

  const stopPresentation = async () => {
    setPresenterIndex(null);
    setShowPresenterNotes(false);
    setPresenterStartedAt(null);
    setPresenterBlackout(false);
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // No-op.
      }
    }
  };

  useEffect(() => {
    if (presenterIndex === null || presenterStartedAt === null) return;
    const tick = () => setPresenterElapsed(Math.max(0, Date.now() - presenterStartedAt));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [presenterIndex, presenterStartedAt]);

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

      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNativeDeck(event.shiftKey);
        return;
      }
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

  const objectAnimationClass = (animation?: ObjectAnimation) =>
    animation === "fade" ? styles.objectFadeIn :
    animation === "float-up" ? styles.objectFloatUp :
    animation === "zoom" ? styles.objectZoomIn :
    animation === "wipe" ? styles.objectWipeIn : "";

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

  const renderElement = (
    element: SlideElement,
    interactive: boolean,
    presenting = false
  ) => {
    if (element.hidden) return null;
    const isSelected = interactive && selectedIds.includes(element.id);
    const style: CSSProperties = {
      left: element.x,
      top: element.y,
      width: element.w,
      height: element.h,
      transform: element.rotation ? "rotate(" + element.rotation + "deg)" : undefined,
      opacity: element.opacity ?? 1,
      animationDuration: presenting && element.animation && element.animation !== "none"
        ? (element.animationDuration ?? 600) + "ms"
        : undefined,
      animationDelay: presenting && element.animation && element.animation !== "none"
        ? (element.animationDelay ?? 0) + "ms"
        : undefined,
      animationFillMode: presenting ? "both" : undefined,
      animationTimingFunction: presenting ? "cubic-bezier(.2,.8,.2,1)" : undefined
    };

    const content =
      element.type === "text" ? (
        <div
          className={styles.elementText}
          contentEditable={interactive && editingId === element.id}
          suppressContentEditableWarning
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (!element.locked) setEditingId(element.id);
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
            fontFamily: element.fontFamily ?? "inherit",
            fontStyle: element.italic ? "italic" : "normal",
            textDecoration: element.underline ? "underline" : "none",
            letterSpacing: element.letterSpacing ?? 0,
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
          style={{
            background: element.fill,
            border: (element.borderWidth ?? 0) + "px solid " + (element.borderColor ?? "#172033"),
            boxShadow: element.shadow ? "0 14px 30px rgba(18, 25, 38, .22)" : "none"
          }}
        />
      ) : element.type === "image" ? (
        <img
          className={styles.image}
          src={element.src}
          alt=""
          draggable={false}
          style={{
            objectFit: element.imageFit ?? "cover",
            objectPosition: (element.imageX ?? 50) + "% " + (element.imageY ?? 50) + "%",
            borderRadius:
              element.imageMask === "circle"
                ? "50%"
                : element.imageMask === "rounded"
                  ? "18px"
                  : "0",
            boxShadow: element.shadow ? "0 14px 30px rgba(18, 25, 38, .22)" : "none"
          }}
        />
      ) : element.type === "line" ? (
        <div
          className={styles.line}
          style={{
            background: element.fill,
            boxShadow: element.shadow ? "0 4px 12px rgba(18, 25, 38, .28)" : "none"
          }}
        />
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
          (element.groupId ? " " + styles.groupedElement : "") +
          (presenting ? " " + objectAnimationClass(element.animation) : "")
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
        {isSelected && !element.locked && editingId !== element.id && selectedIds.length === 1 && (
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

  const renderSlide = (
    slide: Slide,
    interactive = false,
    className = "",
    presenting = false
  ) => {
    const marqueeLeft = marquee ? Math.min(marquee.startX, marquee.x) : 0;
    const marqueeTop = marquee ? Math.min(marquee.startY, marquee.y) : 0;
    const marqueeWidth = marquee ? Math.abs(marquee.x - marquee.startX) : 0;
    const marqueeHeight = marquee ? Math.abs(marquee.y - marquee.startY) : 0;

    return (
      <div
        className={
          styles.canvas +
          (showGrid && interactive ? " " + styles.grid : "") +
          (className ? " " + className : "")
        }
        style={{ background: slide.background }}
        onPointerDown={interactive ? beginMarquee : undefined}
        onPointerMove={interactive ? moveMarquee : undefined}
        onPointerUp={interactive ? endMarquee : undefined}
      >
        {slide.elements.map((element) => renderElement(element, interactive, presenting))}
        {interactive && (slide.guides?.vertical ?? []).map((x, index) => (
          <div className={styles.manualGuideVertical} style={{ left: x }} key={"v-" + index} />
        ))}
        {interactive && (slide.guides?.horizontal ?? []).map((y, index) => (
          <div className={styles.manualGuideHorizontal} style={{ top: y }} key={"h-" + index} />
        ))}
        {interactive && guides.x !== undefined && (
          <div className={styles.guideVertical} style={{ left: guides.x }} />
        )}
        {interactive && guides.y !== undefined && (
          <div className={styles.guideHorizontal} style={{ top: guides.y }} />
        )}
        {interactive && marquee && (
          <div
            className={styles.marquee}
            style={{
              left: marqueeLeft,
              top: marqueeTop,
              width: marqueeWidth,
              height: marqueeHeight
            }}
          />
        )}
        {interactive && selectedIds.length > 1 && (
          <div className={styles.multiSelectionBadge}>
            {expandedSelection.length} selected
          </div>
        )}
      </div>
    );
  };

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
  const animatedElements = activeSlide.elements.filter(
    (element) => element.animation && element.animation !== "none"
  );
  const unresolvedComments = (activeSlide.comments ?? []).filter((comment) => !comment.resolved);
  const formatElapsed = (milliseconds: number) => {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    return minutes + ":" + seconds;
  };
  const slideTitle = (slide: Slide | undefined) =>
    slide?.elements.find((element) => element.type === "text" && !element.hidden)?.text ??
    "Untitled slide";

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
          <span className={styles.fileMeta}>
            {saveState} · {slides.length} slides · {nativePath ? nativePath.split(/[\\/]/).pop() : "TMSL"}
          </span>
        </div>
        <div className={styles.headerSpacer} />
        <button className={styles.iconBtn} onClick={undo} title="Undo (Ctrl+Z)">↶</button>
        <button className={styles.iconBtn} onClick={redo} title="Redo (Ctrl+Y)">↷</button>
        <button className={styles.ghostBtn} onClick={shareLink}>Share</button>
        <button className={styles.primaryBtn} onClick={startPresentation}>▶ Present</button>
      </header>

      <nav className={styles.menuBar} aria-label="Presentation menu">
        <button className={styles.menuItem} onClick={() => addSlide("content")}>New slide</button>
        <button className={styles.menuItem} onClick={() => importInput.current?.click()}>Open</button>
        <button className={styles.menuItem} onClick={() => void exportNativeDeck()}>Save .tmsl</button>
        <button className={styles.menuItem} onClick={() => void saveNativeDeck(true)}>Save As</button>
        {recoveryFile && (
          <button className={styles.menuItem} onClick={() => void recoverNativeDeck()}>
            Recover
          </button>
        )}
        <button className={styles.menuItem} onClick={() => void exportPptx()}>Export PPTX</button>
        <button className={styles.menuItem} onClick={exportLegacyJson}>Legacy JSON</button>
        <button className={styles.menuItem} onClick={() => window.print()}>Print / PDF</button>
        <button className={styles.menuItem} onClick={() => duplicateSlide()}>Duplicate slide</button>
        <button className={styles.menuItem} onClick={createSnapshot}>Save version</button>
        <button className={styles.menuItem} onClick={() => setInspectorMode("review")}>
          Review {unresolvedComments.length ? "(" + unresolvedComments.length + ")" : ""}
        </button>
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
            <button className={styles.toolbarBtn} onClick={saveSelectionAsComponent}>Save component</button>
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
            <div className={styles.slideNavBlock} key={slide.id}>
              {slide.section &&
                (index === 0 || slide.section !== slides[index - 1]?.section) && (
                  <div className={styles.sectionLabel}>{slide.section}</div>
                )}
              <div
                className={styles.slideRow + (slide.id === activeId ? " " + styles.slideRowActive : "")}
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
            </div>
          ))}
        </aside>

        <div className={styles.stageArea}>
          <div className={styles.stageScroll}>
            <div
              className={styles.stageFrame}
              style={{ width: SLIDE_W * zoom, height: SLIDE_H * zoom }}
            >
              <div className={styles.rulerTop}>
                {[0, 240, 480, 720, 960].map((value) => <span key={value}>{value}</span>)}
              </div>
              <div className={styles.rulerLeft}>
                {[0, 135, 270, 405, 540].map((value) => <span key={value}>{value}</span>)}
              </div>
              <div style={{ transform: "scale(" + zoom + ")", transformOrigin: "top left" }}>
                {renderSlide(activeSlide, true)}
              </div>
            </div>
          </div>
        </div>

        <aside className={styles.inspector}>
          <div className={styles.inspectorHeader}>
            {[
              ["slide", "Slide"],
              ["element", "Object"],
              ["layers", "Layers"],
              ["review", "Review"],
              ["history", "History"],
              ["components", "Assets"],
              ["theme", "Master"]
            ].map(([mode, label]) => (
              <button
                key={mode}
                className={styles.inspectorTab + (inspectorMode === mode ? " " + styles.inspectorTabActive : "")}
                onClick={() => setInspectorMode(mode as typeof inspectorMode)}
              >
                {label}
              </button>
            ))}
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
                  <label>Section</label>
                  <input
                    value={activeSlide.section ?? ""}
                    placeholder="e.g. Introduction"
                    onChange={(event) =>
                      mutateActive((slide) => ({ ...slide, section: event.target.value }))
                    }
                  />
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
                <h3 className={styles.panelTitle}>Guides & rulers</h3>
                <div className={styles.field}>
                  <label>Vertical guides (0–960)</label>
                  <input
                    value={(activeSlide.guides?.vertical ?? []).join(", ")}
                    placeholder="240, 480, 720"
                    onChange={(event) => updateGuideList("vertical", event.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label>Horizontal guides (0–540)</label>
                  <input
                    value={(activeSlide.guides?.horizontal ?? []).join(", ")}
                    placeholder="135, 270, 405"
                    onChange={(event) => updateGuideList("horizontal", event.target.value)}
                  />
                </div>
                <div className={styles.alignGrid}>
                  <button className={styles.inspectorBtn} onClick={() => addGuide("vertical")}>+ Vertical</button>
                  <button className={styles.inspectorBtn} onClick={() => addGuide("horizontal")}>+ Horizontal</button>
                </div>
                <button className={styles.inspectorBtn} onClick={clearManualGuides}>Clear manual guides</button>
              </div>

              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Animation timeline</h3>
                {animatedElements.length ? (
                  <div className={styles.timelineList}>
                    {animatedElements.map((element, index) => (
                      <button
                        key={element.id}
                        className={styles.timelineItem}
                        onClick={() => {
                          setSelectedIds([element.id]);
                          setInspectorMode("element");
                        }}
                      >
                        <span>{index + 1}</span>
                        <strong>{element.type}</strong>
                        <small>{element.animation} · {element.animationDelay ?? 0} ms</small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className={styles.panelHint}>Select an object and add an entrance animation.</p>
                )}
                <button className={styles.inspectorBtn} onClick={staggerSlideAnimations}>Stagger animations</button>
                <button className={styles.inspectorBtn} onClick={clearSlideAnimations}>Clear slide animations</button>
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
                <h3 className={styles.panelTitle}>Object identity</h3>
                <div className={styles.field}>
                  <label>Layer name</label>
                  <input
                    value={primaryElement.name ?? ""}
                    placeholder={primaryElement.type}
                    onChange={(event) =>
                      updateElement(primaryElement.id, { name: event.target.value })
                    }
                  />
                </div>
                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label>Lock</label>
                    <select
                      value={primaryElement.locked ? "locked" : "unlocked"}
                      onChange={(event) =>
                        updateElement(primaryElement.id, { locked: event.target.value === "locked" })
                      }
                    >
                      <option value="unlocked">Unlocked</option>
                      <option value="locked">Locked</option>
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label>Visibility</label>
                    <select
                      value={primaryElement.hidden ? "hidden" : "visible"}
                      onChange={(event) =>
                        updateElement(primaryElement.id, { hidden: event.target.value === "hidden" })
                      }
                    >
                      <option value="visible">Visible</option>
                      <option value="hidden">Hidden</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className={styles.panel}>
                <h3 className={styles.panelTitle}>Appearance</h3>

                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label>Opacity %</label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={Math.round((primaryElement.opacity ?? 1) * 100)}
                      onChange={(event) =>
                        updateElement(primaryElement.id, {
                          opacity: Math.max(0, Math.min(1, Number(event.target.value) / 100))
                        })
                      }
                    />
                  </div>
                  <div className={styles.field}>
                    <label>Shadow</label>
                    <select
                      value={primaryElement.shadow ? "on" : "off"}
                      onChange={(event) =>
                        updateElement(primaryElement.id, { shadow: event.target.value === "on" })
                      }
                    >
                      <option value="off">Off</option>
                      <option value="on">On</option>
                    </select>
                  </div>
                </div>

                {(primaryElement.type === "shape" || primaryElement.type === "line" || primaryElement.type === "chart") && (
                  <div className={styles.field}>
                    <label>Fill / accent</label>
                    <div className={styles.colorRow}>
                      <input type="color" value={primaryElement.fill} onChange={(event) => updateElement(primaryElement.id, { fill: event.target.value })} />
                      <input value={primaryElement.fill} onChange={(event) => updateElement(primaryElement.id, { fill: event.target.value })} />
                    </div>
                  </div>
                )}

                {primaryElement.type === "shape" && (
                  <div className={styles.fieldRow}>
                    <div className={styles.field}>
                      <label>Border width</label>
                      <input
                        type="number"
                        min="0"
                        max="24"
                        value={primaryElement.borderWidth ?? 0}
                        onChange={(event) =>
                          updateElement(primaryElement.id, { borderWidth: Number(event.target.value) })
                        }
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Border</label>
                      <input
                        type="color"
                        value={primaryElement.borderColor ?? "#172033"}
                        onChange={(event) =>
                          updateElement(primaryElement.id, { borderColor: event.target.value })
                        }
                      />
                    </div>
                  </div>
                )}

                {primaryElement.type === "text" && (
                  <>
                    <div className={styles.field}>
                      <label>Font family</label>
                      <select
                        value={primaryElement.fontFamily ?? "inherit"}
                        onChange={(event) =>
                          updateElement(primaryElement.id, { fontFamily: event.target.value })
                        }
                      >
                        <option value="inherit">Workspace Sans</option>
                        <option value="Georgia, serif">Georgia</option>
                        <option value="'Trebuchet MS', sans-serif">Trebuchet</option>
                        <option value="'Courier New', monospace">Courier</option>
                      </select>
                    </div>

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

                    <div className={styles.fieldRow}>
                      <div className={styles.field}>
                        <label>Letter spacing</label>
                        <input
                          type="number"
                          step="0.5"
                          value={primaryElement.letterSpacing ?? 0}
                          onChange={(event) =>
                            updateElement(primaryElement.id, { letterSpacing: Number(event.target.value) })
                          }
                        />
                      </div>
                      <div className={styles.field}>
                        <label>Style</label>
                        <select
                          value={
                            primaryElement.italic && primaryElement.underline
                              ? "both"
                              : primaryElement.italic
                                ? "italic"
                                : primaryElement.underline
                                  ? "underline"
                                  : "normal"
                          }
                          onChange={(event) => {
                            const value = event.target.value;
                            updateElement(primaryElement.id, {
                              italic: value === "italic" || value === "both",
                              underline: value === "underline" || value === "both"
                            });
                          }}
                        >
                          <option value="normal">Normal</option>
                          <option value="italic">Italic</option>
                          <option value="underline">Underline</option>
                          <option value="both">Italic + underline</option>
                        </select>
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

                {primaryElement.type === "image" && (
                  <>
                    <div className={styles.fieldRow}>
                      <div className={styles.field}>
                        <label>Fit</label>
                        <select
                          value={primaryElement.imageFit ?? "cover"}
                          onChange={(event) =>
                            updateElement(primaryElement.id, { imageFit: event.target.value as ImageFit })
                          }
                        >
                          <option value="cover">Crop / cover</option>
                          <option value="contain">Fit / contain</option>
                        </select>
                      </div>
                      <div className={styles.field}>
                        <label>Mask</label>
                        <select
                          value={primaryElement.imageMask ?? "rect"}
                          onChange={(event) =>
                            updateElement(primaryElement.id, { imageMask: event.target.value as ImageMask })
                          }
                        >
                          <option value="rect">Rectangle</option>
                          <option value="rounded">Rounded</option>
                          <option value="circle">Circle</option>
                        </select>
                      </div>
                    </div>
                    <div className={styles.field}>
                      <label>Crop position X · {primaryElement.imageX ?? 50}%</label>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={primaryElement.imageX ?? 50}
                        onChange={(event) =>
                          updateElement(primaryElement.id, { imageX: Number(event.target.value) })
                        }
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Crop position Y · {primaryElement.imageY ?? 50}%</label>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={primaryElement.imageY ?? 50}
                        onChange={(event) =>
                          updateElement(primaryElement.id, { imageY: Number(event.target.value) })
                        }
                      />
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

                <div className={styles.animationEditor}>
                  <h3 className={styles.panelTitle}>Entrance animation</h3>
                  <div className={styles.field}>
                    <label>Effect</label>
                    <select
                      value={primaryElement.animation ?? "none"}
                      onChange={(event) =>
                        updateElement(primaryElement.id, {
                          animation: event.target.value as ObjectAnimation
                        })
                      }
                    >
                      <option value="none">None</option>
                      <option value="fade">Fade</option>
                      <option value="float-up">Float up</option>
                      <option value="zoom">Zoom</option>
                      <option value="wipe">Wipe</option>
                    </select>
                  </div>
                  <div className={styles.fieldRow}>
                    <div className={styles.field}>
                      <label>Duration ms</label>
                      <input
                        type="number"
                        min="100"
                        max="5000"
                        step="50"
                        value={primaryElement.animationDuration ?? 600}
                        onChange={(event) =>
                          updateElement(primaryElement.id, {
                            animationDuration: Number(event.target.value)
                          })
                        }
                      />
                    </div>
                    <div className={styles.field}>
                      <label>Delay ms</label>
                      <input
                        type="number"
                        min="0"
                        max="10000"
                        step="50"
                        value={primaryElement.animationDelay ?? 0}
                        onChange={(event) =>
                          updateElement(primaryElement.id, {
                            animationDelay: Number(event.target.value)
                          })
                        }
                      />
                    </div>
                  </div>
                </div>

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

          {inspectorMode === "layers" && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Object layers</h3>
              <div className={styles.layerList}>
                {[...activeSlide.elements].reverse().map((element, index) => (
                  <div
                    className={
                      styles.layerItem +
                      (selectedIds.includes(element.id) ? " " + styles.layerItemActive : "")
                    }
                    key={element.id}
                  >
                    <button
                      className={styles.layerSelect}
                      onClick={() => {
                        setSelectedIds([element.id]);
                        setInspectorMode("element");
                      }}
                    >
                      <span>{activeSlide.elements.length - index}</span>
                      <strong>{element.name || element.type}</strong>
                    </button>
                    <button
                      className={styles.layerIcon}
                      title={element.hidden ? "Show object" : "Hide object"}
                      onClick={() => setLayerState(element.id, { hidden: !element.hidden })}
                    >
                      {element.hidden ? "○" : "●"}
                    </button>
                    <button
                      className={styles.layerIcon}
                      title={element.locked ? "Unlock object" : "Lock object"}
                      onClick={() => setLayerState(element.id, { locked: !element.locked })}
                    >
                      {element.locked ? "🔒" : "◇"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {inspectorMode === "review" && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Slide review</h3>
              <div className={styles.field}>
                <label>New comment</label>
                <textarea
                  value={commentDraft}
                  placeholder="Add a review note…"
                  onChange={(event) => setCommentDraft(event.target.value)}
                />
              </div>
              <button className={styles.inspectorBtn} onClick={addComment}>Add comment</button>

              <div className={styles.commentList}>
                {(activeSlide.comments ?? []).map((comment) => (
                  <div
                    className={
                      styles.commentCard +
                      (comment.resolved ? " " + styles.commentResolved : "")
                    }
                    key={comment.id}
                  >
                    <div className={styles.commentMeta}>
                      <strong>{comment.resolved ? "Resolved" : "Open"}</strong>
                      <span>{new Date(comment.createdAt).toLocaleString()}</span>
                    </div>
                    <p>{comment.text}</p>
                    <div className={styles.commentActions}>
                      <button onClick={() => toggleComment(comment.id)}>
                        {comment.resolved ? "Reopen" : "Resolve"}
                      </button>
                      <button onClick={() => removeComment(comment.id)}>Delete</button>
                    </div>
                  </div>
                ))}
                {!(activeSlide.comments ?? []).length && (
                  <p className={styles.panelHint}>No review comments on this slide.</p>
                )}
              </div>
            </div>
          )}

          {inspectorMode === "history" && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Version snapshots</h3>
              <button className={styles.inspectorBtn} onClick={createSnapshot}>Create snapshot now</button>
              <div className={styles.historyList}>
                {history.map((snapshot) => (
                  <div className={styles.historyCard} key={snapshot.id}>
                    <div>
                      <strong>{snapshot.label}</strong>
                      <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
                      <small>{snapshot.slides.length} slides · {snapshot.title}</small>
                    </div>
                    <div className={styles.historyActions}>
                      <button onClick={() => restoreSnapshot(snapshot)}>Restore</button>
                      <button onClick={() => deleteSnapshot(snapshot.id)}>Delete</button>
                    </div>
                  </div>
                ))}
                {!history.length && (
                  <p className={styles.panelHint}>Create a snapshot before a major edit to make rollback instant.</p>
                )}
              </div>
            </div>
          )}

          {inspectorMode === "components" && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Reusable components</h3>
              {expandedSelection.length > 0 && (
                <button className={styles.inspectorBtn} onClick={saveSelectionAsComponent}>
                  Save current selection
                </button>
              )}
              <div className={styles.componentList}>
                {components.map((component) => (
                  <div className={styles.componentCard} key={component.id}>
                    <div>
                      <strong>{component.name}</strong>
                      <span>{component.elements.length} objects</span>
                    </div>
                    <div className={styles.componentActions}>
                      <button onClick={() => insertComponent(component)}>Insert</button>
                      <button onClick={() => deleteComponent(component.id)}>Delete</button>
                    </div>
                  </div>
                ))}
                {!components.length && (
                  <p className={styles.panelHint}>Select one or more objects and save them as a reusable component.</p>
                )}
              </div>
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
        <span>{activeSlide.section ? "Section: " + activeSlide.section : "No section"}</span>
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
      <input
        ref={importInput}
        type="file"
        accept=".tmsl,.json,application/x-tamishra-slides,application/json"
        hidden
        onChange={importDeck}
      />

      <div className={styles.printDeck}>{printSlides}</div>

      {presenterIndex !== null && slides[presenterIndex] && (
        <div className={styles.presenter}>
          <div className={styles.presenterStage}>
            {presenterBlackout && <div className={styles.presenterBlackout} />}
            <div
              key={slides[presenterIndex].id}
              className={
                styles.presenterCanvas +
                " " +
                animationClass(slides[presenterIndex].transition)
              }
              style={{ transform: "scale(" + presenterScale + ")" }}
            >
              {renderSlide(slides[presenterIndex], false, "", true)}
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
            <strong className={styles.presenterTimer}>{formatElapsed(presenterElapsed)}</strong>
            <span className={styles.presenterNext}>
              Next: {slideTitle(slides[Math.min(slides.length - 1, presenterIndex + 1)])}
            </span>
            <button onClick={() => setPresenterIndex((index) => index === null ? null : Math.min(slides.length - 1, index + 1))}>Next →</button>
            <button onClick={() => setShowPresenterNotes((value) => !value)}>Notes</button>
            <button onClick={() => setPresenterBlackout((value) => !value)}>
              {presenterBlackout ? "Resume" : "Black"}
            </button>
            <button onClick={() => {
              setPresenterStartedAt(Date.now());
              setPresenterElapsed(0);
            }}>Reset timer</button>
            <button onClick={() => void stopPresentation()}>Exit</button>
          </div>
        </div>
      )}
    </main>
  );
}
