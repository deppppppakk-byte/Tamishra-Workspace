import type { NextConfig } from "next";

const workspaceBasePath = process.env.WORKSPACE_BASE_PATH ?? "/workspace";

const nextConfig: NextConfig = {
  output: "export",
  basePath: workspaceBasePath === "/" ? "" : workspaceBasePath,
  images: {
    unoptimized: true
  },
  transpilePackages: [
    "@tamishra/workspace-core",
    "@tamishra/blocks-core",
    "@tamishra/link-core",
    "@tamishra/chat-core",
    "@tamishra/document-model",
    "@tamishra/docs-engine",
    "@tamishra/history",
    "@tamishra/mail-core",
    "@tamishra/sheets-engine",
    "@tamishra/slides-core",
    "@tamishra/meet-core"
  ]
};

export default nextConfig;
