import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import { ChatWorkspace } from "../../../components/chat/chat-workspace";
import styles from "./chat-workbench.module.css";

export const metadata = {
  title: "Tamishra Chat | Tamishra Workspace"
};

export default function ChatPage() {
  return (
    <WorkspaceAppShell
      currentApp="chat"
      title="Chat"
      subtitle="Workspace conversations and channels"
      mode="editor"
    >
      <div className={styles.embedded}>
        <ChatWorkspace />
      </div>
    </WorkspaceAppShell>
  );
}
