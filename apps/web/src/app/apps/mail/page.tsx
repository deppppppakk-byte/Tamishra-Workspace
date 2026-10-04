import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import { MailWorkspace } from "../../../components/mail/mail-workspace";
import styles from "./mail-workbench.module.css";

export const metadata = {
  title: "Tamishra Patra | Tamishra Workspace"
};

export default function MailPage() {
  return (
    <WorkspaceAppShell
      currentApp="mail"
      title="Patra"
      subtitle="Tamishra-native mail and mailbox workspace"
      mode="editor"
    >
      <div className={styles.embedded}>
        <MailWorkspace />
      </div>
    </WorkspaceAppShell>
  );
}
