import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import DocsEditor from "./DocsEditor";
import styles from "./docs-workbench.module.css";

export const metadata = {
  title: "Tamishra Docs | Tamishra Workspace"
};

export default function DocsPage() {
  return (
    <WorkspaceAppShell
      currentApp="docs"
      title="Docs"
      subtitle="Native document editor · .tmdoc"
      mode="editor"
    >
      <div className={styles.embedded}>
        <DocsEditor />
      </div>
    </WorkspaceAppShell>
  );
}
