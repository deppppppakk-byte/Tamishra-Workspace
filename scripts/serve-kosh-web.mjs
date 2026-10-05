import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, normalize, resolve, sep } from "node:path";

const port = Number(process.env.PORT ?? 3000);
const root = resolve(process.env.KOSH_WEB_ROOT ?? "apps/web/out");
const gatewayOrigin = (process.env.KOSH_GATEWAY_ORIGIN ?? "https://tamishra-workspace-api.onrender.com").replace(/\/$/, "");

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".webmanifest", "application/manifest+json"]
]);

function safeCandidate(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const cleaned = normalize(decoded).replace(/^([/\\])+/, "");
  const candidate = resolve(root, cleaned);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

function resolveFile(pathname) {
  const direct = safeCandidate(pathname);
  if (!direct) return null;
  const candidates = [direct, `${direct}.html`, join(direct, "index.html")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function gatewayPath(url) {
  if (url.pathname === "/api/workspace") return "/" + url.search;
  if (url.pathname.startsWith("/api/workspace/")) {
    return url.pathname.slice("/api/workspace".length) + url.search;
  }
  return url.pathname + url.search;
}

function shouldProxy(pathname) {
  return (
    pathname === "/api/workspace" ||
    pathname.startsWith("/api/workspace/") ||
    pathname.startsWith("/git/") ||
    pathname === "/v1/kosh" ||
    pathname.startsWith("/v1/kosh/") ||
    pathname.startsWith("/.well-known/")
  );
}

function proxyToGateway(request, response, url) {
  const target = new URL(gatewayPath(url), gatewayOrigin);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { ...request.headers };
  delete headers.host;
  headers["x-forwarded-host"] = request.headers.host ?? "kosh.tamishra.in";
  headers["x-forwarded-proto"] = "https";

  const upstream = transport(
    target,
    {
      method: request.method,
      headers,
      timeout: 120_000
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    }
  );

  upstream.on("timeout", () => upstream.destroy(new Error("gateway_timeout")));
  upstream.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify({ error: "kosh_gateway_unavailable" }));
  });

  request.pipe(upstream);
}

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://kosh.local");

    if (shouldProxy(url.pathname)) {
      proxyToGateway(request, response, url);
      return;
    }

    if (url.pathname === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({ service: "kosh-web", status: "ok", gateway: gatewayOrigin }));
      return;
    }

    if (url.pathname === "/") {
      response.writeHead(302, { location: "/kosh/", "cache-control": "no-store" });
      response.end();
      return;
    }

    const file = resolveFile(url.pathname);
    if (!file) {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end("Not found");
      return;
    }

    const extension = extname(file).toLowerCase();
    const immutable = url.pathname.startsWith("/_next/static/");
    response.writeHead(200, {
      "content-type": types.get(extension) ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate"
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(500, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end("Internal server error");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Kosh web server listening on :${port}; gateway=${gatewayOrigin}`);
});
