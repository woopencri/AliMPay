import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { ADMIN_ENTRY_COOKIE } from "../src/server/admin-entry";
import { PaymentScanner, type AccountLogProvider } from "../src/server/alipay";
import type { AppDatabase } from "../src/server/db";
import { getRuntimeEnv, resetRuntimeEnvForTests } from "../src/server/env";
import { createApp } from "../src/server/index";
import { NotificationWorker } from "../src/server/notifications";
import { md5Sign, rsaSign, sha256 } from "../src/server/security";
import { configuredDatabase } from "./helpers";

const entryPath = "/admin-test-0123456789abcdef";
const envKeys = ["ADMIN_ENTRY_PATH", "NODE_ENV", "DATA_DIR", "PUBLIC_BASE_URL"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const provider: AccountLogProvider = {
  async query() { return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "test" }; },
};
let database: AppDatabase | undefined;

beforeEach(() => {
  process.env.ADMIN_ENTRY_PATH = entryPath;
  resetRuntimeEnvForTests();
});
afterEach(() => {
  database?.close();
  database = undefined;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  resetRuntimeEnvForTests();
});

function fixture() {
  const configured = configuredDatabase();
  database = configured.database;
  const scanner = new PaymentScanner(database, provider);
  return { ...createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) }), configured };
}

async function signedAccessCookie(expiresAt: number) {
  const signer = new Hono();
  signer.get("/", async (c) => {
    await setSignedCookie(c, ADMIN_ENTRY_COOKIE,
      `${expiresAt}:${sha256(entryPath)}`, getRuntimeEnv().masterKey.toString("hex"));
    return c.text("ok");
  });
  return (await signer.request("/")).headers.get("set-cookie")!.split(";")[0]!;
}

describe("hidden admin entrance", () => {
  it("hides the root, admin pages, API and alternate HTML entry paths", async () => {
    const { app } = fixture();
    for (const route of ["/", "/index.html", "/login", "/setup", "/dashboard", "/settings", "/admin-api/setup/status", "/admin-api/me", "/unknown", "/assets/missing.js", "/assets/..%2findex.html"]) {
      const response = await app.request(route);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    }
    expect((await app.request("/", { method: "HEAD" })).status).toBe(404);
    expect((await app.request(entryPath, { method: "POST" })).status).toBe(404);
  });

  it("unlocks the browser with a private signed cookie and still requires admin login", async () => {
    process.env.PUBLIC_BASE_URL = "https://pay.example.com";
    const { app } = fixture();
    const entry = await app.request(entryPath);
    expect(entry.status).toBe(303);
    expect(entry.headers.get("location")).toBe("/");
    expect(entry.headers.get("cache-control")).toBe("no-store");
    expect(entry.headers.get("referrer-policy")).toBe("no-referrer");
    const setCookie = entry.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const headers = { cookie: setCookie.split(";")[0]! };
    expect((await app.request("/admin-api/setup/status", { headers })).status).toBe(200);
    expect((await app.request("/admin-api/me", { headers })).status).toBe(401);
    expect((await app.request("/admin-api/setup/status")).status).toBe(404);
  });

  it("rejects forged, expired and rotated entrance cookies", async () => {
    const { app } = fixture();
    const expired = await signedAccessCookie(Date.now() - 1_000);
    expect((await app.request("/admin-api/setup/status", { headers: { cookie: expired } })).status).toBe(404);
    const entry = await app.request(entryPath);
    const valid = entry.headers.get("set-cookie")!.split(";")[0]!;
    const forged = valid.replace("=", "=forged");
    expect((await app.request("/admin-api/setup/status", { headers: { cookie: forged } })).status).toBe(404);
    process.env.ADMIN_ENTRY_PATH = "/admin-rotated-0123456789abcdef";
    resetRuntimeEnvForTests();
    expect((await app.request("/admin-api/setup/status", { headers: { cookie: valid } })).status).toBe(404);
    expect((await app.request(entryPath)).status).toBe(404);
  });

  it("keeps V1/V2 ordering, checkout queries and health checks public", async () => {
    const { app, configured } = fixture();
    const unsigned = {
      pid: "1000000001", type: "alipay", out_trade_no: "ENTRY-V1",
      notify_url: "https://8.8.8.8/notify", name: "test", money: "1.00", clientip: "203.0.113.10", sign_type: "MD5",
    };
    const response = await app.request("/mapi.php", { method: "POST", body: new URLSearchParams({ ...unsigned, sign: md5Sign(unsigned, "1234567890abcdef1234567890abcdef") }) });
    expect((await response.json() as { code: number }).code).toBe(1);
    const order = database!.query("SELECT checkout_token FROM orders WHERE out_trade_no = 'ENTRY-V1'").get() as { checkout_token: string };
    const checkout = await app.request(`/public-api/checkout/${order.checkout_token}`);
    expect(checkout.status).toBe(200);
    expect((await checkout.json() as { payable_money: string }).payable_money).toBe("1.00");
    const v2 = { ...unsigned, out_trade_no: "ENTRY-V2", method: "web", sign_type: "RSA", timestamp: String(Math.floor(Date.now() / 1_000)) };
    const v2Response = await app.request("/api/pay/create", { method: "POST", body: new URLSearchParams({ ...v2, sign: rsaSign(v2, configured.merchant.privateKey) }) });
    expect((await v2Response.json() as { code: number }).code).toBe(0);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
  });

  it("generates and persists a private entrance in production", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "alimpay-admin-entry-"));
    try {
      delete process.env.ADMIN_ENTRY_PATH;
      process.env.NODE_ENV = "production";
      process.env.DATA_DIR = dataDir;
      resetRuntimeEnvForTests();
      const generated = getRuntimeEnv().adminEntryPath;
      if (!generated) throw new Error("Missing production entrance");
      expect(generated ?? "").toMatch(/^\/admin-[a-f0-9]{48}$/);
      expect(readFileSync(join(dataDir, ".admin-entry-path"), "utf8").trim()).toBe(generated);
      resetRuntimeEnvForTests();
      expect(getRuntimeEnv().adminEntryPath).toBe(generated);
    } finally {
      if (!resolve(dataDir).startsWith(resolve(tmpdir()) + sep + "alimpay-admin-entry-")) throw new Error("Unexpected test directory");
      rmSync(dataDir, { recursive: true });
    }
  });

  it("rejects invalid custom entrances", () => {
    for (const invalid of ["/short", "/admin/0123456789abcdef", "admin-0123456789abcdef"]) {
      process.env.ADMIN_ENTRY_PATH = invalid;
      resetRuntimeEnvForTests();
      expect(() => getRuntimeEnv()).toThrow(/ADMIN_ENTRY_PATH/);
    }
  });
});
