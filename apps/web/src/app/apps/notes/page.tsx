import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import NotesWorkspace from "./NotesWorkspace";
import styles from "./notes-workbench.module.css";

export const metadata = {
  title: "Tamishra Notes | Tamishra Workspace"
};

export default function NotesPage() {
  return (
    <WorkspaceAppShell
      currentApp="notes"
      title="Notes"
      subtitle="Native notes workspace · .tmnt"
      mode="editor"
    >
      <div className={styles.embedded}>
        <NotesWorkspace />
      </div>
    </WorkspaceAppShell>
  );
}
