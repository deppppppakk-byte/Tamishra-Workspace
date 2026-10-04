import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import { MeetWorkspace } from "../../../components/meet/meet-workspace";
import styles from "./meet-workbench.module.css";

export const metadata = {
  title: "Tamishra Meet | Tamishra Workspace"
};

export default function MeetPage() {
  return (
    <WorkspaceAppShell
      currentApp="meet"
      title="Meet"
      subtitle="Private meetings, scheduling and attendance"
      mode="editor"
    >
      <div className={styles.embedded}>
        <MeetWorkspace />
      </div>
    </WorkspaceAppShell>
  );
}
