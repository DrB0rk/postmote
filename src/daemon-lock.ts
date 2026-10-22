import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export async function acquireDaemonLock(dataDir: string): Promise<() => Promise<void>> {
  const lockPath = join(dataDir, "daemon.lock");
  const identity = await processIdentity(process.pid);
  const contents = `${JSON.stringify({ pid: process.pid, identity })}\n`;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try { await handle.writeFile(contents); } finally { await handle.close(); }
      return async () => {
        try {
          if ((await readFile(lockPath, "utf8")) === contents) await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const staleContents = await readFile(lockPath, "utf8").catch((readError: NodeJS.ErrnoException) => {
        if (readError.code === "ENOENT") return null;
        throw readError;
      });
      if (staleContents === null) continue;
      let record: { pid: number; identity?: string };
      try {
        const parsed: unknown = JSON.parse(staleContents);
        if (!parsed || typeof parsed !== "object") throw new Error();
        record = parsed as { pid: number; identity?: string };
      } catch { throw new Error("Postmote daemon lock is invalid; inspect the data directory before removing it."); }
      const { pid } = record;
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Postmote daemon lock is invalid; inspect the data directory before removing it.");
      try {
        process.kill(pid, 0);
        const currentIdentity = await processIdentity(pid);
        if (record.identity === undefined || currentIdentity === undefined || currentIdentity === record.identity) {
          throw new Error(`Postmote is already running with PID ${pid}.`);
        }
      } catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code !== "ESRCH") throw signalError;
      }
      const current = await readFile(lockPath, "utf8").catch((readError: NodeJS.ErrnoException) => {
        if (readError.code === "ENOENT") return null;
        throw readError;
      });
      if (current === staleContents) await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
}

async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19];
    } catch { return undefined; }
  }
  if (process.platform !== "win32") {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString().trim() || undefined : undefined;
  }
  return undefined;
}
