import { readFile, writeFile } from "node:fs/promises";

const target = "apps/gateway/src/kosh.ts";
const source = await readFile(target, "utf8");

const before = `  if (!token) {
    return {
      canRead: repository.visibility === "public",
      canWrite: false,
      remoteUser: "",
      actor: { id: null as string | null, name: "Anonymous Git" }
    };
  }`;

const after = `  if (!token) {
    if ((process.env.KOSH_AUTH_MODE?.trim().toLowerCase() || "") === "none") {
      const identity = await resolveKoshIdentity(request);
      return {
        canRead: true,
        canWrite: true,
        remoteUser: identity?.user.email ?? "kosh-no-login-owner",
        actor: {
          id: identity?.user.id ?? "kosh-no-login-owner",
          name: identity?.user.displayName ?? "Kosh no-login owner"
        }
      };
    }

    return {
      canRead: repository.visibility === "public",
      canWrite: false,
      remoteUser: "",
      actor: { id: null as string | null, name: "Anonymous Git" }
    };
  }`;

if (source.includes(after)) {
  console.log("Kosh no-login Git access patch already applied.");
  process.exit(0);
}

if (!source.includes(before)) {
  throw new Error("Kosh Git access block changed; refusing an unsafe build-time patch.");
}

await writeFile(target, source.replace(before, after), "utf8");
console.log("Enabled Kosh Git read/write for KOSH_AUTH_MODE=none.");
