import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import FormsWorkspace from "./FormsWorkspace";
import styles from "./forms-workbench.module.css";

export const metadata = {
  title: "Tamishra Forms | Tamishra Workspace"
};

export default function FormsPage() {
  return (
    <WorkspaceAppShell
      currentApp="forms"
      title="Forms"
      subtitle="Native form builder · .tmfm"
      mode="editor"
    >
      <div className={styles.embedded}>
        <FormsWorkspace />
      </div>
    </WorkspaceAppShell>
  );
}
