import { normalizeMeetingCode } from "./index";

function normalizeOrigin(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Tamishra Meet origin is required.");
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export class TamishraMeetBridge {
  readonly origin: string;

  constructor(origin: string) {
    this.origin = normalizeOrigin(origin);
  }

  homeUrl(code?: string) {
    const normalized = normalizeMeetingCode(code ?? "");
    const url = new URL("/meet", this.origin);
    if (normalized) url.searchParams.set("code", normalized);
    return url.toString();
  }

  roomUrl(roomName: string) {
    const room = roomName.trim();
    if (!room) throw new Error("roomName is required.");
    return new URL("/meet/" + encodeURIComponent(room), this.origin).toString();
  }

  signInUrl(returnPath = "/meet") {
    const url = new URL("/sign-in", this.origin);
    url.searchParams.set("redirect_url", returnPath);
    return url.toString();
  }
}
