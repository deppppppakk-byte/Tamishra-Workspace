import type { IncomingMessage } from "node:http";

const DEFAULT_BASE_DOMAIN = "apps.tamishra.in";

function normalizeHost(value: string) {
  const first = value.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!first) return "";
  if (first.startsWith("[")) {
    const end = first.indexOf("]");
    return end >= 0 ? first.slice(1, end) : first;
  }
  return first.replace(/:\d+$/, "").replace(/\.$/, "");
}

function requestHost(request: IncomingMessage) {
  const forwarded = request.headers["x-forwarded-host"];
  const raw = Array.isArray(forwarded)
    ? forwarded[0] ?? ""
    : String(forwarded ?? request.headers.host ?? "");
  return normalizeHost(raw);
}

export function koshDeployBaseDomain() {
  const configured = process.env.KOSH_DEPLOY_BASE_DOMAIN?.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  return configured || DEFAULT_BASE_DOMAIN;
}

export function koshDeployDomainLabel(slug: string) {
  const value = slug.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) ? value : null;
}

export function koshDeployHostname(slug: string) {
  const label = koshDeployDomainLabel(slug);
  return label ? `${label}.${koshDeployBaseDomain()}` : null;
}

export function koshDeployPublicUrl(slug: string) {
  const hostname = koshDeployHostname(slug);
  if (!hostname) return null;
  const scheme = process.env.KOSH_DEPLOY_PUBLIC_SCHEME?.trim().toLowerCase() === "http" ? "http" : "https";
  return `${scheme}://${hostname}/`;
}

export function koshDeployDomainStatus() {
  const baseDomain = koshDeployBaseDomain();
  const edgeReady = process.env.KOSH_DEPLOY_EDGE_READY?.trim().toLowerCase() === "true";
  const tlsManaged = process.env.KOSH_DEPLOY_TLS_MANAGED?.trim().toLowerCase() === "true";
  return {
    baseDomain,
    wildcardHostname: `*.${baseDomain}`,
    edgeReady,
    tlsManaged,
    dnsReady: edgeReady,
    httpsReady: edgeReady && tlsManaged
  };
}

export function rewriteKoshDeployHost(request: IncomingMessage, url: URL) {
  const host = requestHost(request);
  const baseDomain = koshDeployBaseDomain();
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return url;

  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".") || !koshDeployDomainLabel(label)) return url;

  const rewritten = new URL(url.toString());
  const tail = url.pathname === "/" ? "/" : url.pathname;
  rewritten.pathname = `/v1/kosh/deploy/apps/${encodeURIComponent(label)}${tail}`;
  return rewritten;
}
