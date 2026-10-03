import type { IncomingMessage } from "node:http";

export function isKoshOperationGuardedRequest(request: IncomingMessage) {
  if (request.method !== "POST") return false;
  const pathname = new URL(request.url ?? "/", "http://kosh.local").pathname;
  return (
    /^\/v1\/kosh\/repos\/[^/]+\/[^/]+\/systems\/deployments\/requests\/[^/]+\/execute$/.test(pathname) ||
    /^\/v1\/kosh\/repos\/[^/]+\/[^/]+\/systems\/recovery\/backups\/[^/]+\/activate$/.test(pathname) ||
    /^\/v1\/kosh\/repos\/[^/]+\/[^/]+\/merge-queue\/process$/.test(pathname)
  );
}
