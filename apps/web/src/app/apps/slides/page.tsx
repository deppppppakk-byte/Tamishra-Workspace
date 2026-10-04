import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import SlidesEditorAdvanced from "./SlidesEditorAdvanced";
import styles from "./slides-workbench.module.css";

export const metadata = {
  title: "Tamishra Slides | Tamishra Workspace"
};

export default function SlidesPage() {
  return (
    <WorkspaceAppShell
      currentApp="slides"
      title="Slides"
      subtitle="Native presentation editor · .tmsl"
      mode="editor"
    >
      <div className={styles.embedded}>
        <SlidesEditorAdvanced />
      </div>
    </WorkspaceAppShell>
  );
}
