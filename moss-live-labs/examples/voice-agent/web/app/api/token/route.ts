import { NextResponse } from "next/server";
import { AccessToken, TrackSource, type VideoGrant } from "livekit-server-sdk";

// Copy web/.env.local.example to web/.env.local to get the `livekit-server --dev` defaults.
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const ALLOW_REMOTE_TOKEN = process.env.ALLOW_REMOTE_TOKEN === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

export const revalidate = 0;

function isLoopbackIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1"
  ) {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/**
 * Resolve the caller address. Never use Host / X-Forwarded-Host — those name the
 * virtual host and are trivially spoofable. Prefer the socket-derived peer via a
 * trusted proxy's forwarding headers, or deny when the peer cannot be verified.
 */
function peerIp(request: Request): string | null {
  if (!TRUST_PROXY) return null;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  const realIp = request.headers.get("x-real-ip");
  return realIp?.trim() || null;
}

function assertLocalDevOnly(request: Request): NextResponse | null {
  if (ALLOW_REMOTE_TOKEN) return null;

  // Host-header checks are intentionally not used here (spoofable).
  // Primary control: `next dev` / `next start` bind to 127.0.0.1 (see package.json).
  // Secondary: production builds always deny; with TRUST_PROXY, require loopback peer.
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Token endpoint is local-dev only", { status: 403 });
  }

  const ip = peerIp(request);
  if (ip !== null && !isLoopbackIp(ip)) {
    return new NextResponse("Token endpoint is local-dev only", { status: 403 });
  }

  return null;
}

// Local-dev demo: mint tokens only for loopback-bound servers unless explicitly opted in.
export async function GET(request: Request) {
  const denied = assertLocalDevOnly(request);
  if (denied) return denied;

  try {
    if (!LIVEKIT_URL) throw new Error("LIVEKIT_URL is not defined");
    if (!API_KEY) throw new Error("LIVEKIT_API_KEY is not defined");
    if (!API_SECRET) throw new Error("LIVEKIT_API_SECRET is not defined");

    // collision-resistant so concurrent visitors never share a room (and its audio / moss.retrieval data)
    const roomName = `support-demo-${crypto.randomUUID()}`;
    const identity = `user-${crypto.randomUUID()}`;

    const at = new AccessToken(API_KEY, API_SECRET, { identity, name: "You", ttl: "15m" });
    const grant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true, // publish mic
      canPublishSources: [TrackSource.MICROPHONE],
      canPublishData: true,
      canSubscribe: true,
    };
    at.addGrant(grant);

    return NextResponse.json(
      { serverUrl: LIVEKIT_URL, participantToken: await at.toJwt() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("token generation failed", error);
    return new NextResponse("Failed to generate token", { status: 500 });
  }
}
