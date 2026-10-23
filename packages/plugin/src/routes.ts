/**
 * genui 面板后端路由（webServer 契约照 browser-skill 先例：exact 路径 + 原生 req/res）。
 * 列表/adopt/health/auth-start/auth-complete（split-flow 全程无密钥）；add/remove 仍只走终端（app secret 不经面板与模型）。
 */
import type { LarkRunnerLike } from "./tools.js";
import { cmdAdopt, cmdAuth, cmdList, type Emit } from "@timeryu288/larklink-cli/commands/bindings";

interface WebServerRoute {
  kind: "exact";
  path: string;
  handler: (req: HttpRequest, res: HttpResponse) => void;
}

interface HttpRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "end", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

interface HttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

interface WebServer {
  register(route: WebServerRoute): unknown;
}

export const ROUTE_BASE = "/larklink";

function sendJson(res: HttpResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 同源栅栏：origin/host 不一致或跨站 sec-fetch 拒绝（照 browser-skill fence 语义）。 */
function fenceViolation(req: HttpRequest): string | undefined {
  const origin = req.headers["origin"];
  if (typeof origin === "string" && origin !== "") {
    try {
      const o = new URL(origin);
      const host = req.headers["host"];
      if (o.host !== host) return "origin mismatch";
    } catch {
      return "bad origin";
    }
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return `cross-site ${site}`;
  return undefined;
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c.toString("utf8")));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function captureEmit(): { emit: Emit; payload: () => unknown } {
  let value: unknown;
  const emit: Emit = (p) => {
    value = p;
  };
  return { emit, payload: () => value };
}

function safeParseBody(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerLarklinkRoutes(deps: {
  ctx: { inject(services: string[], fn: (injected: { get(name: string): unknown }) => () => void): void };
  runner: LarkRunnerLike;
  home?: string;
}): () => void {
  const { ctx, runner, home } = deps;
  let disposed = false;
  const disposers: Array<() => void> = [];
  ctx.inject(["webServer"], (injected) => {
    const webServer = injected.get("webServer") as WebServer | null;
    if (webServer === null || typeof webServer.register !== "function") return () => {};
    if (disposed) return () => {};

    const route = (method: string, path: string, handler: (req: HttpRequest, res: HttpResponse) => Promise<void> | void): void => {
      const dispose = webServer.register({
        kind: "exact",
        path,
        handler: (req, res) => {
          const violation = fenceViolation(req);
          if (violation !== undefined) {
            sendJson(res, 403, { ok: false, error: `forbidden: ${violation}` });
            return;
          }
          if ((req.method ?? "GET") !== method) {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }
          void Promise.resolve(handler(req, res)).catch((e) => {
            sendJson(res, 500, { ok: false, error: (e as Error).message });
          });
        },
      });
      disposers.push(typeof dispose === "function" ? (dispose as () => void) : () => {});
    };

    route("GET", `${ROUTE_BASE}/bindings`, async (req, res) => {
      await readBody(req).catch(() => "");
      const live = new URL(req.url ?? "/", "http://localhost").searchParams.get("live") === "1";
      const cap = captureEmit();
      await cmdList({ runner, home }, { fast: !live, health: false }, cap.emit);
      sendJson(res, 200, cap.payload());
    });

    route("POST", `${ROUTE_BASE}/adopt`, async (req, res) => {
      await readBody(req);
      const cap = captureEmit();
      await cmdAdopt({ runner, home }, {}, cap.emit);
      sendJson(res, 200, cap.payload());
    });

    route("POST", `${ROUTE_BASE}/health`, async (req, res) => {
      await readBody(req);
      const cap = captureEmit();
      await cmdList({ runner, home }, { health: true }, cap.emit);
      sendJson(res, 200, cap.payload());
    });

    // auth-start / auth-complete：split-flow 授权（无密钥经手；浏览器自动打开）
    const authRoute = (complete: boolean) => async (req: HttpRequest, res: HttpResponse): Promise<void> => {
      const body = safeParseBody(await readBody(req).catch(() => ""));
      const profile = typeof body["profile"] === "string" ? body["profile"] : undefined;
      if (profile === undefined || profile === "") {
        sendJson(res, 400, { ok: false, error: "需要 JSON body { profile }" });
        return;
      }
      const cap = captureEmit();
      await cmdAuth({ runner, home }, { profile, complete, open: !complete }, cap.emit);
      sendJson(res, 200, cap.payload());
    };
    route("POST", `${ROUTE_BASE}/auth-start`, authRoute(false));
    route("POST", `${ROUTE_BASE}/auth-complete`, authRoute(true));

    return () => {
      for (const d of [...disposers].reverse()) d();
      disposers.length = 0;
    };
  });

  return () => {
    disposed = true;
    for (const d of [...disposers].reverse()) d();
    disposers.length = 0;
  };
}
