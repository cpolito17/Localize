import { ACTION_LIMITS, positiveInt, type LimitedAction } from "./config";
import { HttpError, type WorkerEnv } from "./types";

const VISITOR_COOKIE = "localize_visitor";
const VISITOR_ID_RE = /^[A-Za-z0-9_-]{24,64}$/;
const textEncoder = new TextEncoder();

interface DailyRule {
  scope: string;
  subject: string;
  limit: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await importHmacKey(secret, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function importHmacKey(secret: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function verifyHmac(secret: string, value: string, signature: string): Promise<boolean> {
  const bytes = base64UrlToBytes(signature);
  if (!bytes) return false;
  const key = await importHmacKey(secret, ["verify"]);
  const signatureBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(signatureBuffer).set(bytes);
  return crypto.subtle.verify("HMAC", key, signatureBuffer, textEncoder.encode(value));
}

export function requireRateLimitSecret(env: WorkerEnv): string {
  const secret = env.RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(503, "The public demo safety controls are not configured.");
  }
  return secret;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export interface Visitor {
  id: string;
  subject: string;
  setCookie: string | null;
}

export async function visitorForRequest(request: Request, env: WorkerEnv): Promise<Visitor> {
  const secret = requireRateLimitSecret(env);
  const raw = cookieValue(request, VISITOR_COOKIE);
  if (raw) {
    const separator = raw.lastIndexOf(".");
    const id = separator > 0 ? raw.slice(0, separator) : "";
    const signature = separator > 0 ? raw.slice(separator + 1) : "";
    if (VISITOR_ID_RE.test(id)) {
      if (await verifyHmac(secret, `cookie:${id}`, signature)) {
        return {
          id,
          subject: (await hmac(secret, `visitor:${id}`)).slice(0, 32),
          setCookie: null,
        };
      }
    }
  }

  const random = new Uint8Array(24);
  crypto.getRandomValues(random);
  const id = bytesToBase64Url(random);
  const signature = await hmac(secret, `cookie:${id}`);
  return {
    id,
    subject: (await hmac(secret, `visitor:${id}`)).slice(0, 32),
    setCookie:
      `${VISITOR_COOKIE}=${id}.${signature}; Max-Age=31536000; Path=/localize; ` +
      "HttpOnly; Secure; SameSite=Lax",
  };
}

export async function ipSubject(request: Request, env: WorkerEnv): Promise<string> {
  const secret = requireRateLimitSecret(env);
  const rawIp = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  return (await hmac(secret, `ip:${rawIp}`)).slice(0, 32);
}

function secondsUntilUtcDayEnd(nowSeconds: number): number {
  return 86_400 - (nowSeconds % 86_400);
}

export class UsageLimiter {
  constructor(private readonly env: WorkerEnv) {}

  async consumeAction(action: LimitedAction, visitorSubject: string, ipHash: string): Promise<void> {
    const browserBurst = await this.env.BROWSER_RATE_LIMITER.limit({
      key: `${action}:${visitorSubject}`,
    });
    const ipBurst = await this.env.IP_RATE_LIMITER.limit({ key: `${action}:${ipHash}` });
    if (!browserBurst.success || !ipBurst.success) {
      throw new HttpError(429, "Too many requests. Please wait a minute and try again.", 60);
    }

    const defaults = ACTION_LIMITS[action];
    const browserDaily =
      action === "search"
        ? positiveInt(this.env.RATE_LIMIT_SEARCHES_PER_DAY, defaults.browserDaily)
        : defaults.browserDaily;
    const ipMultiplier = positiveInt(this.env.RATE_LIMIT_IP_MULTIPLIER, 4);
    const globalDaily =
      action === "search"
        ? positiveInt(this.env.RATE_LIMIT_GLOBAL_SEARCHES_PER_DAY, defaults.globalDaily)
        : defaults.globalDaily;

    await this.consumeDaily([
      { scope: `${action}:browser`, subject: visitorSubject, limit: browserDaily },
      { scope: `${action}:ip`, subject: ipHash, limit: browserDaily * ipMultiplier },
      { scope: `${action}:global`, subject: "global", limit: globalDaily },
    ]);
  }

  async consumeGoogleCall(): Promise<void> {
    const limit = positiveInt(this.env.GOOGLE_API_DAILY_LIMIT, 300);
    await this.consumeDaily([{ scope: "google-api", subject: "global", limit }]);
  }

  private async consumeDaily(rules: DailyRule[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 86_400);
    const values = rules.map(() => "(?, ?, ?, ?, 1)").join(", ");
    const bindings = rules.flatMap((rule) => [rule.scope, rule.subject, windowStart, rule.limit]);
    const result = await this.env.DB.prepare(
      `WITH rules(scope, subject, window_start, max_count, increment) AS (
         VALUES ${values}
       ), blocked AS (
         SELECT 1
         FROM rules
         JOIN usage_limits AS current
           ON current.scope = rules.scope
          AND current.subject = rules.subject
          AND current.window_start = rules.window_start
         WHERE current.count + rules.increment > rules.max_count
         LIMIT 1
       )
       INSERT INTO usage_limits(scope, subject, window_start, count)
       SELECT scope, subject, window_start, increment
       FROM rules
       WHERE NOT EXISTS (SELECT 1 FROM blocked)
       ON CONFLICT(scope, subject, window_start) DO UPDATE SET count = count + excluded.count
       RETURNING scope`
    )
      .bind(...bindings)
      .all<{ scope: string }>();

    if ((result.results?.length ?? 0) !== rules.length) {
      throw new HttpError(
        429,
        rules.some((rule) => rule.scope === "google-api")
          ? "Localize has reached today's Google API safety limit. Try again tomorrow."
          : "You've reached the public demo limit for this action. Please try again later.",
        secondsUntilUtcDayEnd(now)
      );
    }
  }
}

export async function hashForTest(secret: string, kind: string, value: string): Promise<string> {
  return (await hmac(secret, `${kind}:${value}`)).slice(0, 32);
}
