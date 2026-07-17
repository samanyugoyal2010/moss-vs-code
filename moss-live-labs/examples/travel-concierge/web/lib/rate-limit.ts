type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 256;

/** Allowed explicit client-IP headers — set exactly one via TRUSTED_CLIENT_IP_HEADER. */
const TRUSTED_IP_HEADERS = new Set([
  "cf-connecting-ip",
  "x-vercel-forwarded-for",
  "x-real-ip",
]);

function evictExpired(now: number) {
  for (const [key, entry] of buckets) {
    if (now >= entry.resetAt) buckets.delete(key);
  }
}

/** Drop soonest-expiring entries until size <= maxSize. */
function evictOverflow(maxSize: number) {
  if (buckets.size <= maxSize) return;
  const ordered = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  const overflow = ordered.length - maxSize;
  for (let i = 0; i < overflow; i++) {
    buckets.delete(ordered[i][0]);
  }
}

/**
 * In-process rate limiter with TTL eviction.
 * Resets on process restart / across workers — pair with edge limits for public deploys.
 */
export function rateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  evictExpired(now);

  let entry = buckets.get(key);
  if (!entry || now >= entry.resetAt) {
    if (entry) buckets.delete(key);
    // Reserve a slot before inserting so size never exceeds MAX_BUCKETS.
    evictOverflow(MAX_BUCKETS - 1);
    entry = { count: 0, resetAt: now + windowMs };
    buckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

/**
 * Rate-limit identity from exactly one configured trusted header.
 *
 * Set TRUSTED_CLIENT_IP_HEADER to one of: cf-connecting-ip | x-vercel-forwarded-for | x-real-ip.
 * Reading multiple headers under a boolean flag is unsafe when a proxy only sanitizes its own
 * header and a higher-priority spoofed header is still accepted.
 * Unset / unknown → shared "global" bucket. Never trusts X-Forwarded-For.
 */
export function clientKey(request: Request): string {
  const configured = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!configured || !TRUSTED_IP_HEADERS.has(configured)) {
    return "global";
  }

  const raw = request.headers.get(configured)?.trim();
  if (!raw) return "global";

  // x-vercel-forwarded-for may be a short list; take the first platform-provided hop.
  const ip = configured === "x-vercel-forwarded-for" ? raw.split(",")[0]?.trim() : raw;
  return ip ? `ip:${ip}` : "global";
}
