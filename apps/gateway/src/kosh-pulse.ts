import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  buildKoshMeshGraph,
  calculateKoshMeshImpact
} from "./kosh-mesh.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import {
  getKoshPulseStore,
  type KoshPulseIncidentStatus,
  type KoshPulseSeverity
} from "./kosh-pulse-store.js";

const pulseStore = getKoshPulseStore();
const platformStore = getKoshPlatformStore();

type JsonBody = Record<string, unknown>;

type KoshPulseIdentity = NonNullable<
  Awaited<ReturnType<typeof resolveKoshIdentity>>
>;

type PulseSignal = {
  key: string;
  nodeRef: string;
  title: string;
  type: string;
  health: string;
  severity: KoshPulseSeverity;
  score: number;
  reason: string;
  downstreamCount: number;
  upstreamCount: number;
  downstreamFailed: number;
  downstreamBlocked: number;
  href: string;
  acknowledged: boolean;
  acknowledgementId: string | null;
  acknowledgementExpiresAt: string | null;
  incidentIds: string[];
};

const severities = new Set<KoshPulseSeverity>([
  "low",
  "medium",
  "high",
  "critical"
]);

const incidentStatuses = new Set<KoshPulseIncidentStatus>([
  "open",
  "investigating",
  "mitigating",
  "resolved"
]);

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins?.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  limit = 256 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function signalScore(
  health: string,
  downstreamCount: number,
  downstreamFailed: number,
  downstreamBlocked: number
) {
  const base =
    health === "failed"
      ? 78
      : health === "blocked"
        ? 62
        : health === "attention"
          ? 38
          : 0;

  const blastRadius = Math.min(18, downstreamCount * 3);
  const failedImpact = Math.min(12, downstreamFailed * 4);
  const blockedImpact = Math.min(8, downstreamBlocked * 2);
  return Math.min(100, base + blastRadius + failedImpact + blockedImpact);
}

function severityFromScore(score: number): KoshPulseSeverity {
  if (score >= 90) return "critical";
  if (score >= 68) return "high";
  if (score >= 38) return "medium";
  return "low";
}

function signalReason(
  health: string,
  downstreamCount: number,
  downstreamFailed: number,
  downstreamBlocked: number
) {
  const parts: string[] = [];
  if (health === "failed") {
    parts.push("This system is currently failed.");
  } else if (health === "blocked") {
    parts.push("This system is blocked by unresolved work or dependencies.");
  } else {
    parts.push("This system needs attention while work or execution is moving.");
  }

  if (downstreamCount > 0) {
    parts.push(
      downstreamCount +
        " downstream system" +
        (downstreamCount === 1 ? " may be affected." : "s may be affected.")
    );
  }
  if (downstreamFailed > 0) {
    parts.push(
      downstreamFailed +
        " downstream system" +
        (downstreamFailed === 1 ? " is also failed." : "s are also failed.")
    );
  }
  if (downstreamBlocked > 0) {
    parts.push(
      downstreamBlocked +
        " downstream system" +
        (downstreamBlocked === 1 ? " is blocked." : "s are blocked.")
    );
  }
  return parts.join(" ");
}

