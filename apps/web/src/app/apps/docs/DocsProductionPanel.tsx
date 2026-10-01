"use client";

import type {
  DocsComment,
  DocsEditingMode,
  DocsLibraryRecord,
  DocsOutlineEntry,
  DocsProofingStats,
  DocsShareGrant,
  DocsSuggestion,
  DocsVersion,
  DocsWorkspaceSnapshot
} from "@tamishra/docs-engine";

export type DocsPanelTab =
  | "files"
  | "outline"
  | "comments"
  | "versions"
  | "share"
  | "format"
  | "table"
  | "insert"
  | "proofing";

type Props = {
  tab: DocsPanelTab;
  workspace: DocsWorkspaceSnapshot;
  currentDocumentId: string | null;
  outline: DocsOutlineEntry[];
  comments: DocsComment[];
  versions: DocsVersion[];
  grants: DocsShareGrant[];
  suggestions: DocsSuggestion[];
  collaborators: string[];
  proofing: DocsProofingStats;
  editingMode: DocsEditingMode;
  language: string;
  spellcheck: boolean;
  tableActive: boolean;
  onClose: () => void;
  onNew: () => void;
  onSaveAs: () => void;
  onOpen: (record: DocsLibraryRecord) => void;
  onDuplicate: (id: string) => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
  onDeleteForever: (id: string) => void;
  onImportDocx: () => void;
  onExportDocx: () => void;
  onGoToOutline: (entry: DocsOutlineEntry) => void;
  onAddComment: () => void;
  onReplyComment: (commentId: string, body: string) => void;
  onToggleResolveComment: (commentId: string) => void;
  onSuggestReplacement: () => void;
  onResolveSuggestion: (suggestionId: string, status: "accepted" | "rejected") => void;
  onCreateVersion: (label?: string) => void;
  onRestoreVersion: (version: DocsVersion) => void;
  onAddGrant: (principal: string, role: "editor" | "commenter" | "viewer") => void;
  onRemoveGrant: (grantId: string) => void;
  onEditingModeChange: (mode: DocsEditingMode) => void;
  onLanguageChange: (language: string) => void;
  onSpellcheckChange: (enabled: boolean) => void;
  onApplyFontFamily: (family: string) => void;
  onApplyExactFontSize: (points: number) => void;
  onApplyLineHeight: (value: number) => void;
  onApplyParagraphSpacing: (before: number, after: number) => void;
  onApplyIndent: (kind: "first-line" | "hanging" | "left" | "right", value: number) => void;
  onTableAction: (
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
  ) => void;
  onInsertAction: (
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
  ) => void;
};

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="docsPanelEmpty">{children}</div>;
}

