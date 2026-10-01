import type { Metadata } from "next";
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
      <body>{children}</body>
    </html>
  );
}