export async function buildKoshPulse(identity: KoshPulseIdentity) {
  await Promise.all([
    pulseStore.ready(),
    platformStore.ready()
  ]);

  const [mesh, allIncidents, allAcknowledgements] = await Promise.all([
    buildKoshMeshGraph(identity),
    pulseStore.listIncidents(),
    pulseStore.listAcknowledgements()
  ]);

  const visibleRefs = new Set(mesh.nodes.map((node) => node.ref));
  const incidents = allIncidents.filter((incident) =>
    visibleRefs.has(incident.targetRef)
  );
  const acknowledgements = allAcknowledgements.filter((acknowledgement) =>
    mesh.nodes.some((node) =>
      acknowledgement.signalKey.startsWith(node.ref + ":")
    )
  );

  const openIncidents = incidents.filter(
    (incident) => incident.status !== "resolved"
  );

  const ackBySignal = new Map(
    acknowledgements.map((acknowledgement) => [
      acknowledgement.signalKey,
      acknowledgement
    ])
  );

  const signals: PulseSignal[] = [];

  for (const node of mesh.nodes) {
    if (!["attention", "blocked", "failed"].includes(node.health)) continue;

    const impact = calculateKoshMeshImpact(mesh, node.ref);
    const downstreamCount = impact.downstream.length;
    const downstreamFailed = impact.downstream.filter(
      (item) => item.node.health === "failed"
    ).length;
    const downstreamBlocked = impact.downstream.filter(
      (item) => item.node.health === "blocked"
    ).length;
    const upstreamCount = impact.upstream.length;
    const score = signalScore(
      node.health,
      downstreamCount,
      downstreamFailed,
      downstreamBlocked
    );
    const key = node.ref + ":" + node.health;
    const acknowledgement = ackBySignal.get(key) ?? null;

    signals.push({
      key,
      nodeRef: node.ref,
      title: node.name,
      type: node.type,
      health: node.health,
      severity: severityFromScore(score),
      score,
      reason: signalReason(
        node.health,
        downstreamCount,
        downstreamFailed,
        downstreamBlocked
      ),
      downstreamCount,
      upstreamCount,
      downstreamFailed,
      downstreamBlocked,
      href: node.href,
      acknowledged: Boolean(acknowledgement),
      acknowledgementId: acknowledgement?.id ?? null,
      acknowledgementExpiresAt: acknowledgement?.expiresAt ?? null,
      incidentIds: openIncidents
        .filter((incident) => incident.targetRef === node.ref)
        .map((incident) => incident.id)
    });
  }

  signals.sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) {
      return a.acknowledged ? 1 : -1;
    }
    return b.score - a.score || a.title.localeCompare(b.title);
  });

  const activeSignals = signals.filter((signal) => !signal.acknowledged);
  const activeCritical = activeSignals.filter(
    (signal) => signal.severity === "critical"
  ).length;
  const activeHigh = activeSignals.filter(
    (signal) => signal.severity === "high"
  ).length;
  const activeMedium = activeSignals.filter(
    (signal) => signal.severity === "medium"
  ).length;
  const criticalIncidents = openIncidents.filter(
    (incident) => incident.severity === "critical"
  ).length;

  const state =
    activeCritical > 0 || criticalIncidents > 0
      ? "critical"
      : activeHigh > 0 || openIncidents.length > 0
        ? "degraded"
        : activeMedium > 0
          ? "watch"
          : "clear";

  return {
    state,
    generatedAt: new Date().toISOString(),
    mesh: {
      state: mesh.state,
      counts: mesh.counts
    },
    counts: {
      signals: signals.length,
      activeSignals: activeSignals.length,
      acknowledgedSignals: signals.length - activeSignals.length,
      critical: activeCritical,
      high: activeHigh,
      medium: activeMedium,
      incidents: incidents.length,
      openIncidents: openIncidents.length
    },
    signals,
    incidents,
    acknowledgements
  };
}

function routeError(
  response: ServerResponse,
  error: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
  sendJson(
    response,
    status,
    {
      error:
        error instanceof Error ? error.message : "kosh_pulse_error"
    },
    origin,
    allowedOrigins
  );
}

