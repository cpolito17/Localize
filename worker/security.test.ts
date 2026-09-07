import { describe, expect, it } from "vitest";

import { positiveInt } from "./config";
import { validBounds } from "./index";
import type { WorkerEnv } from "./types";
import {
  hashForTest,
  ipSubject,
  requireRateLimitSecret,
  visitorForRequest,
} from "./usage";

const env = { RATE_LIMIT_SECRET: "s".repeat(48) } as WorkerEnv;

describe("configuration bounds", () => {
  it("accepts only positive integer overrides", () => {
    expect(positiveInt("12", 8)).toBe(12);
    expect(positiveInt("0", 8)).toBe(8);
    expect(positiveInt("1.5", 8)).toBe(8);
    expect(positiveInt(undefined, 8)).toBe(8);
  });

  it("rejects malformed or antimeridian-crossing bounds", () => {
    expect(validBounds({ north: 34.2, south: 33.9, east: -117.8, west: -118.4 })).toBe(true);
    expect(validBounds({ north: 34.2, south: 33.9, east: -117.8, west: -118.4, extra: 1 })).toBe(false);
    expect(validBounds({ north: 34.2, south: 33.9, east: -179, west: 179 })).toBe(false);
  });
});

describe("anonymous rate-limit identities", () => {
  it("requires a strong server-side secret", () => {
    expect(() => requireRateLimitSecret({ RATE_LIMIT_SECRET: "short" } as WorkerEnv)).toThrow();
    expect(requireRateLimitSecret(env)).toHaveLength(48);
  });

  it("hashes IPs deterministically without retaining the address", async () => {
    const request = new Request("https://charliepolito.com/localize/api/health", {
      headers: { "CF-Connecting-IP": "203.0.113.25" },
    });
    const subject = await ipSubject(request, env);
    expect(subject).toHaveLength(32);
    expect(subject).not.toContain("203.0.113.25");
    expect(subject).toBe(await hashForTest("s".repeat(48), "ip", "203.0.113.25"));
  });

  it("round-trips a signed HttpOnly visitor cookie and rejects tampering", async () => {
    const first = await visitorForRequest(
      new Request("https://charliepolito.com/localize/api/config"),
      env
    );
    expect(first.setCookie).toContain("HttpOnly; Secure; SameSite=Lax");
    const cookie = first.setCookie!.split(";", 1)[0];
    const second = await visitorForRequest(
      new Request("https://charliepolito.com/localize/api/config", {
        headers: { Cookie: cookie },
      }),
      env
    );
    expect(second.id).toBe(first.id);
    expect(second.subject).toBe(first.subject);
    expect(second.setCookie).toBeNull();

    const tampered = await visitorForRequest(
      new Request("https://charliepolito.com/localize/api/config", {
        headers: { Cookie: `${cookie}x` },
      }),
      env
    );
    expect(tampered.id).not.toBe(first.id);
    expect(tampered.setCookie).not.toBeNull();
  });
});
