import type { IncomingMessage, ServerResponse } from "node:http";
import { handleKoshBackupDownloadRequest } from "./kosh-backup-download-route.js";
import { handleKoshBackupStorageRequest } from "./kosh-backup-storage-routes.js";
import { handleKoshProductionRequest } from "./kosh-production-routes.js";
import { handleKoshStorageOrphanCleanupRequest } from "./kosh-storage-orphan-cleanup.js";
import { handleKoshStorageReconciliationRequest } from "./kosh-storage-reconciliation.js";
import { handleKoshSystemsRequest as handleCoreKoshSystemsRequest } from "./kosh-systems.js";

export async function handleKoshSystemsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (
    await handleKoshProductionRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshBackupDownloadRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshBackupStorageRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshStorageOrphanCleanupRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshStorageReconciliationRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  return handleCoreKoshSystemsRequest(
    request,
    response,
    url,
    origin,
    allowedOrigins
  );
}
