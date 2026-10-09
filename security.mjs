/**
 * security.mjs — protections for the local web API
 * ═══════════════════════════════════════════════════════════════════════════════
 * The MemVault server holds personal data and has no login, so its safety rests
 * on being reachable ONLY by software you run on your own machine. A web page you
 * happen to visit is also "software on your machine" as far as the network is
 * concerned, so these guards close the usual holes:
 *
 *   • Host check     — blocks DNS-rebinding (evil.example resolving to 127.0.0.1)
 *   • Origin check   — blocks cross-site requests (CSRF / drive-by reads & writes)
 *   • No open CORS   — no Access-Control-Allow-Origin unless you list the origin
 *   • Security headers + a strict Content-Security-Policy for the bundled UI
 *   • Attempt limiter — slows master-password guessing
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** "Host" header → lowercase hostname without the port ("[::1]:7799" → "[::1]"). */
export function hostnameFromHostHeader(host) {
  if (!host) return "";
  const h = String(host).toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

export function isLoopbackAddress(host) {
  return LOOPBACK_NAMES.has(String(host || "").toLowerCase()) || /^127\./.test(String(host || ""));
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // the bundled single-file UI uses inline script
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Express middleware factory.
 * @param {object} o
 * @param {string}   [o.bindHost]        address the server listens on
 * @param {string[]} [o.allowedHosts]    extra accepted Host header names
 * @param {string[]} [o.allowedOrigins]  extra browser origins allowed cross-origin
 */
export function createSecurityMiddleware({ bindHost, allowedHosts = [], allowedOrigins = [] } = {}) {
  const hostOk = new Set([...LOOPBACK_NAMES, ...allowedHosts.map((h) => h.toLowerCase())]);
  if (bindHost && !["0.0.0.0", "::", "[::]"].includes(bindHost)) hostOk.add(bindHost.toLowerCase());
  const originOk = new Set(allowedOrigins.map((o) => o.replace(/\/+$/, "").toLowerCase()));

  return function securityGuard(req, res, next) {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");

    const deny = (why) => res.status(403).json({ ok: false, error: why });

    if (!hostOk.has(hostnameFromHostHeader(req.headers.host))) {
      return deny("Forbidden: unrecognised Host header");
    }

    const origin = req.headers.origin;
    if (origin !== undefined) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
      } catch { /* "null" or malformed → not same-origin */ }

      const listed = originOk.has(String(origin).replace(/\/+$/, "").toLowerCase());
      if (!sameOrigin && !listed) return deny("Forbidden: cross-origin request blocked");

      if (listed && !sameOrigin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "content-type");
      }
    }

    // Defence in depth for browsers: state-changing requests must not be cross-site.
    const site = req.headers["sec-fetch-site"];
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && site === "cross-site") {
      const listed = origin !== undefined && originOk.has(String(origin).replace(/\/+$/, "").toLowerCase());
      if (!listed) return deny("Forbidden: cross-site request blocked");
    }

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

/**
 * Exponential back-off after repeated failures.
 * The first `freeAttempts` failures are free; each further failure doubles the
 * lockout (baseMs, 2×, 4×, … capped at maxMs). A success resets the counter.
 */
export function createAttemptLimiter({ freeAttempts = 5, baseMs = 1000, maxMs = 5 * 60_000, now = Date.now } = {}) {
  let failures = 0;
  let lockedUntil = 0;
  return {
    /** @returns {number} milliseconds the caller must wait (0 = go ahead) */
    retryAfterMs() {
      return Math.max(0, lockedUntil - now());
    },
    fail() {
      failures++;
      if (failures > freeAttempts) {
        lockedUntil = now() + Math.min(baseMs * 2 ** (failures - freeAttempts - 1), maxMs);
      }
    },
    succeed() {
      failures = 0;
      lockedUntil = 0;
    },
  };
}
