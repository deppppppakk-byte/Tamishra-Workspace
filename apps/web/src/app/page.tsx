import Link from "next/link";
import { AccountButton } from "../components/account-button";
import { MailWorkspace } from "../components/mail/mail-workspace";
import { workspaceApps } from "@tamishra/workspace-core";

const recentFiles = [
  { name: "Untitled document", type: "Docs", meta: "Edited just now" },
  { name: "Project tracker", type: "Sheets", meta: "Edited today" },
  { name: "Team presentation", type: "Slides", meta: "Edited yesterday" }
];

export default function HomePage() {
  if (process.env.NEXT_PUBLIC_WORKSPACE_SURFACE === "patra") {
    return <MailWorkspace />;
  }

  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">T</div>
          <div>
            <strong>Tamishra</strong>
            <span>Workspace</span>
          </div>
        </div>

        <button className="newButton">+ New</button>

        <nav className="nav">
          <Link className="active" href="/">Home</Link>
          <a href="#recent">Recent</a>
          <a href="#apps">Apps</a>
          <a href="#shared">Shared</a>
          <a href="#favorites">Favorites</a>
          <a href="#trash">Trash</a>
        </nav>

        <div className="storage">
          <span>Workspace storage</span>
          <div className="storageTrack"><div className="storageFill" /></div>
          <small>Local-first foundation</small>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className="searchWrap">
            <span className="searchIcon">⌕</span>
            <input aria-label="Search workspace" placeholder="Search files, messages, notes and apps" />
            <kbd>Ctrl K</kbd>
          </div>
          <div className="topActions">
            <button aria-label="Help">?</button>
            <button aria-label="Notifications">◦</button>
            <AccountButton />
          </div>
        </header>

        <section className="hero">
          <div>
            <p className="eyebrow">TAMISHRA WORKSPACE</p>
            <h1>Everything you create and communicate, in one place.</h1>
            <p className="heroText">
              A unified workspace for documents, data, presentations, files, chat,
              mail, meetings, notes and forms.
            </p>
          </div>
          <div className="heroActions">
            <button className="primaryAction">Create something</button>
            <button className="secondaryAction">Open a file</button>
          </div>
        </section>

        <section id="apps" className="section">
          <div className="sectionHeading">
            <div>
              <p className="eyebrow">APPS</p>
              <h2>Your workspace tools</h2>
            </div>
            <button className="textButton">Manage apps</button>
          </div>

          <div className="appGrid">
            {workspaceApps.map((app) => (
              <Link className={"appCard app-" + app.id} href={app.href} key={app.id}>
                <div className="appIcon">{app.shortName}</div>
                <div className="appCopy">
                  <strong>{app.name}</strong>
                  <p>{app.description}</p>
                </div>
                <span className="arrow">↗</span>
              </Link>
            ))}
          </div>
        </section>

        <section id="recent" className="section recentSection">
          <div className="sectionHeading">
            <div>
              <p className="eyebrow">RECENT</p>
              <h2>Continue working</h2>
            </div>
            <button className="textButton">View all</button>
          </div>

          <div className="recentGrid">
            {recentFiles.map((file) => (
              <article className="recentCard" key={file.name}>
                <div className="filePreview">
                  <span>{file.type.slice(0, 1)}</span>
                </div>
                <div className="fileMeta">
                  <strong>{file.name}</strong>
                  <span>{file.type} · {file.meta}</span>
                </div>
              </article>
            ))}
            <button className="recentCard addRecent">
              <span>+</span>
              <strong>Create new</strong>
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}
