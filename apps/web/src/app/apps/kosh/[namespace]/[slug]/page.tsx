import { RepositoryWorkspace } from "./RepositoryWorkspace";

export default async function KoshRepositoryPage({
  params
}: {
  params: Promise<{ namespace: string; slug: string }>;
}) {
  const { namespace, slug } = await params;
  return <RepositoryWorkspace namespace={namespace} slug={slug} />;
}
