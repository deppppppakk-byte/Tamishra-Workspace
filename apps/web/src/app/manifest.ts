import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tamishra Workspace",
    short_name: "Tamishra",
    description: "One workspace for documents, communication and collaboration.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f7fb",
    theme_color: "#315cf4"
  };
}
