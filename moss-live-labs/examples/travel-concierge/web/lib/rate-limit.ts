type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 256;

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
 * Rate-limit identity. Spoofable forwarding headers are ignored unless TRUST_PROXY=1,
 * and even then we only use platform-set client IP headers — never the leftmost
 * X-Forwarded-For value (appending proxies like default Cloudflare/nginx leave that spoofable).
 */
export function clientKey(request: Request): string {
  if (process.env.TRUST_PROXY !== "1") {
    return "global";
  }

  // Cloudflare sets this to the connecting client; not a client-supplied XFF chain.
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return `ip:${cf}`;

  // Vercel overwrites / sets this for the request client.
  const vercel = request.headers.get("x-vercel-forwarded-for")?.trim().split(",")[0]?.trim();
  if (vercel) return `ip:${vercel}`;

  // Only safe when the proxy replaces X-Real-IP with the verified peer address.
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return `ip:${realIp}`;

  // No trusted client IP header — share one bucket rather than trust X-Forwarded-For.
  return "global";
}
