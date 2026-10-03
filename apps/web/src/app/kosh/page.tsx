import type { Metadata, Viewport } from "next";
import { KoshStandalone } from "./KoshStandalone";

export const metadata: Metadata = {
  title: "Kosh by Tamishra",
  description: "Kosh developer collaboration, repositories, automation and delivery.",
  manifest: "/kosh.webmanifest",
  applicationName: "Kosh",
  icons: {
    icon: "/kosh-icon.svg"
  },
  appleWebApp: {
    capable: true,
    title: "Kosh",
    statusBarStyle: "default"
  }
};

export const viewport: Viewport = {
  themeColor: "#102a43",
  colorScheme: "light dark"
};

export default function KoshStandalonePage() {
  return <KoshStandalone />;
}
