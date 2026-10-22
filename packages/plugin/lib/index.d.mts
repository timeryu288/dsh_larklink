import Schema from "@deepseek-ai/schemastery";
/** 结构等价于 cli 层 LarkRunner（dts 打包不透传子路径类型，故本地声明）。 */
interface LarkRunnerLike {
  (args: string[], opts?: {
    timeoutMs?: number;
    stdin?: string;
  }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
  }>;
}
declare const name = "@timeryu/dsh-larklink";
declare const inject: string[];
/** 运行时配置（cordis 校验并填充默认值）。 */
declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
  home: Schema<string, string, "defined">;
  execTimeoutMs: Schema<number, number, "defined">;
  probeTimeoutMs: Schema<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  home: Schema<string, string, "defined">;
  execTimeoutMs: Schema<number, number, "defined">;
  probeTimeoutMs: Schema<number, number, "defined">;
}>>, "plain">;
interface SkillService {
  register(def: {
    name: string;
    description: string;
    content: string;
    source: string;
  }): unknown;
}
interface PluginCtx {
  tools: {
    register(tool: unknown): unknown;
  };
  get(service: "skills"): SkillService | null;
  effect(fn: () => () => void): void;
}
interface LarklinkPluginOptions {
  /** 测试注入 mock runner。 */
  runner?: LarkRunnerLike;
}
declare function apply(ctx: PluginCtx, config?: {
  home?: string;
  execTimeoutMs?: number;
  probeTimeoutMs?: number;
}, options?: LarklinkPluginOptions): void;
export { Config, LarklinkPluginOptions, apply, inject, name };