"use client";

import {
  withMargins,
  withOrientation,
  withPageSize,
  type PageConfig,
  type PageOrientation,
  type PageSizeName
} from "@tamishra/document-model";

type Props = {
  page: PageConfig;
  onChange: (next: PageConfig, label: string) => void;
};

const presets = {
  normal: { topMm: 25.4, rightMm: 25.4, bottomMm: 25.4, leftMm: 25.4 },
  narrow: { topMm: 12.7, rightMm: 12.7, bottomMm: 12.7, leftMm: 12.7 },
  wide: { topMm: 25.4, rightMm: 50.8, bottomMm: 25.4, leftMm: 50.8 }
} as const;

export default function PageSettings({ page, onChange }: Props) {
  const setMargin = (side: keyof PageConfig["margins"], value: number) => {
    onChange(
      withMargins(page, {
        ...page.margins,
        [side]: Math.max(0, Math.min(80, value))
      }),
      "Change page margins"
    );
  };

  return (
    <div className="docsPageSettings">
      <div className="docsSettingsRow">
        <label htmlFor="docs-page-size">Page size</label>
        <select
          id="docs-page-size"
          value={page.size}
          onChange={(event) =>
            onChange(withPageSize(page, event.target.value as PageSizeName), "Change page size")
          }
        >
          <option value="A4">A4</option>
          <option value="LETTER">Letter</option>
          <option value="LEGAL">Legal</option>
          <option value="A3">A3</option>
        </select>
      </div>

      <div className="docsSettingsRow">
        <label htmlFor="docs-orientation">Orientation</label>
        <select
          id="docs-orientation"
          value={page.orientation}
          onChange={(event) =>
            onChange(
              withOrientation(page, event.target.value as PageOrientation),
              "Change page orientation"
            )
          }
        >
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </div>

      <div className="docsSettingsRow">
        <label htmlFor="docs-margin-preset">Margins</label>
        <select
          id="docs-margin-preset"
          defaultValue="normal"
          onChange={(event) => {
            const preset = presets[event.target.value as keyof typeof presets];
            onChange(withMargins(page, preset), "Apply margin preset");
          }}
        >
          <option value="normal">Normal</option>
          <option value="narrow">Narrow</option>
          <option value="wide">Wide</option>
        </select>
      </div>

      <div className="docsMarginGrid">
        <label>
          <span>Top</span>
          <input
            type="number"
            min="0"
            max="80"
            step="1"
            value={Number(page.margins.topMm.toFixed(1))}
            onChange={(event) => setMargin("topMm", Number(event.target.value))}
          />
        </label>
        <label>
          <span>Right</span>
          <input
            type="number"
            min="0"
            max="80"
            step="1"
            value={Number(page.margins.rightMm.toFixed(1))}
            onChange={(event) => setMargin("rightMm", Number(event.target.value))}
          />
        </label>
        <label>
          <span>Bottom</span>
          <input
            type="number"
            min="0"
            max="80"
            step="1"
            value={Number(page.margins.bottomMm.toFixed(1))}
            onChange={(event) => setMargin("bottomMm", Number(event.target.value))}
          />
        </label>
        <label>
          <span>Left</span>
          <input
            type="number"
            min="0"
            max="80"
            step="1"
            value={Number(page.margins.leftMm.toFixed(1))}
            onChange={(event) => setMargin("leftMm", Number(event.target.value))}
          />
        </label>
      </div>

      <div className="docsPageDimensions">
        {page.widthMm.toFixed(1)} × {page.heightMm.toFixed(1)} mm
      </div>
    </div>
  );
}
