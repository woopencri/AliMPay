import type { Context, MiddlewareHandler } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { getRuntimeEnv } from "./env";
import { secureEqual, sha256 } from "./security";

export const ADMIN_ENTRY_COOKIE = "alimpay_admin_entry";
const ACCESS_SECONDS = 30 * 24 * 60 * 60;

export async function hasAdminEntryAccess(c: Context) {
  const runtime = getRuntimeEnv();
  if (!runtime.adminEntryPath) return true;
  const value = await getSignedCookie(c, runtime.masterKey.toString("hex"), ADMIN_ENTRY_COOKIE);
  if (!value) return false;
  const [expiry, entryHash] = value.split(":");
  const expiresAt = Number(expiry);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() &&
    secureEqual(entryHash ?? "", sha256(runtime.adminEntryPath));
}

export const adminEntryGuard: MiddlewareHandler = async (c, next) => {
  const runtime = getRuntimeEnv();
  if (!runtime.adminEntryPath) return next();

  if (c.req.path === runtime.adminEntryPath) {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-robots-tag", "noindex, nofollow, noarchive");
    if (c.req.method !== "GET") return c.text("Not Found", 404);
    await setSignedCookie(c, ADMIN_ENTRY_COOKIE,
      `${Date.now() + ACCESS_SECONDS * 1_000}:${sha256(runtime.adminEntryPath)}`, runtime.masterKey.toString("hex"), {
        httpOnly: true,
        secure: runtime.publicBaseUrl.startsWith("https://"),
        sameSite: "Lax",
        path: "/",
        maxAge: ACCESS_SECONDS,
      });
    return c.redirect("/", 303);
  }

  if (c.req.path === "/admin-api" || c.req.path.startsWith("/admin-api/")) {
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex, nofollow, noarchive");
    if (!await hasAdminEntryAccess(c)) return c.text("Not Found", 404);
  }
  return next();
};
