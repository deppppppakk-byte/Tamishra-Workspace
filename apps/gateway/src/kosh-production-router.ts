import type { IncomingMessage, ServerResponse } from "node:http";
import { handleKoshOperationsMetricsRequest } from "./kosh-operations-metrics.js";
import { handleKoshOpsFleetRequest } from "./kosh-ops-fleet.js";
import { handleKoshPagesDomainRequest } from "./kosh-pages-domains.js";
import { handleKoshProductionOperationsRequest } from "./kosh-production-operations.js";
import { handleKoshSecretRotationRequest } from "./kosh-secret-rotation.js";

export async function handleKoshProductionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (
    await handleKoshOperationsMetricsRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) return true;
  if (
    await handleKoshOpsFleetRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) return true;
  if (
    await handleKoshPagesDomainRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) return true;
  if (
    await handleKoshSecretRotationRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) return true;
  return handleKoshProductionOperationsRequest(
    request,
    response,
    url,
    origin,
    allowedOrigins
  );
}
