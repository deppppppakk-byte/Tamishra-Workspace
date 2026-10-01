"use client";

import type {
  HeaderFooterAlignment,
  HeaderFooterSettings,
  PageNumberFormat,
  PageNumberPosition
} from "@tamishra/document-model";

type Props = {
  settings: HeaderFooterSettings;
  headerText: string;
  footerText: string;
  onSettingsChange: (next: HeaderFooterSettings) => void;
  onHeaderTextChange: (value: string) => void;
  onFooterTextChange: (value: string) => void;
};

const alignments: Array<{ value: HeaderFooterAlignment; label: string }> = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" }
];

export default function HeaderFooterSettingsPanel({
  settings,
  headerText,
  footerText,
  onSettingsChange,
  onHeaderTextChange,
  onFooterTextChange
}: Props) {
  const update = <K extends keyof HeaderFooterSettings>(
    key: K,
    value: HeaderFooterSettings[K]
  ) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <div className="docsHeaderFooterSettings">
      <label className="docsToggleRow">
        <input
          type="checkbox"
          checked={settings.headerEnabled}
          onChange={(event) => update("headerEnabled", event.target.checked)}
        />
        <span>Header</span>
      </label>

      {settings.headerEnabled && (
        <div className="docsChromeGroup">
          <input
            type="text"
            value={headerText}
            onChange={(event) => onHeaderTextChange(event.target.value)}
            placeholder="Header text — use {title}, {page}, {pages}"
            aria-label="Header text"
          />
          <div className="docsInlineSettings">
            <select
              value={settings.headerAlignment}
              onChange={(event) =>
                update("headerAlignment", event.target.value as HeaderFooterAlignment)
              }
              aria-label="Header alignment"
            >
              {alignments.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <label>
              <span>Edge</span>
              <input
                type="number"
                min="4"
                max="40"
                step="1"
                value={Number(settings.headerDistanceMm.toFixed(1))}
                onChange={(event) =>
                  update(
                    "headerDistanceMm",
                    Math.max(4, Math.min(40, Number(event.target.value) || 4))
                  )
                }
              />
              <small>mm</small>
            </label>
          </div>
        </div>
      )}

      <label className="docsToggleRow">
        <input
          type="checkbox"
          checked={settings.footerEnabled}
          onChange={(event) => update("footerEnabled", event.target.checked)}
        />
        <span>Footer</span>
      </label>

      {settings.footerEnabled && (
        <div className="docsChromeGroup">
          <input
            type="text"
            value={footerText}
            onChange={(event) => onFooterTextChange(event.target.value)}
            placeholder="Footer text — use {title}, {page}, {pages}"
            aria-label="Footer text"
          />
          <div className="docsInlineSettings">
            <select
              value={settings.footerAlignment}
              onChange={(event) =>
                update("footerAlignment", event.target.value as HeaderFooterAlignment)
              }
              aria-label="Footer alignment"
            >
              {alignments.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <label>
              <span>Edge</span>
              <input
                type="number"
                min="4"
                max="40"
                step="1"
                value={Number(settings.footerDistanceMm.toFixed(1))}
                onChange={(event) =>
                  update(
                    "footerDistanceMm",
                    Math.max(4, Math.min(40, Number(event.target.value) || 4))
                  )
                }
              />
              <small>mm</small>
            </label>
          </div>
        </div>
      )}

      <label className="docsToggleRow">
        <input
          type="checkbox"
          checked={settings.pageNumberEnabled}
          onChange={(event) => update("pageNumberEnabled", event.target.checked)}
        />
        <span>Page numbers</span>
      </label>

      {settings.pageNumberEnabled && (
        <div className="docsChromeGroup">
          <select
            value={settings.pageNumberPosition}
            onChange={(event) =>
              update("pageNumberPosition", event.target.value as PageNumberPosition)
            }
            aria-label="Page number position"
          >
            <option value="header-left">Header · Left</option>
            <option value="header-center">Header · Center</option>
            <option value="header-right">Header · Right</option>
            <option value="footer-left">Footer · Left</option>
            <option value="footer-center">Footer · Center</option>
            <option value="footer-right">Footer · Right</option>
          </select>

          <select
            value={settings.pageNumberFormat}
            onChange={(event) =>
              update("pageNumberFormat", event.target.value as PageNumberFormat)
            }
            aria-label="Page number format"
          >
            <option value="number">1</option>
            <option value="page-number">Page 1</option>
            <option value="page-number-of-total">Page 1 of 5</option>
          </select>

          <label className="docsNumberStart">
            <span>Start at</span>
            <input
              type="number"
              min="0"
              max="9999"
              step="1"
              value={settings.pageNumberStart}
              onChange={(event) =>
                update(
                  "pageNumberStart",
                  Math.max(0, Math.min(9999, Number(event.target.value) || 0))
                )
              }
            />
          </label>
        </div>
      )}

      <label className="docsToggleRow">
        <input
          type="checkbox"
          checked={settings.hideOnFirstPage}
          onChange={(event) => update("hideOnFirstPage", event.target.checked)}
        />
        <span>Hide on first page</span>
      </label>
    </div>
  );
}
