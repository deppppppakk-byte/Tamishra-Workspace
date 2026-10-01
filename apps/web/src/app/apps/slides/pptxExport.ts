type ExportElement = {
  id: string;
  type: "text" | "shape" | "image" | "line" | "table" | "chart";
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
  shape?: "rect" | "ellipse" | "rounded";
  rotation?: number;
  tableData?: string[][];
  chartData?: number[];
  chartLabels?: string[];
  chartKind?: "bar" | "line" | "donut";
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;
  shadow?: boolean;
  fontFamily?: string;
  italic?: boolean;
  underline?: boolean;
  imageFit?: "cover" | "contain";
  imageMask?: "rect" | "rounded" | "circle";
  hidden?: boolean;
};

type ExportSlide = {
  id: string;
  background: string;
  notes: string;
  elements: ExportElement[];
};

type ExportDeck = {
  title: string;
  slides: ExportSlide[];
};

const pxToIn = (value: number) => value / 72;
const normalizeColor = (color: string | undefined, fallback = "000000") =>
  (color ?? fallback).replace("#", "").slice(0, 6).toUpperCase();

const transparency = (opacity?: number) =>
  Math.round((1 - Math.max(0, Math.min(1, opacity ?? 1))) * 100);

const safeFileName = (value: string) =>
  (value.trim() || "presentation").replace(/[^a-z0-9-_]+/gi, "-");

export async function exportDeckToPptx(deck: ExportDeck) {
  const module = await import("pptxgenjs");
  const PptxGenJS = module.default;
  const pptx = new PptxGenJS();

  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Tamishra Slides";
  pptx.company = "Tamishra";
  pptx.subject = "Presentation created in Tamishra Slides";
  pptx.title = deck.title;
  pptx.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial"
  };

  for (const sourceSlide of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: normalizeColor(sourceSlide.background, "FFFFFF") };

    for (const element of sourceSlide.elements) {
      if (element.hidden) continue;

      const x = pxToIn(element.x);
      const y = pxToIn(element.y);
      const w = pxToIn(element.w);
      const h = pxToIn(element.h);
      const rotate = element.rotation ?? 0;
      const objectTransparency = transparency(element.opacity);
      const shadow = element.shadow
        ? {
            type: "outer" as const,
            color: "222222",
            opacity: 0.22,
            blur: 2,
            angle: 45,
            distance: 2
          }
        : undefined;

      if (element.type === "text") {
        slide.addText(element.text ?? "", {
          x,
          y,
          w,
          h,
          rotate,
          margin: 0,
          breakLine: false,
          fontFace:
            element.fontFamily && element.fontFamily !== "inherit"
              ? element.fontFamily.replace(/[',]/g, "").split(" ")[0]
              : "Arial",
          fontSize: Math.max(1, (element.fontSize ?? 28) * 0.75),
          bold: (element.fontWeight ?? 500) >= 650,
          italic: Boolean(element.italic),
          underline: element.underline ? { style: "sng" } : undefined,
          color: normalizeColor(element.color, "172033"),
          align: element.align ?? "left",
          valign: "middle",
          transparency: objectTransparency,
          shadow
        });
        continue;
      }

      if (element.type === "shape") {
        const shapeType =
          element.shape === "ellipse" ? pptx.ShapeType.ellipse : pptx.ShapeType.rect;
        slide.addShape(shapeType, {
          x,
          y,
          w,
          h,
          rotate,
          rectRadius: element.shape === "rounded" ? 0.15 : undefined,
          fill: {
            color: normalizeColor(element.fill, "6F5DF5"),
            transparency: objectTransparency
          },
          line: {
            color: normalizeColor(element.borderColor, element.fill),
            width: Math.max(0.25, element.borderWidth ?? 0.25),
            transparency: element.borderWidth ? objectTransparency : 100
          },
          shadow
        });
        continue;
      }

      if (element.type === "line") {
        slide.addShape(pptx.ShapeType.line, {
          x,
          y: y + h / 2,
          w,
          h: 0,
          rotate,
          line: {
            color: normalizeColor(element.fill, "6F5DF5"),
            width: 2.25,
            transparency: objectTransparency
          },
          shadow
        });
        continue;
      }

      if (element.type === "image" && element.src) {
        slide.addImage({
          data: element.src,
          x,
          y,
          w,
          h,
          rotate,
          transparency: objectTransparency,
          rounding: element.imageMask === "circle",
          sizing: {
            type: element.imageFit === "contain" ? "contain" : "cover",
            x,
            y,
            w,
            h
          }
        });
        continue;
      }

      if (element.type === "table") {
        const rows = element.tableData?.length
          ? element.tableData
          : [["A", "B", "C"], ["1", "2", "3"]];
        slide.addTable(
          rows.map((row) => row.map((text) => ({ text }))),
          {
          x,
          y,
          w,
          h,
          border: {
            type: "solid",
            color: "D5D9E1",
            pt: 1
          },
          color: normalizeColor(element.color, "172033"),
          fill: { color: "FFFFFF" },
          fontFace: "Arial",
          fontSize: 12,
          margin: 0.05
          }
        );
        continue;
      }

      if (element.type === "chart") {
        const values = element.chartData?.length ? element.chartData : [44, 72, 58, 88];
        const labels = element.chartLabels?.length
          ? element.chartLabels
          : values.map((_, index) => "S" + (index + 1));
        const chartType =
          element.chartKind === "line"
            ? pptx.ChartType.line
            : element.chartKind === "donut"
              ? pptx.ChartType.doughnut
              : pptx.ChartType.bar;

        slide.addChart(
          chartType,
          [{
            name: "Series 1",
            labels,
            values
          }],
          {
            x,
            y,
            w,
            h,
            showLegend: false,
            showTitle: false,
            showValue: false,
            chartColors: [normalizeColor(element.fill, "6F5DF5")],
            catAxisLabelFontFace: "Arial",
            valAxisLabelFontFace: "Arial",
            border: { color: "D5D9E1", pt: 1 }
          }
        );
      }
    }

    if (sourceSlide.notes?.trim()) {
      slide.addNotes(sourceSlide.notes);
    }
  }

  await pptx.writeFile({
    fileName: safeFileName(deck.title) + ".pptx",
    compression: true
  });
}
