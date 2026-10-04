import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import SheetsWorkspace from "./SheetsWorkspace";
import styles from "./sheets-workbench.module.css";

export const metadata = {
  title: "Tamishra Sheets | Tamishra Workspace"
};

export default function SheetsPage() {
  return (
    <WorkspaceAppShell
      currentApp="sheets"
      title="Sheets"
      subtitle="Native spreadsheet editor · .tmsh"
      mode="editor"
    >
      <div className={styles.embedded}>
        <SheetsWorkspace />
      </div>
    </WorkspaceAppShell>
  );
}