export async function handleKoshPulseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/kosh/pulse")) return false;

  const identity = await resolveKoshIdentity(
    request,
    request.method === "GET" ? "repo:read" : "repo:write"
  );
  if (!identity) {
    sendJson(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return true;
  }

  try {
    await pulseStore.ready();

    if (
      request.method === "GET" &&
      (url.pathname === "/v1/kosh/pulse" ||
        url.pathname === "/v1/kosh/pulse/summary")
    ) {
      sendJson(
        response,
        200,
        await buildKoshPulse(identity),
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/v1/kosh/pulse/incidents"
    ) {
      sendJson(
        response,
        200,
        { incidents: await pulseStore.listIncidents() },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/kosh/pulse/incidents"
    ) {
      const body = await readJson(request);
      const targetRef = clean(body.targetRef, 300);
      const title = clean(body.title, 240);
      const severity = clean(body.severity, 20) as KoshPulseSeverity;
      const status =
        clean(body.status, 30) as KoshPulseIncidentStatus || "open";

      const mesh = await buildKoshMeshGraph(identity);
      if (!mesh.nodes.some((node) => node.ref === targetRef)) {
        throw Object.assign(new Error("pulse_target_not_found"), {
          status: 404
        });
      }
      if (!title || !severities.has(severity) || !incidentStatuses.has(status)) {
        throw Object.assign(new Error("invalid_incident"), { status: 400 });
      }

      const incident = await pulseStore.createIncident({
        title,
        targetRef,
        severity,
        status,
        summary: clean(body.summary, 4000),
        ownerUserId: identity.user.id,
        ownerName: identity.user.displayName,
        createdByUserId: identity.user.id,
        createdByName: identity.user.displayName
      });

      await platformStore.appendAudit({
        repositoryId: null,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "pulse_incident_created",
        resourceType: "pulse_incident",
        resourceId: incident.id,
        metadata: {
          targetRef,
          severity,
          status
        }
      });

      sendJson(response, 201, incident, origin, allowedOrigins);
      return true;
    }

    const incidentMatch = url.pathname.match(
      /^\/v1\/kosh\/pulse\/incidents\/([^/]+)$/
    );
    if (incidentMatch && request.method === "PATCH") {
      const id = decodeURIComponent(incidentMatch[1]);
      const body = await readJson(request);
      const current = (await pulseStore.listIncidents()).find(
        (incident) => incident.id === id
      );
      if (!current) {
        throw Object.assign(new Error("pulse_incident_not_found"), {
          status: 404
        });
      }

      const nextSeverity =
        body.severity === undefined
          ? undefined
          : clean(body.severity, 20) as KoshPulseSeverity;
      const nextStatus =
        body.status === undefined
          ? undefined
          : clean(body.status, 30) as KoshPulseIncidentStatus;

      if (nextSeverity && !severities.has(nextSeverity)) {
        throw Object.assign(new Error("invalid_incident_severity"), {
          status: 400
        });
      }
      if (nextStatus && !incidentStatuses.has(nextStatus)) {
        throw Object.assign(new Error("invalid_incident_status"), {
          status: 400
        });
      }

      const updated = await pulseStore.updateIncident(id, {
        title:
          body.title === undefined
            ? undefined
            : clean(body.title, 240) || current.title,
        severity: nextSeverity,
        status: nextStatus,
        summary:
          body.summary === undefined
            ? undefined
            : clean(body.summary, 4000),
        ownerUserId:
          body.assignToSelf === true
            ? identity.user.id
            : body.clearOwner === true
              ? null
              : undefined,
        ownerName:
          body.assignToSelf === true
            ? identity.user.displayName
            : body.clearOwner === true
              ? null
              : undefined
      });

      await platformStore.appendAudit({
        repositoryId: null,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "pulse_incident_updated",
        resourceType: "pulse_incident",
        resourceId: id,
        metadata: {
          status: updated?.status,
          severity: updated?.severity
        }
      });

      sendJson(response, 200, updated, origin, allowedOrigins);
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/kosh/pulse/acknowledgements"
    ) {
      const body = await readJson(request);
      const signalKey = clean(body.signalKey, 500);
      const pulse = await buildKoshPulse(identity);
      if (!pulse.signals.some((signal) => signal.key === signalKey)) {
        throw Object.assign(new Error("pulse_signal_not_found"), {
          status: 404
        });
      }

      const ttlMinutes = Math.max(
        15,
        Math.min(10080, Number(body.ttlMinutes) || 240)
      );
      const expiresAt = new Date(
        Date.now() + ttlMinutes * 60_000
      ).toISOString();

      const acknowledgement = await pulseStore.acknowledge({
        signalKey,
        note: clean(body.note, 1000),
        acknowledgedByUserId: identity.user.id,
        acknowledgedByName: identity.user.displayName,
        expiresAt
      });

      await platformStore.appendAudit({
        repositoryId: null,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "pulse_signal_acknowledged",
        resourceType: "pulse_signal",
        resourceId: acknowledgement.id,
        metadata: {
          signalKey,
          expiresAt
        }
      });

      sendJson(
        response,
        201,
        acknowledgement,
        origin,
        allowedOrigins
      );
      return true;
    }

    const acknowledgementMatch = url.pathname.match(
      /^\/v1\/kosh\/pulse\/acknowledgements\/([^/]+)$/
    );
    if (acknowledgementMatch && request.method === "DELETE") {
      const id = decodeURIComponent(acknowledgementMatch[1]);
      const deleted = await pulseStore.deleteAcknowledgement(id);
      if (!deleted) {
        throw Object.assign(new Error("pulse_acknowledgement_not_found"), {
          status: 404
        });
      }
      sendJson(
        response,
        200,
        { deleted: true },
        origin,
        allowedOrigins
      );
      return true;
    }

    sendJson(
      response,
      404,
      { error: "kosh_pulse_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
