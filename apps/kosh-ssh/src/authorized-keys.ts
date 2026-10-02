#!/usr/bin/env node

const gatewayOrigin = (
  process.env.KOSH_GATEWAY_ORIGIN?.trim() ||
  "http://localhost:4100"
).replace(/\/$/, "");
const serviceToken = process.env.KOSH_SSH_SERVICE_TOKEN?.trim() || "";
const forcedShell =
  process.env.KOSH_SSH_SHELL_COMMAND?.trim() ||
  "/usr/local/bin/kosh-ssh-shell";

function fail(message: string, code = 1) {
  if (process.env.KOSH_SSH_DEBUG === "true") {
    process.stderr.write("Kosh SSH auth: " + message + "\n");
  }
  process.exitCode = code;
}

function validFingerprint(value: string) {
  return /^SHA256:[A-Za-z0-9+/]{20,100}$/.test(value);
}

function validExecutable(value: string) {
  return (
    value.startsWith("/") &&
    value.length <= 512 &&
    /^[A-Za-z0-9_./:+-]+$/.test(value)
  );
}

function validIdentifier(value: string) {
  return /^[A-Za-z0-9._:-]{1,240}$/.test(value);
}

async function main() {
  const fingerprint = String(process.argv[2] ?? "").trim();

  if (!serviceToken) {
    fail("KOSH_SSH_SERVICE_TOKEN is required.");
    return;
  }
  if (!validFingerprint(fingerprint)) {
    fail("Invalid SSH fingerprint.");
    return;
  }
  if (!validExecutable(forcedShell)) {
    fail("Invalid KOSH_SSH_SHELL_COMMAND.");
    return;
  }

  const response = await fetch(
    gatewayOrigin +
      "/v1/kosh/ssh/internal/authorized-key?fingerprint=" +
      encodeURIComponent(fingerprint),
    {
      headers: {
        "x-kosh-ssh-service-token": serviceToken,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(5000)
    }
  );

  if (!response.ok) {
    fail("Key not authorized.");
    return;
  }

  const payload = (await response.json()) as {
    key?: {
      id?: string;
      userId?: string;
      publicKey?: string;
      fingerprint?: string;
    };
  };

  const keyId = String(payload.key?.id ?? "");
  const userId = String(payload.key?.userId ?? "");
  const publicKey = String(payload.key?.publicKey ?? "").trim();

  if (
    !validIdentifier(keyId) ||
    !validIdentifier(userId) ||
    !publicKey ||
    publicKey.includes("\n") ||
    publicKey.includes("\r")
  ) {
    fail("Invalid key record.");
    return;
  }

  const options = [
    "no-agent-forwarding",
    "no-port-forwarding",
    "no-pty",
    "no-user-rc",
    "no-X11-forwarding",
    'command="' + forcedShell + " " + userId + " " + keyId + '"'
  ].join(",");

  process.stdout.write(options + " " + publicKey + "\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Authorization lookup failed.");
});
