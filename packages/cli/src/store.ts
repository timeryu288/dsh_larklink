/**
 * registry 持久化：~/.larklink/registry.json（机器级，Q10-②）。
 * LARKLINK_HOME 环境变量可重定向（测试与多实例用）。
 * 并发写：文件锁（.lock，创建式）+ 原子替换（tmp + rename）。
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRegistry, validateRegistry } from "@timeryu288/larklink-core";
import type { Registry } from "@timeryu288/larklink-core";

export function larklinkHome(): string {
  return process.env["LARKLINK_HOME"]?.trim() || join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".", ".larklink");
}

export function registryPath(home = larklinkHome()): string {
  return join(home, "registry.json");
}

export function auditPath(home = larklinkHome()): string {
  return join(home, "audit.jsonl");
}

export async function loadRegistry(home = larklinkHome()): Promise<Registry> {
  const file = registryPath(home);
  if (!existsSync(file)) return createRegistry();
  const text = await readFile(file, "utf8");
  if (text.trim() === "") return createRegistry();
  const parsed = safeParse(text);
  if (parsed === null || typeof parsed !== "object" || (parsed as Registry).version !== 1) {
    throw new Error(`registry 文件损坏或版本不兼容：${file}（请人工检查备份后删除重建）`);
  }
  return parsed as Registry;
}

/** 保存并做结构校验（ADR-0001 appId 唯一等）；返回新 registry（引用不变性由调用方维护）。 */
export async function saveRegistry(registry: Registry, home = larklinkHome()): Promise<void> {
  const issues = validateRegistry(registry);
  if (issues.length > 0) {
    const fatal = issues.filter((i) => i.field.startsWith("bindings"));
    if (fatal.length > 0) {
      throw new Error(`registry 结构校验失败，拒绝写入：\n${issues.map((i) => ` - [${i.field}] ${i.message}`).join("\n")}`);
    }
  }
  const dir = home;
  await mkdir(dir, { recursive: true });
  await withLock(dir, async () => {
    const tmp = join(dir, `registry.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
    await rename(tmp, join(dir, "registry.json")); // 同目录 rename 原子替换
  });
}

const LOCK_FILE = "registry.lock";
const STALE_MS = 5_000;

async function withLock(dir: string, fn: () => Promise<void>): Promise<void> {
  const lockPath = join(dir, LOCK_FILE);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch {
      // 锁已存在：超过 5s 视为残留锁，拆除重试
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > STALE_MS) await rm(lockPath, { force: true });
      } catch {
        /* 锁恰好被释放 */
      }
      await sleep(50);
    }
  }
  if (handle === null) throw new Error(`registry 锁竞争超时：${lockPath}`);
  try {
    await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
