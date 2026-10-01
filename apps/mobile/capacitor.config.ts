import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "in.tamishra.workspace",
  appName: "Tamishra Workspace",
  webDir: "../web/out",
  server: {
    androidScheme: "https"
  }
};

export default config;
