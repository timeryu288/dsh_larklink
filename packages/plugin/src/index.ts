/**
 * @timeryu288/dsh-larklink —— DSH 插件入口（cordis 契约：name / inject / Config / apply）。
 * 工具注册 + 内嵌 SKILL 注册；所有命令走 CLI 层同一执行引擎（Q5-Q9 守卫全量生效）。
 */
import Schema from "@deepseek-ai/schemastery";
import { defaultLarkRunner } from "@timeryu288/larklink-cli/larkcli";
import { registerLarklinkTools, type LarkRunnerLike } from "./tools.js";
import { registerLarklinkRoutes } from "./routes.js";
import {
  LARKLINK_SKILL_DESCRIPTION,
  LARKLINK_SKILL_MARKDOWN,
  LARKLINK_SKILL_NAME,
} from "./skill-content.js";

export const name = "@timeryu288/dsh-larklink";
export const inject = ["tools"];

/** 运行时配置（cordis 校验并填充默认值）。 */
export const Config = Schema.object({
  home: Schema.string().default("").description("larklink 主目录覆盖（默认 ~/.larklink；测试/多实例用）。"),
  execTimeoutMs: Schema.number().default(120000).description("exec 默认超时（毫秒）；超时按 timeout-unknown 处理。"),
  probeTimeoutMs: Schema.number().default(8000).description("歧义候选只读探测超时（毫秒）。"),
});

interface SkillService {
  register(def: { name: string; description: string; content: string; source: string }): unknown;
}

interface PluginCtx {
  tools: { register(tool: unknown): unknown };
  get(service: "skills"): SkillService | null;
  effect(fn: () => () => void): void;
}

export interface LarklinkPluginOptions {
  /** 测试注入 mock runner。 */
  runner?: LarkRunnerLike;
}

export function apply(ctx: PluginCtx, config: { home?: string; execTimeoutMs?: number; probeTimeoutMs?: number } = {}, options: LarklinkPluginOptions = {}): void {
  const disposers: Array<() => void> = [];
  disposers.push(
    ...registerLarklinkTools({
      ctx: ctx as { tools: { register(tool: unknown): unknown } },
      runner: options.runner ?? defaultLarkRunner,
      config: {
        home: config.home || undefined,
        execTimeoutMs: config.execTimeoutMs,
        probeTimeoutMs: config.probeTimeoutMs,
      },
    }),
  );

  // 内嵌 SKILL（source: bundled，与 browser-skill 插件同法）
  const skills = ctx.get("skills");
  if (skills != null && typeof skills.register === "function") {
    const unregister = skills.register({
      name: LARKLINK_SKILL_NAME,
      description: LARKLINK_SKILL_DESCRIPTION,
      content: LARKLINK_SKILL_MARKDOWN,
      source: "bundled",
    });
    if (typeof unregister === "function") disposers.push(unregister as () => void);
  }

  // genui 面板后端路由（无 webServer 的组合里优雅降级）
  disposers.push(registerLarklinkRoutes({ ctx: ctx as never, runner: options.runner ?? defaultLarkRunner, home: config.home || undefined }));

  ctx.effect(() => () => {
    for (const dispose of [...disposers].reverse()) dispose();
  });
}