export default function DocsProductionPanel(props: Props) {
  const {
    tab,
    workspace,
    currentDocumentId,
    outline,
    comments,
    versions,
    grants,
    suggestions,
    collaborators,
    proofing,
    editingMode,
    language,
    spellcheck,
    tableActive
  } = props;

  const currentRecords = workspace.records
    .filter((item) => !item.trashedAt)
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  const trashedRecords = workspace.records.filter((item) => Boolean(item.trashedAt));

  return (
    <aside className="docsProductionPanel">
      <div className="docsPanelHeader">
        <strong>
          {tab === "files" ? "Documents" :
           tab === "outline" ? "Outline" :
           tab === "comments" ? "Comments & review" :
           tab === "versions" ? "Version history" :
           tab === "share" ? "Share" :
           tab === "format" ? "Advanced format" :
           tab === "table" ? "Table tools" :
           tab === "insert" ? "Insert" :
           "Proofing"}
        </strong>
        <button onClick={props.onClose} aria-label="Close panel">×</button>
      </div>

      <div className="docsPanelBody">
        {tab === "files" && (
          <>
            <div className="docsPanelActions">
              <button onClick={props.onNew}>New</button>
              <button onClick={props.onSaveAs}>Save As</button>
              <button onClick={props.onImportDocx}>Open DOCX</button>
              <button onClick={props.onExportDocx}>Export DOCX</button>
            </div>

            <h4>Recent documents</h4>
            {currentRecords.length === 0 ? (
              <Empty>No saved documents yet.</Empty>
            ) : (
              <div className="docsRecordList">
                {currentRecords.map((record) => (
                  <div
                    key={record.id}
                    className={`docsRecordItem ${record.id === currentDocumentId ? "active" : ""}`}
                  >
                    <button className="docsRecordOpen" onClick={() => props.onOpen(record)}>
                      <strong>{record.title}</strong>
                      <span>{new Date(record.updatedAt).toLocaleString()}</span>
                    </button>
                    <div className="docsRecordActions">
                      <button onClick={() => props.onDuplicate(record.id)}>Copy</button>
                      <button onClick={() => props.onTrash(record.id)}>Trash</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {trashedRecords.length > 0 && (
              <>
                <h4>Trash</h4>
                <div className="docsRecordList">
                  {trashedRecords.map((record) => (
                    <div className="docsRecordItem" key={record.id}>
                      <div className="docsRecordOpen">
                        <strong>{record.title}</strong>
                        <span>Deleted {new Date(record.trashedAt!).toLocaleString()}</span>
                      </div>
                      <div className="docsRecordActions">
                        <button onClick={() => props.onRestore(record.id)}>Restore</button>
                        <button onClick={() => props.onDeleteForever(record.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {tab === "outline" && (
          <>
            <div className="docsPanelHint">Built automatically from document headings.</div>
            {outline.length === 0 ? (
              <Empty>Add headings to create a document outline.</Empty>
            ) : (
              <div className="docsOutlineList">
                {outline.map((entry) => (
                  <button
                    key={entry.id}
                    style={{ paddingLeft: 10 + (entry.level - 1) * 14 }}
                    onClick={() => props.onGoToOutline(entry)}
                  >
                    {entry.text}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "comments" && (
          <>
            <label className="docsField">
              <span>Editing mode</span>
              <select
                value={editingMode}
                onChange={(event) =>
                  props.onEditingModeChange(event.target.value as DocsEditingMode)
                }
              >
                <option value="editing">Editing</option>
                <option value="reviewing">Reviewing</option>
                <option value="viewing">Viewing</option>
              </select>
            </label>

            <div className="docsPanelActions">
              <button className="docsPanelPrimary" onClick={props.onAddComment}>
                Comment on selection
              </button>
              <button className="docsPanelPrimary" onClick={props.onSuggestReplacement}>
                Suggest replacement
              </button>
            </div>

            {comments.length === 0 ? (
              <Empty>No comments in this document.</Empty>
            ) : (
              <div className="docsCommentList">
                {comments.map((comment) => (
                  <div className={`docsCommentCard ${comment.resolvedAt ? "resolved" : ""}`} key={comment.id}>
                    <div className="docsCommentMeta">
                      <strong>{comment.authorName}</strong>
                      <span>{new Date(comment.createdAt).toLocaleString()}</span>
                    </div>
                    {comment.quotedText && <blockquote>{comment.quotedText}</blockquote>}
                    <p>{comment.body}</p>
                    {comment.replies.map((reply) => (
                      <div className="docsCommentReply" key={reply.id}>
                        <strong>{reply.authorName}</strong>
                        <span>{reply.body}</span>
                      </div>
                    ))}
                    <div className="docsRecordActions">
                      <button
                        onClick={() => {
                          const body = window.prompt("Reply");
                          if (body?.trim()) props.onReplyComment(comment.id, body.trim());
                        }}
                      >
                        Reply
                      </button>
                      <button onClick={() => props.onToggleResolveComment(comment.id)}>
                        {comment.resolvedAt ? "Reopen" : "Resolve"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <h4>Suggested changes</h4>
            {suggestions.filter((item) => item.status === "pending").length === 0 ? (
              <Empty>No pending suggestions.</Empty>
            ) : (
              <div className="docsCommentList">
                {suggestions
                  .filter((item) => item.status === "pending")
                  .map((suggestion) => (
                    <div className="docsCommentCard" key={suggestion.id}>
                      <div className="docsCommentMeta">
                        <strong>{suggestion.authorName}</strong>
                        <span>{new Date(suggestion.createdAt).toLocaleString()}</span>
                      </div>
                      <p><del>{suggestion.beforeText || "—"}</del></p>
                      <p><ins>{suggestion.afterText || "—"}</ins></p>
                      <div className="docsRecordActions">
                        <button onClick={() => props.onResolveSuggestion(suggestion.id, "accepted")}>
                          Accept
                        </button>
                        <button onClick={() => props.onResolveSuggestion(suggestion.id, "rejected")}>
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}

        {tab === "versions" && (
          <>
            <button
              className="docsPanelPrimary"
              onClick={() => {
                const label = window.prompt("Version label (optional)") ?? undefined;
                props.onCreateVersion(label?.trim() || undefined);
              }}
            >
              Save named version
            </button>
            {versions.length === 0 ? (
              <Empty>No stored versions yet.</Empty>
            ) : (
              <div className="docsVersionList">
                {versions.map((version) => (
                  <div className="docsVersionItem" key={version.id}>
                    <strong>{version.label || version.reason}</strong>
                    <span>{version.authorName}</span>
                    <span>{new Date(version.createdAt).toLocaleString()}</span>
                    <button onClick={() => props.onRestoreVersion(version)}>Restore</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "share" && (
          <>
            <button
              className="docsPanelPrimary"
              onClick={() => {
                const principal = window.prompt("Email or workspace user");
                if (!principal?.trim()) return;
                const role = (window.prompt("Role: editor, commenter, viewer", "viewer") || "viewer")
                  .toLowerCase();
                if (!["editor", "commenter", "viewer"].includes(role)) return;
                props.onAddGrant(
                  principal.trim(),
                  role as "editor" | "commenter" | "viewer"
                );
              }}
            >
              Add person
            </button>

            <div className="docsPanelHint">
              Local permissions work offline; the gateway adapter can sync the same grants to cloud storage.
            </div>
            <div className="docsPresenceStrip">
              <strong>{collaborators.length + 1} active</strong>
              <span>You{collaborators.length ? ` + ${collaborators.join(", ")}` : ""}</span>
            </div>

            {grants.length === 0 ? (
              <Empty>This document is private.</Empty>
            ) : (
              <div className="docsShareList">
                {grants.map((grant) => (
                  <div className="docsShareItem" key={grant.id}>
                    <div>
                      <strong>{grant.principal}</strong>
                      <span>{grant.role}</span>
                    </div>
                    <button onClick={() => props.onRemoveGrant(grant.id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "format" && (
          <>
            <label className="docsField">
              <span>Font family</span>
              <select onChange={(event) => props.onApplyFontFamily(event.target.value)} defaultValue="">
                <option value="" disabled>Select</option>
                <option value="Arial">Arial</option>
                <option value="Georgia">Georgia</option>
                <option value="Times New Roman">Times New Roman</option>
                <option value="Verdana">Verdana</option>
                <option value="Courier New">Courier New</option>
              </select>
            </label>
            <label className="docsField">
              <span>Exact font size (pt)</span>
              <input
                type="number"
                min="6"
                max="96"
                defaultValue="11"
                onBlur={(event) => props.onApplyExactFontSize(Number(event.target.value))}
              />
            </label>
            <label className="docsField">
              <span>Line spacing</span>
              <select onChange={(event) => props.onApplyLineHeight(Number(event.target.value))} defaultValue="1.5">
                <option value="1">1.0</option>
                <option value="1.15">1.15</option>
                <option value="1.5">1.5</option>
                <option value="2">2.0</option>
              </select>
            </label>
            <div className="docsPanelActions">
              <button onClick={() => props.onApplyParagraphSpacing(0, 8)}>Compact</button>
              <button onClick={() => props.onApplyParagraphSpacing(6, 10)}>Normal</button>
              <button onClick={() => props.onApplyParagraphSpacing(12, 14)}>Spacious</button>
            </div>
            <h4>Indent</h4>
            <div className="docsPanelActions">
              <button onClick={() => props.onApplyIndent("first-line", 24)}>First line</button>
              <button onClick={() => props.onApplyIndent("hanging", 24)}>Hanging</button>
              <button onClick={() => props.onApplyIndent("left", 24)}>Left +</button>
              <button onClick={() => props.onApplyIndent("right", 24)}>Right +</button>
            </div>
          </>
        )}

        {tab === "table" && (
          <>
            {!tableActive ? (
              <Empty>Click inside a table to enable table tools.</Empty>
            ) : (
              <>
                <div className="docsPanelActions">
                  <button onClick={() => props.onTableAction("row-above")}>Row above</button>
                  <button onClick={() => props.onTableAction("row-below")}>Row below</button>
                  <button onClick={() => props.onTableAction("column-left")}>Column left</button>
                  <button onClick={() => props.onTableAction("column-right")}>Column right</button>
                </div>
                <div className="docsPanelActions">
                  <button onClick={() => props.onTableAction("merge-right")}>Merge right</button>
                  <button onClick={() => props.onTableAction("split-cell")}>Split cell</button>
                  <button onClick={() => props.onTableAction("header-row")}>Header row</button>
                  <button onClick={() => props.onTableAction("distribute-columns")}>Equal columns</button>
                </div>
                <div className="docsPanelActions">
                  <button onClick={() => props.onTableAction("delete-row")}>Delete row</button>
                  <button onClick={() => props.onTableAction("delete-column")}>Delete column</button>
                  <button className="docsDangerButton" onClick={() => props.onTableAction("delete-table")}>Delete table</button>
                </div>
              </>
            )}
          </>
        )}

        {tab === "insert" && (
          <>
            <div className="docsInsertGrid">
              <button onClick={() => props.onInsertAction("toc")}>Table of contents</button>
              <button onClick={() => props.onInsertAction("footnote")}>Footnote</button>
              <button onClick={() => props.onInsertAction("endnote")}>Endnote</button>
              <button onClick={() => props.onInsertAction("equation")}>Equation</button>
              <button onClick={() => props.onInsertAction("symbol")}>Symbol</button>
              <button onClick={() => props.onInsertAction("date")}>Date / time</button>
              <button onClick={() => props.onInsertAction("bookmark")}>Bookmark</button>
              <button onClick={() => props.onInsertAction("section-break")}>Section break</button>
            </div>
            <h4>Columns</h4>
            <div className="docsPanelActions">
              <button onClick={() => props.onInsertAction("columns-1")}>1</button>
              <button onClick={() => props.onInsertAction("columns-2")}>2</button>
              <button onClick={() => props.onInsertAction("columns-3")}>3</button>
            </div>
          </>
        )}

        {tab === "proofing" && (
          <>
            <label className="docsField">
              <span>Language</span>
              <select value={language} onChange={(event) => props.onLanguageChange(event.target.value)}>
                <option value="en-US">English (US)</option>
                <option value="en-GB">English (UK)</option>
                <option value="hi-IN">Hindi</option>
                <option value="de-DE">German</option>
                <option value="fr-FR">French</option>
              </select>
            </label>
            <label className="docsToggleRow">
              <input
                type="checkbox"
                checked={spellcheck}
                onChange={(event) => props.onSpellcheckChange(event.target.checked)}
              />
              <span>Browser spellcheck</span>
            </label>
            <div className="docsStatsList">
              <div><span>Words</span><strong>{proofing.words}</strong></div>
              <div><span>Characters</span><strong>{proofing.characters}</strong></div>
              <div><span>No spaces</span><strong>{proofing.charactersNoSpaces}</strong></div>
              <div><span>Paragraphs</span><strong>{proofing.paragraphs}</strong></div>
              <div><span>Headings</span><strong>{proofing.headings}</strong></div>
              <div><span>Sentences</span><strong>{proofing.sentences}</strong></div>
              <div><span>Reading time</span><strong>{proofing.estimatedReadingMinutes} min</strong></div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
