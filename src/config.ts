import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  POSTMOTE_BIND: z.literal("127.0.0.1").default("127.0.0.1"),
  POSTMOTE_PORT: z.coerce.number().int().min(1).max(65535).default(3145),
  POSTMOTE_DATA_DIR: z.string().min(1).refine((value) => isAbsolute(value) || value.startsWith("~/"), "POSTMOTE_DATA_DIR must be an absolute path or start with ~/.").optional(),
  POSTMOTE_DEFAULT_POLL_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
  POSTMOTE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = {
  bind: "127.0.0.1";
  port: number;
  dataDir: string;
  pollSeconds: number;
  logLevel: "debug" | "info" | "warn" | "error";
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(source);
  const dataDir = parsed.POSTMOTE_DATA_DIR?.startsWith("~/")
    ? join(homedir(), parsed.POSTMOTE_DATA_DIR.slice(2))
    : parsed.POSTMOTE_DATA_DIR ?? defaultDataDir();
  return {
    bind: parsed.POSTMOTE_BIND,
    port: parsed.POSTMOTE_PORT,
    dataDir,
    pollSeconds: parsed.POSTMOTE_DEFAULT_POLL_SECONDS,
    logLevel: parsed.POSTMOTE_LOG_LEVEL,
  };
}

function defaultDataDir(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return join(local && isAbsolute(local) ? local : join(homedir(), "AppData", "Local"), "Postmote");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Postmote");
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share"), "postmote");
}
