import { workspaceApps } from "@tamishra/workspace-core";

export function generateStaticParams() {
  return workspaceApps.map((app) => ({ app: app.id }));
}

export default async function AppFoundationPage({
  params
}: {
  params: Promise<{ app: string }>;
}) {
  const { app } = await params;
  const product = workspaceApps.find((item) => item.id === app);

  if (!product) {
    return <main className="modulePage"><h1>App not found</h1></main>;
  }

  return (
    <main className="modulePage">
      <a className="backLink" href="/">← Workspace</a>
      <div className={"moduleHero app-" + product.id}>
        <div className="appIcon">{product.shortName}</div>
        <p className="eyebrow">FOUNDATION MODULE</p>
        <h1>{product.name}</h1>
        <p>{product.description}</p>
        <div className="moduleStatus">Shell ready · editor features come next</div>
      </div>
    </main>
  );
}
