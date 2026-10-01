import type { Metadata } from "next";
import { DesktopNativeOpenBridge } from "../components/desktop-native-open-bridge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tamishra Workspace",
  description: "One workspace for documents, communication and collaboration.",
  applicationName: "Tamishra Workspace"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <DesktopNativeOpenBridge />
        {children}
      </body>
    </html>
  );
}
