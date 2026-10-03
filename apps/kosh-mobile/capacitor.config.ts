import type { CapacitorConfig } from "@capacitor/cli";

const appUrl = (process.env.KOSH_APP_URL ?? "https://kosh.tamishra.in/kosh").trim();

const config: CapacitorConfig = {
  appId: "in.tamishra.kosh",
  appName: "Kosh",
  webDir: "../web/out",
  server: {
    url: appUrl,
    androidScheme: "https",
    cleartext: appUrl.startsWith("http://")
  }
};

export default config;
