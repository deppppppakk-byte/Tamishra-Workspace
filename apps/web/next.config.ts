import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true
  },
  transpilePackages: [
    "@tamishra/workspace-core",
    "@tamishra/mail-core",
    "@tamishra/sheets-engine"
  ]
};

export default nextConfig;
