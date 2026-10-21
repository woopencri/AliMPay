import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface RuntimeEnv {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  uploadDir: string;
  publicBaseUrl: string;
  adminEntryPath: string | null;
  allowPrivateCallbacks: boolean;
  trustProxy: boolean;
  masterKey: Buffer;
}

function boolEnv(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

function decodeMasterKey(raw: string) {
  if (/^[a-f\d]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("APP_MASTER_KEY 必须是 32 字节 Base64 或 64 位十六进制，不能使用普通密码");
}

function loadMasterKey(dataDir: string) {
  const fromEnv = process.env.APP_MASTER_KEY?.trim();
  if (fromEnv) return decodeMasterKey(fromEnv);

  const keyPath = resolve(dataDir, ".master-key");
  if (existsSync(keyPath)) return decodeMasterKey(readFileSync(keyPath, "utf8").trim());

  const generated = randomBytes(32).toString("base64");
  try {
    writeFileSync(keyPath, `${generated}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return decodeMasterKey(readFileSync(keyPath, "utf8").trim());
    }
    throw error;
  }
  return Buffer.from(generated, "base64");
}

function loadAdminEntryPath(dataDir: string, nodeEnv: RuntimeEnv["nodeEnv"]) {
  const configured = process.env.ADMIN_ENTRY_PATH?.trim();
  const entryFile = resolve(dataDir, ".admin-entry-path");
  let entryPath = configured;
  if (!entryPath && nodeEnv !== "production") return null;
  if (!entryPath) {
    if (!existsSync(entryFile)) {
      try {
        writeFileSync(entryFile, `/admin-${randomBytes(24).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    entryPath = readFileSync(entryFile, "utf8").trim();
  }
  if (!/^\/[A-Za-z0-9_-]{16,128}$/.test(entryPath)) {
    throw new Error("ADMIN_ENTRY_PATH 必须以 / 开头，后接 16–128 位字母、数字、下划线或连字符");
  }
  return entryPath;
}

let cached: RuntimeEnv | undefined;

export function getRuntimeEnv(): RuntimeEnv {
  if (cached) return cached;
  const rawNodeEnv = process.env.NODE_ENV ?? "development";
  const nodeEnv: RuntimeEnv["nodeEnv"] = rawNodeEnv === "production" || rawNodeEnv === "test" ? rawNodeEnv : "development";
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const dataDir = resolve(process.env.DATA_DIR ?? "./data");
  const uploadDir = resolve(dataDir, "uploads");
  mkdirSync(uploadDir, { recursive: true });

  cached = {
    nodeEnv,
    host: process.env.HOST ?? "0.0.0.0",
    port: Number.isFinite(port) ? port : 3000,
    dataDir,
    databasePath: resolve(dataDir, "alimpay.sqlite"),
    uploadDir,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number.isFinite(port) ? port : 3000}`).replace(/\/$/, ""),
    adminEntryPath: loadAdminEntryPath(dataDir, nodeEnv),
    allowPrivateCallbacks: boolEnv(process.env.ALLOW_PRIVATE_CALLBACKS),
    trustProxy: boolEnv(process.env.TRUST_PROXY),
    masterKey: loadMasterKey(dataDir),
  };
  return cached;
}

export function resetRuntimeEnvForTests() {
  cached = undefined;
}
