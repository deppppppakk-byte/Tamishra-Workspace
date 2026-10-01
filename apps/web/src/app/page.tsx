import { MailWorkspace } from "../components/mail/mail-workspace";
import { WorkspaceHomeClient } from "../components/workspace-home";

export default function HomePage() {
  if (process.env.NEXT_PUBLIC_WORKSPACE_SURFACE === "patra") {
    return <MailWorkspace />;
  }

  return <WorkspaceHomeClient />;
}
