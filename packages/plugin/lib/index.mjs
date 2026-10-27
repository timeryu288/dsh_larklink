import Schema from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { access, appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
// \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
// ../cli/src/larkcli.ts
/**
* lark-cli 子进程封装。所有 spawn 只走这里——命令一律 argv 数组，绝不安字符串拼接
* （lark-shared 安全红线）。runner 以接口注入，测试用 mock 替换。
*/
/** 解析 lark-cli 可执行文件：env 覆盖 > PATH 上的原生 exe > npm 全局已知位置。Windows 只接受 .exe（shim 脚本无法被 spawn(shell:false) 执行）。 */
function resolveLarkCli() {
	const envOverride = process.env["LARKLINK_LARK_CLI"];
	if (envOverride && envOverride.trim() !== "") return envOverride;
	const isWin = process.platform === "win32";
	const candidates = [];
	const pathDirs = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d.trim() !== "");
	for (const dir of pathDirs) if (isWin) candidates.push(join(dir, "lark-cli.exe"));
	else candidates.push(join(dir, "lark-cli"));
	const home = process.env["USERPROFILE"] ?? process.env["HOME"];
	if (home) candidates.push(join(home, ".npm-global", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"));
	for (const c of candidates) try {
		if (existsSync(c)) return c;
	} catch {}
	throw new Error(`找不到可执行的 lark-cli${isWin ? "（Windows 需要 lark-cli.exe 原生二进制）" : ""}：请安装 lark-cli（npm i -g @larksuite/cli）或设置 LARKLINK_LARK_CLI 指向其原生可执行路径`);
}
/** 默认 runner：spawn 原生 exe，超时击杀并标记 timedOut（Q7：超时=结果未知）。 */
const defaultLarkRunner = (args, opts = {}) => {
	const bin = resolveLarkCli();
	const timeoutMs = opts.timeoutMs ?? 12e4;
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const child = spawn(bin, args, {
			shell: false,
			windowsHide: true,
			cwd: opts.cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		child.stdout.on("data", (d) => stdout += d.toString("utf8"));
		child.stderr.on("data", (d) => stderr += d.toString("utf8"));
		if (opts.stdin !== void 0) {
			child.stdin.write(opts.stdin);
			child.stdin.end();
		} else child.stdin.end();
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: timedOut ? -1 : code ?? -1,
				stdout,
				stderr,
				durationMs: Date.now() - started,
				timedOut
			});
		});
	});
};
/** lark-cli 输出信封解析：stdout JSON 优先，退回 stderr JSON（lark-shared：成功看 ok/exit 0，非 code==0）。 */
function parseEnvelope(result) {
	const out = safeJson(result.stdout);
	const err = safeJson(result.stderr);
	if (result.timedOut) return {
		ok: false,
		payload: out,
		error: {
			type: "timeout",
			message: "lark-cli 超时被击杀，服务端结果未知（Q7）"
		}
	};
	if (result.exitCode === 0 && out !== null) return {
		ok: true,
		payload: out,
		error: null
	};
	if (result.exitCode === 0) return {
		ok: true,
		payload: { raw: result.stdout },
		error: null
	};
	return {
		ok: false,
		payload: out,
		error: err ?? {
			type: "unknown",
			message: result.stderr || result.stdout || `exit ${result.exitCode}`
		}
	};
}
function safeJson(text) {
	const t = text.trim();
	if (t === "") return null;
	try {
		return JSON.parse(t);
	} catch {
		return null;
	}
}
// ../core/src/url.ts
/**
* 文档 URL / 裸 token 解析器（design.md §5 步骤 1-2）。
* 事实依据：lark-drive SKILL「文档 URL 格式与 Token 处理」表、lark-shared
* wiki-token-routing、lark-minutes/lark-slides/lark-drive-inspect 实例（2026-10-22 核对）。
*/
/** 路径前缀 → 资源类型。顺序无关（前缀互不冲突），但保持与设计文档一致的清单。 */
const PATH_RULES = [
	["/docx/", "docx"],
	["/doc/", "doc"],
	["/wiki/", "wiki"],
	["/sheets/", "sheets"],
	["/base/", "base"],
	["/slides/", "slides"],
	["/mindnotes/", "mindnotes"],
	["/whiteboard/", "whiteboard"],
	["/minutes/", "minutes"],
	["/drive/folder/", "folder"],
	["/page/", "apps"]
];
/**
* 裸 token 前缀 → 资源类型。仅收录有本地文档实例佐证的前缀；
* slides 为宽松前缀（实例既见 `slides…` 也见无前缀形态）。
*/
const TOKEN_RULES = [
	["doxcn", "docx"],
	["doccn", "doc"],
	["wikcn", "wiki"],
	["shtcn", "sheets"],
	["bascn", "base"],
	["fldcn", "folder"],
	["obcn", "minutes"],
	["slides", "slides"]
];
const WIKI_TYPES = /* @__PURE__ */ new Set(["wiki"]);
/** 域名 → 品牌证据。doubao.com 及一切未列域名 → "none"（Q3 决议：不做默认品牌猜测）。 */
const BRAND_DOMAIN_SUFFIXES = [
	["feishu.cn", "feishu"],
	["larksuite.com", "lark"],
	["larkoffice.com", "lark"]
];
function brandFromDomain(host) {
	for (const [suffix, brand] of BRAND_DOMAIN_SUFFIXES) if (host === suffix || host.endsWith(`.${suffix}`)) return brand;
	return "none";
}
function makeParsed(input, kind, domain, resourceType, token) {
	return {
		input,
		kind,
		domain,
		brand: domain ? brandFromDomain(domain) : "none",
		resourceType,
		token,
		wikiUnwrapNeeded: resourceType !== null && WIKI_TYPES.has(resourceType)
	};
}
const HOST_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}\//;
/**
* 解析用户粘贴的 URL 或裸 token。纯函数，不抛异常——识别失败以
* resourceType=null / token="" 表达，由 resolve 决定如何拒绝。
*/
function parseDoc(rawInput) {
	const input = rawInput.trim();
	if (input === "") return makeParsed(input, "token", null, null, "");
	let urlString = null;
	if (/:\/\//.test(input)) urlString = input;
	else if (HOST_PATH_RE.test(input)) urlString = `https://${input}`;
	if (urlString !== null) {
		let url;
		try {
			url = new URL(urlString);
		} catch {
			return makeParsed(input, "url", null, null, "");
		}
		const path = url.pathname;
		for (const [prefix, type] of PATH_RULES) {
			const idx = path.indexOf(prefix);
			if (idx === -1) continue;
			const token = path.slice(idx + prefix.length).split("/").find((seg) => seg !== "") ?? "";
			return makeParsed(input, "url", url.hostname.toLowerCase(), type, decodeURIComponent(token));
		}
		return makeParsed(input, "url", url.hostname.toLowerCase(), null, "");
	}
	for (const [prefix, type] of TOKEN_RULES) if (input.startsWith(prefix)) return makeParsed(input, "token", null, type, input);
	return makeParsed(input, "token", null, null, "");
}
// ../core/src/registry.ts
/** Registry 内存操作（纯函数；文件 IO/锁在 CLI 层，M2）。 */
function createRegistry() {
	return {
		version: 1,
		bindings: [],
		pins: []
	};
}
function findBinding(registry, profile) {
	return registry.bindings.find((b) => b.profile === profile);
}
/**
* 可路由绑定：排除 incomplete（Q8 决议）。
* brand 为具体品牌时按品牌过滤（design.md §5 步骤 3）；"none" 不过滤。
*/
function routableBindings(registry, brand) {
	return registry.bindings.filter((b) => b.status !== "incomplete" && (brand === "none" || b.brand === brand));
}
/** pin 以归一化 token 为键精确匹配（Q3/Q10：永久、无 TTL）。 */
function findPin(registry, token) {
	return registry.pins.find((p) => p.token === token);
}
function upsertPin(registry, pin) {
	const rest = registry.pins.filter((p) => p.token !== pin.token);
	return {
		...registry,
		pins: [...rest, pin]
	};
}
function upsertBinding(registry, binding) {
	const rest = registry.bindings.filter((b) => b.profile !== binding.profile);
	return {
		...registry,
		bindings: [...rest, binding]
	};
}
/** 结构校验：profile 唯一、appId 全局唯一（ADR-0001 不变量）、pin 指向存在的绑定。 */
function validateRegistry(registry) {
	const issues = [];
	const profiles = /* @__PURE__ */ new Set();
	const appIds = /* @__PURE__ */ new Map();
	for (const b of registry.bindings) {
		if (!b.profile) issues.push({
			field: "bindings[].profile",
			message: "profile 名为空"
		});
		if (profiles.has(b.profile)) issues.push({
			field: "bindings[].profile",
			message: `profile "${b.profile}" 重复`
		});
		profiles.add(b.profile);
		const existingOwner = appIds.get(b.appId);
		if (existingOwner !== void 0) issues.push({
			field: "bindings[].appId",
			message: `appId "${b.appId}" 同时被 "${existingOwner}" 与 "${b.profile}" 使用（ADR-0001：每个绑定独立应用）`
		});
		else appIds.set(b.appId, b.profile);
	}
	for (const p of registry.pins) if (!profiles.has(p.profile)) issues.push({
		field: "pins[].profile",
		message: `pin(token=${p.token.slice(0, 8)}…) 指向不存在的绑定 "${p.profile}"`
	});
	return issues;
}
// ../core/src/resolve.ts
var ResolveError = class extends Error {
	code;
	parsed;
	constructor(code, message, parsed) {
		super(message);
		this.name = "ResolveError";
		this.code = code;
		this.parsed = parsed;
	}
};
function toCandidate(b, domain) {
	return {
		profile: b.profile,
		brand: b.brand,
		status: b.status,
		tenantHintMatch: domain !== null && (b.tenantHints ?? []).includes(domain)
	};
}
function resolve(registry, input, opts = {}) {
	const parsed = parseDoc(input);
	if (parsed.resourceType === null || parsed.token === "") throw new ResolveError("unrecognized-input", `无法识别的文档输入：${JSON.stringify(input)}（支持 URL / doubao 同构链接 / 已知前缀的裸 token；纯描述不支持）`, parsed);
	if (parsed.resourceType === "apps") throw new ResolveError("unsupported-resource", "/page/ 链接是妙搭创意模式应用，不属于文档域（lark-apps SKILL），不在 larklink 操作范围", parsed);
	const named = opts.explicitProfile ?? opts.askedProfile;
	if (named !== void 0) {
		const binding = findBinding(registry, named);
		if (binding === void 0) throw new ResolveError("binding-not-found", `绑定 "${named}" 不存在`, parsed);
		if (binding.status === "incomplete") throw new ResolveError("binding-incomplete", `绑定 "${named}" 授权未完成，不可路由（Q8）`, parsed);
		if (parsed.brand !== "none" && parsed.brand !== binding.brand) throw new ResolveError("brand-mismatch", `显式指定绑定 "${named}" 品牌为 ${binding.brand}，与输入品牌证据 ${parsed.brand} 不符（Q5-②）`, parsed);
		const confidence = opts.askedProfile !== void 0 ? "asked" : "explicit";
		return {
			status: "resolved",
			parsed,
			profile: binding.profile,
			brand: binding.brand,
			confidence,
			bindingStatus: binding.status,
			reason: parsed.brand === "none" ? `用户显式指定（输入无品牌证据，选择同时确定品牌）` : `用户显式指定（品牌证据 ${parsed.brand} 校验通过）`
		};
	}
	const pin = findPin(registry, parsed.token);
	if (pin !== void 0) {
		const binding = findBinding(registry, pin.profile);
		if (binding !== void 0 && binding.status !== "incomplete") return {
			status: "resolved",
			parsed,
			profile: binding.profile,
			brand: binding.brand,
			confidence: "pinned",
			bindingStatus: binding.status,
			reason: `文档 pin 命中（记忆于 ${pin.updatedAt ?? "未知时间"}；失效不自动换绑定，Q1）`
		};
	}
	const candidates = routableBindings(registry, parsed.brand);
	if (candidates.length === 0) throw new ResolveError("no-routable-binding", `无可路由绑定（${parsed.brand === "none" ? "全部绑定" : `${parsed.brand} 品牌绑定`} 中没有可用绑定；incomplete 不可路由）。若本机已有 lark-cli profile，先 larklink_bindings(action=adopt) 导入为绑定；全新机器需先在终端 larklink bindings add（app secret 不经模型）。`, parsed);
	if (candidates.length === 1) {
		const sole = candidates[0];
		const repair = sole.status !== "ready" ? `；该绑定状态 ${sole.status}，需修复授权而非换绑定` : "";
		return {
			status: "resolved",
			parsed,
			profile: sole.profile,
			brand: sole.brand,
			confidence: "sole",
			bindingStatus: sole.status,
			reason: `品牌候选集内唯一绑定（存在性判定，不看登录状态，Q3-②）${repair}`
		};
	}
	return {
		status: "ambiguous",
		parsed,
		candidates: candidates.map((b) => toCandidate(b, parsed.domain)),
		reason: parsed.brand === "none" ? "输入无品牌证据且存在多个候选绑定，需用户选择（选择同时确定品牌并记为 pin，Q3-③）" : "同品牌多个候选绑定，需用户选择（选择记为 pin，Q1/Q3）"
	};
}
// ../core/src/index.ts
var src_exports = /* @__PURE__ */ __exportAll({ parseDoc: () => parseDoc });
// ../cli/src/store.ts
/**
* registry 持久化：~/.larklink/registry.json（机器级，Q10-②）。
* LARKLINK_HOME 环境变量可重定向（测试与多实例用）。
* 并发写：文件锁（.lock，创建式）+ 原子替换（tmp + rename）。
*/
function larklinkHome() {
	return process.env["LARKLINK_HOME"]?.trim() || join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".", ".larklink");
}
function registryPath(home = larklinkHome()) {
	return join(home, "registry.json");
}
function auditPath(home = larklinkHome()) {
	return join(home, "audit.jsonl");
}
async function loadRegistry(home = larklinkHome()) {
	const file = registryPath(home);
	if (!existsSync(file)) return createRegistry();
	const text = await readFile(file, "utf8");
	if (text.trim() === "") return createRegistry();
	const parsed = safeParse(text);
	if (parsed === null || typeof parsed !== "object" || parsed.version !== 1) throw new Error(`registry 文件损坏或版本不兼容：${file}（请人工检查备份后删除重建）`);
	return parsed;
}
/** 保存并做结构校验（ADR-0001 appId 唯一等）；返回新 registry（引用不变性由调用方维护）。 */
async function saveRegistry(registry, home = larklinkHome()) {
	const issues = validateRegistry(registry);
	if (issues.length > 0) {
		if (issues.filter((i) => i.field.startsWith("bindings")).length > 0) throw new Error(`registry 结构校验失败，拒绝写入：\n${issues.map((i) => ` - [${i.field}] ${i.message}`).join("\n")}`);
	}
	const dir = home;
	await mkdir(dir, { recursive: true });
	await withLock(dir, async () => {
		const tmp = join(dir, `registry.json.${process.pid}.tmp`);
		await writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
		await rename(tmp, join(dir, "registry.json"));
	});
}
const LOCK_FILE = "registry.lock";
const STALE_MS = 5e3;
async function withLock(dir, fn) {
	const lockPath = join(dir, LOCK_FILE);
	let handle = null;
	for (let attempt = 0; attempt < 60; attempt++) try {
		handle = await open(lockPath, "wx");
		break;
	} catch {
		try {
			const st = await stat(lockPath);
			if (Date.now() - st.mtimeMs > STALE_MS) await rm(lockPath, { force: true });
		} catch {}
		await sleep(50);
	}
	if (handle === null) throw new Error(`registry 锁竞争超时：${lockPath}`);
	try {
		await fn();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
// ../cli/src/audit.ts
/**
* 审计日志（Q10-③：默认脱敏）。每行一个 JSON：resolve/exec 的决策与结果摘要。
* 载荷参数（--content/--data 等）不记值，只记长度与 sha1；LARKLINK_AUDIT_VERBOSE=1 记全量。
*/
/** 值即文档内容/记录数据的参数（Q10-③ 脱敏对象）。 */
const PAYLOAD_FLAGS = [
	"--content",
	"--data",
	"--body",
	"--markdown",
	"--html",
	"--text",
	"--payload",
	"--blocks"
];
function redactValue(value) {
	const sha1 = createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
	return `<redacted len=${value.length} sha1=${sha1}>`;
}
function redactArgv(argv) {
	const out = [];
	let i = 0;
	const verbose = process.env["LARKLINK_AUDIT_VERBOSE"] === "1";
	while (i < argv.length) {
		const arg = argv[i];
		const eq = arg.indexOf("=");
		const bare = eq === -1 ? arg : arg.slice(0, eq);
		if (PAYLOAD_FLAGS.includes(bare)) {
			if (eq !== -1) {
				out.push(verbose ? arg : `${bare}=${redactValue(arg.slice(eq + 1))}`);
				i += 1;
			} else if (i + 1 < argv.length) {
				out.push(arg);
				out.push(verbose ? argv[i + 1] : redactValue(argv[i + 1]));
				i += 2;
			} else {
				out.push(arg);
				i += 1;
			}
		} else {
			out.push(arg);
			i += 1;
		}
	}
	return out;
}
/** 追加一条审计记录；审计关闭（LARKLINK_AUDIT=off）时静默跳过。 */
async function appendAudit(entry, home = larklinkHome()) {
	if (process.env["LARKLINK_AUDIT"] === "off") return;
	const record = {
		ts: (/* @__PURE__ */ new Date()).toISOString(),
		...entry
	};
	if (record.argv !== void 0) record.argv = redactArgv(record.argv);
	await mkdir(home, { recursive: true });
	await appendFile(auditPath(home), JSON.stringify(record) + "\n", "utf8");
}
// ../cli/src/commands/bindings.ts
/**
* bindings 生命周期命令（design.md §6，决议 Q8/Q10）。
* 所有 lark-cli 调用经注入的 runner，便于测试 mock。
*/
const stdEmit = (payload) => console.log(JSON.stringify(payload, null, 2));
/** lark-cli 状态字符串 → BindingStatus。无已登录用户 = incomplete（Q8：不可路由）。 */
function mapStatus(raw, hasUser) {
	const s = (raw ?? "").toLowerCase();
	if (!hasUser) return "incomplete";
	if (s.includes("refresh") || s.includes("expire")) return "needs_refresh";
	if (s.includes("unauthorized") || s.includes("revoked") || s.includes("invalid")) return "unauthorized";
	return "ready";
}
function bindingFromProfileList(e) {
	const profile = e.name;
	if (!profile || !e.brand || e.brand !== "feishu" && e.brand !== "lark") return null;
	const hasUser = e.user !== void 0 && e.user !== null && e.user !== "";
	return {
		profile,
		brand: e.brand,
		appId: (e.appId ?? e.app_id ?? "").toString(),
		userName: userNameOf(e.user),
		status: mapStatus(e.tokenStatus ?? e.token_status, hasUser),
		adopted: true,
		addedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
function userNameOf(user) {
	if (typeof user === "string") return user || void 0;
	return user?.name || void 0;
}
/** adopt：导入既有 lark-cli profile（不动原 profile，Q8-①）。 */
async function cmdAdopt(ctx, opts, emit = stdEmit) {
	const home = ctx.home ?? larklinkHome();
	const res = await ctx.runner(["profile", "list"], { timeoutMs: 2e4 });
	const payload = safeJson(res.stdout);
	const entries = Array.isArray(payload) ? payload : [];
	if (entries.length === 0) {
		emit({
			ok: false,
			code: "lark-cli-error",
			message: `profile list 无结果（exit ${res.exitCode}）：${res.stderr.slice(0, 300)}`
		});
		return 1;
	}
	const wanted = opts.profiles ? new Set(opts.profiles) : null;
	let registry = await loadRegistry(home);
	const adopted = [];
	const skipped = [];
	for (const e of entries) {
		const b = bindingFromProfileList(e);
		if (!b) {
			skipped.push(e.name ?? "(未知)");
			continue;
		}
		if (wanted && !wanted.has(b.profile)) continue;
		const existing = findBinding(registry, b.profile);
		registry = upsertBinding(registry, existing ? {
			...existing,
			...b,
			adopted: existing.adopted ?? b.adopted
		} : b);
		adopted.push(b.profile);
	}
	await saveRegistry(registry, home);
	await appendAudit({
		kind: "bindings",
		message: `adopt: ${adopted.join(", ") || "(none)"}`,
		profile: adopted.join(",")
	}, home);
	emit({
		ok: true,
		adopted,
		skipped,
		hint: skipped.length ? "跳过项为无 brand/用户的 profile" : void 0
	}, null, 2);
	return 0;
}
function pendingAuthPath(home) {
	return join(home, "pending-auth.json");
}
async function readPendingAuth(home) {
	try {
		const parsed = safeJson(await readFile(pendingAuthPath(home), "utf8"));
		if (parsed === null || typeof parsed !== "object" || !parsed.profile || !parsed.deviceCode) return null;
		return parsed;
	} catch {
		return null;
	}
}
async function writePendingAuth(home, flow) {
	await mkdir(home, { recursive: true });
	await writeFile(pendingAuthPath(home), JSON.stringify(flow, null, 2) + "\n", "utf8");
}
async function clearPendingAuth(home) {
	await rm(pendingAuthPath(home), { force: true });
}
/** 尽力打开系统浏览器（DSH 宿主运行在用户本机；失败不阻塞，envelope 里报告）。 */
function openInBrowser(url) {
	try {
		const cmd = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
		const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
		const child = spawn(cmd, args, {
			shell: false,
			stdio: "ignore",
			detached: true
		});
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
/**
* auth：split-flow 授权/恢复（Q8-②：中断后每次都发起新流程，绝不缓存授权码复用）。
* 全程无密钥经手——app secret 留在 lark-cli profile 里，lark-cli 官方 agent 契约本身就要求
* agent 展示 verification_url/二维码并自行执行 --device-code 收尾。
* - 发起：`auth login --domain <域> --no-wait --json` → verification_url + device_code + 二维码 →（默认）自动开浏览器 → 暂存待收尾
* - 收尾：`auth login --device-code <code>`（码取自参数或暂存）→ 同步绑定状态
*/
async function cmdAuth(ctx, opts, emit = stdEmit) {
	const home = ctx.home ?? larklinkHome();
	if (opts.complete === true || opts.deviceCode !== void 0) {
		let deviceCode = opts.deviceCode;
		let fromStash = false;
		if (deviceCode === void 0) {
			const pending = await readPendingAuth(home);
			if (pending === null) {
				emit({
					ok: false,
					code: "no-pending-auth",
					message: `没有进行中的授权流程（${pendingAuthPath(home)} 不存在）。先执行 auth-start 发起新流程。`
				});
				return 2;
			}
			if (pending.profile !== opts.profile) {
				emit({
					ok: false,
					code: "pending-auth-mismatch",
					message: `进行中的授权流程属于绑定 ${pending.profile}，与请求的 ${opts.profile} 不符。请先对 ${pending.profile} 收尾或重新发起。`
				});
				return 2;
			}
			if (Date.parse(pending.expiresAt) <= Date.now()) {
				await clearPendingAuth(home);
				emit({
					ok: false,
					code: "pending-auth-expired",
					message: `授权流程已过期（发起于 ${pending.startedAt}）。请重新 auth-start 发起全新流程（Q8-②：不缓存旧授权码）。`
				});
				return 2;
			}
			deviceCode = pending.deviceCode;
			fromStash = true;
		}
		const res = await ctx.runner([
			"--profile",
			opts.profile,
			"auth",
			"login",
			"--device-code",
			deviceCode,
			"--json"
		], { timeoutMs: 6e4 });
		if (res.exitCode !== 0) {
			emit({
				ok: false,
				code: "lark-cli-error",
				exitCode: res.exitCode,
				error: safeJson(res.stderr) ?? res.stderr.slice(0, 400),
				hint: "若用户尚未在浏览器完成授权，请等用户确认后重新 auth-complete（轮询重试）"
			});
			return 1;
		}
		if (fromStash) await clearPendingAuth(home);
		const health = await syncBindingStatus(ctx, home, opts.profile);
		await appendAudit({
			kind: "bindings",
			profile: opts.profile,
			message: `auth complete（status=${health.status ?? "?"}）`
		}, home);
		emit({
			ok: true,
			profile: opts.profile,
			status: health.status,
			userName: health.userName,
			warning: health.warning,
			next: health.status === "ready" ? "授权恢复，可继续原操作" : `状态仍为 ${health.status}，可能需要检查应用配置后重新授权`
		}, null, 2);
		return 0;
	}
	try {
		const pre = await syncBindingStatus(ctx, home, opts.profile);
		if (pre.status === "ready") {
			await clearPendingAuth(home);
			await appendAudit({
				kind: "bindings",
				profile: opts.profile,
				message: "auth start skipped（already-ready）"
			}, home);
			emit({
				ok: true,
				profile: opts.profile,
				status: "already-ready",
				userName: pre.userName,
				refreshExpiresAt: pre.refreshExpiresAt,
				message: `绑定 ${opts.profile} 授权当前有效，无需重新登录（已实时核验）`,
				next: "直接重试原操作即可（auth-start 未打开浏览器、未产生新流程）"
			}, null, 2);
			return 0;
		}
	} catch {}
	const inflight = await readPendingAuth(home);
	if (inflight !== null && inflight.profile === opts.profile) {
		if (Date.parse(inflight.expiresAt) > Date.now()) {
			let qrcode;
			const qrPath = join(home, `qrcode-${opts.profile}.png`);
			try {
				await access(qrPath);
				qrcode = qrPath;
			} catch {}
			await appendAudit({
				kind: "bindings",
				profile: opts.profile,
				message: "auth start reused（inflight）"
			}, home);
			emit({
				ok: true,
				profile: opts.profile,
				status: "auth-pending",
				verificationUrl: inflight.verificationUrl,
				qrcode,
				expiresAt: inflight.expiresAt,
				reusedExisting: true,
				message: `绑定 ${opts.profile} 已有进行中的授权流程（${inflight.startedAt} 发起，${inflight.expiresAt} 过期）——已复用，不再新建。请完成已打开的授权页面，而不是重新扫码。`,
				next: [
					"1. 用户在**已打开/已给出**的授权页完成确认（不要重复打开新页面）",
					"2. 用户确认后调用 auth-complete（device_code 已暂存）",
					"3. 若该流程已过期，再调用 auth-start 发起全新流程（会自动清理旧流程）"
				].join("\n")
			}, null, 2);
			return 0;
		}
		await clearPendingAuth(home);
	}
	const domain = opts.domain ?? "docs";
	const res = await ctx.runner([
		"--profile",
		opts.profile,
		"auth",
		"login",
		"--domain",
		domain,
		"--no-wait",
		"--json"
	], { timeoutMs: 3e4 });
	const payload = safeJson(res.stdout);
	const errPayload = safeJson(res.stderr);
	if (res.exitCode !== 0 || payload === null) {
		emit({
			ok: false,
			code: "lark-cli-error",
			exitCode: res.exitCode,
			error: errPayload ?? res.stderr.slice(0, 400)
		});
		return 1;
	}
	const url = payload["verification_url"] ?? payload["url"];
	const deviceCode = payload["device_code"] ?? payload["deviceCode"];
	if (!url) {
		emit({
			ok: false,
			code: "no-verification-url",
			message: "lark-cli 未返回 verification_url",
			payload
		});
		return 1;
	}
	const expiresInSec = typeof payload["expires_in"] === "number" ? payload["expires_in"] : 600;
	let qrcode;
	try {
		await mkdir(home, { recursive: true });
		const qrName = `qrcode-${opts.profile}.png`;
		if ((await ctx.runner([
			"auth",
			"qrcode",
			url,
			"--output",
			qrName
		], {
			timeoutMs: 15e3,
			cwd: home
		})).exitCode === 0) qrcode = join(home, qrName);
	} catch {}
	const flow = {
		profile: opts.profile,
		deviceCode: deviceCode ?? "",
		verificationUrl: url,
		startedAt: (/* @__PURE__ */ new Date()).toISOString(),
		expiresAt: new Date(Date.now() + expiresInSec * 1e3).toISOString()
	};
	if (deviceCode !== void 0) await writePendingAuth(home, flow);
	const browserOpened = opts.open !== false ? openInBrowser(url) : false;
	await appendAudit({
		kind: "bindings",
		profile: opts.profile,
		message: `auth start（domain=${domain}，expiresIn=${expiresInSec}s）`
	}, home);
	emit({
		ok: true,
		profile: opts.profile,
		status: "auth-started",
		verificationUrl: url,
		qrcode,
		expiresInSeconds: expiresInSec,
		browserOpened,
		next: [
			"1. 让用户在浏览器（已自动打开；未打开则手动访问 verificationUrl 或扫码二维码）完成授权确认",
			"2. 用户确认后调用 auth-complete（device_code 已暂存，无需携带）",
			"3. 授权 URL 10 分钟内有效，过期须重新 auth-start（Q8-②）"
		].join("\n")
	}, null, 2);
	return 0;
}
/**
* 用真实 `auth status --json --verify` 结构同步（identities.user.{userName,tokenStatus,refreshExpiresAt}）。
* 无 user 身份 → incomplete（绑定=app+user，bot-only 不可作用户身份路由）。
*/
async function syncBindingStatus(ctx, home, profile) {
	const user = safeJson((await ctx.runner([
		"--profile",
		profile,
		"auth",
		"status",
		"--json",
		"--verify"
	], { timeoutMs: 2e4 })).stdout)?.identities?.user;
	if (user === void 0) {
		await setBindingStatus(home, profile, "incomplete");
		return {
			status: "incomplete",
			warning: `绑定 ${profile} 无 user 身份（bot-only）→ incomplete，不可路由`
		};
	}
	const status = mapStatus(user.tokenStatus ?? user.status, true);
	const refreshExpiresAt = user.refreshExpiresAt;
	let warning;
	if (refreshExpiresAt !== void 0) {
		const expiry = Date.parse(refreshExpiresAt);
		if (!Number.isNaN(expiry)) {
			const hoursLeft = (expiry - Date.now()) / 36e5;
			if (hoursLeft < 0) warning = `绑定 ${profile} refresh token 已过期，需重新授权`;
			else if (hoursLeft < 48) warning = `绑定 ${profile} refresh token ${hoursLeft.toFixed(1)}h 后过期，建议尽快重新授权`;
		}
	}
	let registry = await loadRegistry(home);
	const existing = findBinding(registry, profile);
	if (existing) {
		registry = upsertBinding(registry, {
			...existing,
			status,
			userName: user.userName ?? existing.userName,
			openId: user.openId ?? existing.openId
		});
		await saveRegistry(registry, home);
	}
	return {
		status,
		userName: user.userName,
		openId: user.openId,
		refreshExpiresAt,
		warning
	};
}
async function setBindingStatus(home, profile, status) {
	let registry = await loadRegistry(home);
	const existing = findBinding(registry, profile);
	if (!existing) return false;
	registry = upsertBinding(registry, {
		...existing,
		status
	});
	await saveRegistry(registry, home);
	return true;
}
/** list / health：同步各绑定真实状态；health 额外清理死 pin（Q10-①）。 */
async function cmdList(ctx, opts, emit = stdEmit) {
	const home = ctx.home ?? larklinkHome();
	let registry = await loadRegistry(home);
	const warnings = [];
	/** 实时核验结果（openId / refreshExpiresAt 不落 registry，仅随本次信封透出）。 */
	const liveInfo = /* @__PURE__ */ new Map();
	if (!opts.fast) {
		for (const b of registry.bindings) try {
			const s = await syncBindingStatus(ctx, home, b.profile);
			if (s.warning) warnings.push(s.warning);
			if (s.openId !== void 0 || s.refreshExpiresAt !== void 0) liveInfo.set(b.profile, {
				openId: s.openId,
				refreshExpiresAt: s.refreshExpiresAt
			});
			if (opts.health && s.status && s.status !== "ready" && s.status !== "incomplete") warnings.push(`绑定 ${b.profile} 状态 ${s.status}：调用 larklink_bindings(action=auth-start, profile=${b.profile}) 发起登录修复`);
		} catch (e) {
			warnings.push(`绑定 ${b.profile} 状态同步失败：${e.message}`);
		}
		registry = await loadRegistry(home);
	}
	if (opts.health) {
		const profiles = new Set(registry.bindings.map((b) => b.profile));
		const dead = registry.pins.filter((p) => !profiles.has(p.profile));
		if (dead.length > 0) {
			for (const d of dead) registry = {
				...registry,
				pins: registry.pins.filter((p) => p.token !== d.token)
			};
			await saveRegistry(registry, home);
			warnings.push(`清理死 pin ${dead.length} 条`);
		}
	}
	emit({
		ok: true,
		bindings: registry.bindings.map((b) => ({
			profile: b.profile,
			brand: b.brand,
			appId: b.appId,
			userName: b.userName,
			openId: liveInfo.get(b.profile)?.openId ?? b.openId,
			refreshExpiresAt: liveInfo.get(b.profile)?.refreshExpiresAt,
			status: b.status,
			adopted: b.adopted ?? false
		})),
		pins: registry.pins,
		warnings
	}, null, 2);
	return 0;
}
/** pin：手动增删查（兜底入口）。 */
async function cmdPin(opts, home = larklinkHome(), emit = stdEmit) {
	const registry = await loadRegistry(home);
	if (opts.op === "list") {
		emit({
			ok: true,
			pins: registry.pins
		}, null, 2);
		return 0;
	}
	if (!opts.token || opts.op === "add" && !opts.profile) {
		emit({
			ok: false,
			code: "usage",
			message: "pin add 需要 --token 与 --profile；remove 只需 --token"
		});
		return 2;
	}
	if (opts.op === "add") {
		const token = opts.token;
		const profile = opts.profile;
		if (!token || !profile) {
			emit({
				ok: false,
				code: "usage",
				message: "pin add 需要 --token 与 --profile"
			});
			return 2;
		}
		if (!findBinding(registry, profile)) {
			emit({
				ok: false,
				code: "binding-not-found",
				message: `绑定 ${profile} 不存在`
			});
			return 2;
		}
		await saveRegistry(upsertPin(registry, {
			token,
			profile,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		}), home);
		emit({
			ok: true,
			pinned: token,
			profile
		});
		return 0;
	}
	await saveRegistry({
		...registry,
		pins: registry.pins.filter((p) => p.token !== opts.token)
	}, home);
	emit({
		ok: true,
		removed: opts.token && findPin(registry, opts.token) ? opts.token : null
	});
	return 0;
}
// ../cli/src/commands/resolve.ts
/**
* resolve 命令：core 消歧 + Q4 只读探测（标注不代选）+ pin 写入。
*/
/** 只读探测（Q4：8s 超时，真实 API 调用会留租户审计痕迹；永不影响选择）。 */
function classifyProbe(result) {
	if (result.timedOut) return "timeout";
	if (result.exitCode === 0) return "accessible";
	const raw = safeJson(result.stderr) ?? safeJson(result.stdout);
	const err = raw?.error ?? raw;
	const text = `${err?.type ?? ""} ${err?.message ?? ""} ${result.stderr}`.toLowerCase();
	if (err?.code === 403 || text.includes("permission") || text.includes("forbidden")) return "no-permission";
	if (text.includes("auth") || text.includes("token") || text.includes("login")) return "auth-failed";
	return "error";
}
async function probeCandidate(runner, input, profile, timeoutMs = 8e3) {
	return classifyProbe(await runner([
		"--profile",
		profile,
		"drive",
		"+inspect",
		"--url",
		input,
		"--json"
	], { timeoutMs }));
}
async function cmdResolve(runner, opts, home = larklinkHome(), emit = stdEmit) {
	let registry = await loadRegistry(home);
	const result = resolve(registry, opts.input, {
		explicitProfile: opts.explicitProfile,
		askedProfile: opts.askedProfile
	});
	if (result.status === "ambiguous") {
		let candidates = result.candidates;
		if (opts.probe !== false) candidates = await Promise.all(result.candidates.map(async (c) => {
			try {
				return {
					...c,
					probe: await probeCandidate(runner, opts.input, c.profile, opts.probeTimeoutMs)
				};
			} catch {
				return {
					...c,
					probe: "error"
				};
			}
		}));
		await appendAudit({
			kind: "resolve",
			outcome: "ambiguous",
			confidence: "none",
			target: result.parsed.token,
			argv: [opts.input],
			message: `候选：${candidates.map((c) => c.profile).join(", ")}`
		}, home);
		emit({
			ok: true,
			status: "ambiguous",
			parsed: result.parsed,
			candidates,
			reason: result.reason,
			next: `询问用户后：larklink resolve <input> --asked <profile> --pin`
		}, null, 2);
		return 3;
	}
	if (opts.pin && (result.confidence === "asked" || result.confidence === "explicit")) {
		registry = upsertPin(registry, {
			token: result.parsed.token,
			profile: result.profile,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		await saveRegistry(registry, home);
	}
	await appendAudit({
		kind: "resolve",
		outcome: "resolved",
		confidence: result.confidence,
		profile: result.profile,
		target: result.parsed.token,
		argv: [opts.input]
	}, home);
	emit({
		ok: true,
		status: "resolved",
		profile: result.profile,
		brand: result.brand,
		confidence: result.confidence,
		bindingStatus: result.bindingStatus,
		reason: result.reason,
		parsed: result.parsed,
		wikiUnwrapNeeded: result.parsed.wikiUnwrapNeeded,
		pinned: opts.pin === true
	}, null, 2);
	return 0;
}
// ../cli/src/execguard.ts
/**
* exec 守卫链（决议 Q5/Q6/Q7/Q9 落地）：
*  - Q9：命令域白名单（文档域）
*  - Q6：执行身份只能来自工具参数 as；argv 夹带 --as 一律拒绝
*  - Q5：argv 提取目标与路由结果比对，不一致即拒；未识别形态放行（fail-open）
*  - Q6-②：confirmationId = profile+as+argv 指纹；--yes 重试必须携带一致指纹
*/
/** Q9-①：v1 仅文档域。 */
const EXEC_DOMAINS = /* @__PURE__ */ new Set([
	"docs",
	"drive",
	"sheets",
	"markdown",
	"slides",
	"base",
	"whiteboard",
	"wiki",
	"mindnotes"
]);
/** Q5-①：从 argv 提取目标文档的白名单旗标（fail-open：未收录旗标不比对）。 */
const TARGET_FLAGS = [
	"--doc",
	"--url",
	"--file",
	"--token"
];
function domainOf(argv) {
	return (argv[0] ?? "").replace(/^:+/, "");
}
/** argv 中出现 --as / --as=... → 拒绝（显式声明唯一入口是工具参数 as）。 */
function findArgvAs(argv) {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--as") return {
			value: argv[i + 1] ?? "",
			index: i
		};
		if (a.startsWith("--as=")) return {
			value: a.slice(5),
			index: i
		};
	}
	return null;
}
function extractTargets(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const bare = eq === -1 ? a : a.slice(0, eq);
		if (TARGET_FLAGS.includes(bare)) {
			if (eq !== -1) out.push({
				flag: bare,
				value: a.slice(eq + 1)
			});
			else if (i + 1 < argv.length) out.push({
				flag: bare,
				value: argv[i + 1]
			});
		}
	}
	return out;
}
/**
* Q5-① 目标一致性：能解析出的目标 token 与路由 token 全量比对。
* 解析不出 token 的目标值放行（fail-open，M3 扩白名单）。
*/
function checkTargets(targets, resolved) {
	for (const t of targets) {
		if (t.value === resolved.token || t.value === resolved.input) continue;
		const p = parseDoc(t.value);
		if (p.token === "") continue;
		if (p.token !== resolved.token) return {
			ok: false,
			error: {
				code: "target-mismatch",
				message: `argv ${t.flag} 的目标与路由结果不符：路由=${resolved.input}（token ${resolved.token}），命令指向 ${t.value}（token ${p.token}）。拒绝执行，防错账写入。`
			}
		};
	}
	return { ok: true };
}
/** Q6-② 确认指纹：覆盖 profile + 执行身份 + 去除确认旗标后的最终 argv。 */
function computeConfirmationId(profile, as, argv) {
	return createHash("sha256").update(JSON.stringify({
		profile,
		as,
		argv
	}), "utf8").digest("hex").slice(0, 32);
}
// ../cli/src/commands/exec.ts
/**
* exec 命令：守卫链 + 信封透传（决议 Q5/Q6/Q7/Q9 全量落地）。
* 退出码：0 成功 | 1 lark-cli 业务错误 | 2 larklink 守卫/路由错误 | 3 歧义待选择
*        | 10 needsConfirmation（镜像 lark-cli） | 11 timeout-unknown
*/
async function cmdExec(runner, opts, home = larklinkHome(), emit = stdEmit) {
	const fail = (code, message, extra) => {
		emit({
			ok: false,
			code,
			message,
			...extra
		}, null, 2);
		return 2;
	};
	const rawArgs = opts.rawArgs;
	if (rawArgs.length === 0) return fail("usage", "缺少命令：exec -- <lark-cli 命令参数…>");
	const domain = domainOf(rawArgs);
	if (!EXEC_DOMAINS.has(domain)) return fail("domain-not-allowed", `域 "${domain}" 不在文档域白名单（Q9-①）：${[...EXEC_DOMAINS].join(", ")}。其他域请直接使用 lark-cli。`);
	const argvAs = findArgvAs(rawArgs);
	if (argvAs !== null) return fail("argv-as-forbidden", `argv 中的 --as（${argvAs.value || "…"}）被拒绝：执行身份只能用 exec 的 --as 参数显式声明（Q6-①）`);
	const as = opts.as ?? "user";
	const registry = await loadRegistry(home);
	let profile;
	let confidence;
	let routedToken = null;
	if (opts.url !== void 0) try {
		const result = resolve(registry, opts.url, { explicitProfile: opts.profile });
		if (result.status === "ambiguous") {
			emit({
				ok: false,
				code: "ambiguous",
				message: result.reason,
				candidates: result.candidates,
				parsed: result.parsed,
				next: "larklink resolve 后用 --profile 显式指定"
			}, null, 2);
			return 3;
		}
		profile = result.profile;
		confidence = result.confidence;
		routedToken = result.parsed.token;
		if (result.bindingStatus !== "ready") {
			let liveStatus = result.bindingStatus;
			try {
				const synced = await syncBindingStatus({
					runner,
					home
				}, home, profile);
				if (synced.status !== void 0) liveStatus = synced.status;
			} catch {}
			if (liveStatus !== "ready") {
				await appendAudit({
					kind: "exec",
					profile,
					outcome: "blocked-auth",
					confidence,
					domain,
					as
				}, home);
				emit({
					ok: false,
					code: "binding-needs-repair",
					profile,
					bindingStatus: liveStatus,
					liveVerified: true,
					message: `绑定 ${profile} 状态 ${liveStatus}（已实时核验 auth status --verify），需修复授权（不自动换绑定，Q1）`,
					fix: `立即调用 larklink_bindings(action=auth-start, profile=${profile}) 发起登录：自动打开浏览器并生成二维码；用户确认后 auth-complete，然后重试本命令`
				}, null, 2);
				return 2;
			}
		}
	} catch (e) {
		const err = e;
		emit({
			ok: false,
			code: err.code ?? "resolve-error",
			message: err.message
		}, null, 2);
		return 2;
	}
	else if (opts.profile !== void 0) {
		const binding = findBinding(registry, opts.profile);
		if (!binding) return fail("binding-not-found", `绑定 ${opts.profile} 不存在`);
		if (binding.status !== "ready") {
			let liveStatus = binding.status;
			try {
				const synced = await syncBindingStatus({
					runner,
					home
				}, home, opts.profile);
				if (synced.status !== void 0) liveStatus = synced.status;
			} catch {}
			if (liveStatus === "incomplete") return fail("binding-incomplete", `绑定 ${opts.profile} 授权未完成（已实时核验，Q8）`);
			if (liveStatus !== "ready") return fail("binding-needs-repair", `绑定 ${opts.profile} 状态 ${liveStatus}（已实时核验），需修复授权`, {
				bindingStatus: liveStatus,
				liveVerified: true,
				fix: `立即调用 larklink_bindings(action=auth-start, profile=${opts.profile}) 发起登录`
			});
		}
		profile = opts.profile;
		confidence = "explicit";
	} else return fail("usage", "需要 --url（自动路由）或 --profile（显式指定）之一");
	if (routedToken !== null) {
		const check = checkTargets(extractTargets(rawArgs), (await Promise.resolve().then(() => src_exports)).parseDoc(opts.url));
		if (!check.ok) {
			await appendAudit({
				kind: "exec",
				profile,
				outcome: "blocked-target-mismatch",
				confidence,
				domain,
				as,
				argv: rawArgs
			}, home);
			emit({
				ok: false,
				code: check.error.code,
				message: check.error.message
			}, null, 2);
			return 2;
		}
	}
	const confirmationId = computeConfirmationId(profile, as, rawArgs);
	if (opts.yes === true) {
		if (!opts.confirmationId) return fail("confirmation-id-required", "--yes 必须携带首次 needsConfirmation 返回的 --confirmation-id（Q6-②）");
		if (opts.confirmationId !== confirmationId) return fail("confirmation-id-mismatch", `确认指纹不符：本次命令与用户确认的不是同一条请求（期望 ${confirmationId}，收到 ${opts.confirmationId}）。确认不可挪用。`);
	}
	const finalArgv = [
		"--profile",
		profile,
		...rawArgs,
		"--as",
		as,
		...opts.yes ? ["--yes"] : []
	];
	if (opts.dryRun) {
		emit({
			ok: true,
			status: "dry-run",
			profile,
			confidence,
			as,
			argv: finalArgv,
			confirmationId
		}, null, 2);
		return 0;
	}
	const result = await runner(finalArgv, { timeoutMs: opts.timeoutMs });
	const envelope = parseEnvelope(result);
	const errObj = envelope.error ?? {};
	const isConfirmation = result.exitCode === 10 || errObj["type"] === "confirmation";
	let status;
	let exit;
	if (result.timedOut) {
		status = "timeout-unknown";
		exit = 11;
	} else if (isConfirmation && opts.yes !== true) {
		status = "needs-confirmation";
		exit = 10;
	} else if (envelope.ok) {
		status = "success";
		exit = 0;
	} else {
		status = "error";
		exit = 1;
	}
	await appendAudit({
		kind: "exec",
		profile,
		confidence,
		domain,
		as,
		outcome: status,
		durationMs: result.durationMs,
		argv: finalArgv
	}, home);
	const out = {
		ok: status === "success",
		status,
		profile,
		confidence,
		as,
		argv: finalArgv,
		durationMs: result.durationMs,
		exitCode: result.exitCode,
		result: envelope.payload ?? safeJson(result.stdout),
		error: envelope.error
	};
	if (status === "needs-confirmation") {
		out["confirmationId"] = confirmationId;
		out["next"] = `用户同意后：原命令 + --yes --confirmation-id ${confirmationId}`;
		out["message"] = "高风险操作需用户确认（exit 10 门禁透传）。用户看到的就是这条 argv，同意的也是它。";
	}
	if (status === "timeout-unknown") out["message"] = "超时被击杀，服务端结果未知（Q7）：禁止直接重试同 argv；先只读核查（如 drive +inspect）确认实际状态。";
	emit(out, null, 2);
	return exit;
}
// src/tools.ts
/**
* larklink 工具注册：三个模型可见工具，全部薄适配到 CLI 命令函数（同一执行引擎）。
* 信封经 emit 缝捕获后作为工具结果返回。
*/
/** defineTool 泛型按字面量收窄过严（动态 spec 推断为 never）；宽松壳仅放宽类型，运行时原样。 */
const defineToolLoose = defineTool;
/** 捕获 emit 信封（工具结果）。 */
function capture() {
	let value;
	const emit = (p) => {
		value = p;
	};
	return {
		emit,
		payload: () => value
	};
}
function asStringArray(value, field) {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`${field} 必须是字符串数组（lark-cli 命令参数，逐个元素）`);
	return value;
}
function registerLarklinkTools(deps) {
	const { ctx, runner, config } = deps;
	const home = config.home;
	const disposers = [];
	const register = (spec) => {
		const dispose = ctx.tools.register(defineToolLoose({
			output: {
				schema: {
					type: "object",
					additionalProperties: true,
					description: "larklink JSON envelope"
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value, null, 2)
				}]
			},
			...spec
		}));
		disposers.push(typeof dispose === "function" ? dispose : () => {});
	};
	register({
		name: "larklink_resolve",
		description: "Resolve which lark/feishu account (binding) should operate on a document URL or bare token, and manage lark-cli login lifecycle. Use PROACTIVELY whenever the user mentions a feishu.cn / larksuite.com / larkoffice.com / doubao.com document link or a bare token (doxcn/shtcn/wikcn/bascn/...), or when any lark-cli/larklink operation reports auth failure, token expiry, or not-logged-in — regardless of how many bindings exist. Returns the routing decision (profile, confidence, brand) or an ambiguous candidate list with read-only probe annotations (accessible / no-permission / auth-failed / timeout). Never auto-picks among multiple candidates — ask the user.",
		parameters: {
			input: {
				type: "string",
				required: true,
				description: "Document URL or bare token (doxcn/shtcn/wikcn/bascn/...)"
			},
			explicitProfile: {
				type: "string",
				description: "User explicitly named the binding to use this turn."
			},
			askedProfile: {
				type: "string",
				description: "The user's answer to an ambiguity question (records confidence=asked)."
			},
			pin: {
				type: "boolean",
				description: "Remember the asked/explicit choice for this document token (document-level preference)."
			},
			probe: {
				type: "boolean",
				description: "Read-only probe of ambiguous candidates via drive +inspect (default true)."
			}
		},
		async execute(args) {
			const cap = capture();
			await cmdResolve(runner, {
				input: String(args["input"]),
				explicitProfile: args["explicitProfile"] !== void 0 ? String(args["explicitProfile"]) : void 0,
				askedProfile: args["askedProfile"] !== void 0 ? String(args["askedProfile"]) : void 0,
				pin: args["pin"] === true,
				probe: args["probe"] !== false,
				probeTimeoutMs: config.probeTimeoutMs
			}, home, cap.emit);
			return cap.payload();
		}
	});
	register({
		name: "larklink_exec",
		description: "Execute a guarded lark-cli document-domain command (docs/drive/sheets/markdown/slides/base/whiteboard/wiki/mindnotes) as the resolved or explicitly named binding. Use for every feishu/lark document read/write operation (single OR multiple bindings). Enforces: target consistency vs routing, no --as smuggling (use the as param), exit-10 confirmation fingerprint binding, timeout-unknown reporting. Prefer larklink_resolve first. On binding-needs-repair, run larklink_bindings auth-start immediately instead of asking the user to use a terminal.",
		parameters: {
			args: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "lark-cli command after the profile flag, e.g. [\"docs\",\"+update\",\"--doc\",\"<url>\",\"--content\",\"…\"]"
			},
			url: {
				type: "string",
				description: "Document URL/token being operated on (enables routing + target guard)."
			},
			profile: {
				type: "string",
				description: "Explicit binding name (skips routing)."
			},
			as: {
				type: "string",
				enum: ["user", "bot"],
				description: "Execution identity; default user; bot requires explicit user request."
			},
			yes: {
				type: "boolean",
				description: "Confirmed retry after needs-confirmation; must carry the matching confirmationId."
			},
			confirmationId: {
				type: "string",
				description: "The confirmationId from the needs-confirmation envelope."
			},
			dryRun: {
				type: "boolean",
				description: "Return the final argv without touching lark-cli."
			}
		},
		async execute(args) {
			const cap = capture();
			await cmdExec(runner, {
				rawArgs: asStringArray(args["args"], "args"),
				url: args["url"] !== void 0 ? String(args["url"]) : void 0,
				profile: args["profile"] !== void 0 ? String(args["profile"]) : void 0,
				as: args["as"] === "bot" ? "bot" : "user",
				yes: args["yes"] === true,
				confirmationId: args["confirmationId"] !== void 0 ? String(args["confirmationId"]) : void 0,
				dryRun: args["dryRun"] === true,
				timeoutMs: config.execTimeoutMs
			}, home, cap.emit);
			return cap.payload();
		}
	});
	register({
		name: "larklink_bindings",
		description: "Binding management and lark-cli login lifecycle. Actions: adopt existing lark-cli profiles as larklink bindings; list bindings with live status; health sync (also cleans dead pins); manage document pins; auth-start FIRST live-verifies and returns status:\"already-ready\" when the binding is actually usable (stale cached needs_refresh — just retry, do NOT ask the user to scan) / status:\"auth-pending\" when an unexpired login flow already exists (REUSE its verificationUrl — never open another page or ask for a second scan) / status:\"auth-started\" with a fresh QR flow (opens the browser once, returns verification URL + QR code). Ask the user for explicit confirmation in chat BEFORE calling auth-start whenever resolve/exec reports binding-needs-repair, auth-failed, needs_refresh, unauthorized, or incomplete — do not silently open browser windows and do not send the user to a terminal; auth-complete finishes login after the user confirms in the browser (device code is stashed server-side; no code needed). Only adding new apps (app secret via stdin) and removing bindings stay in the user's terminal (larklink bindings add|remove).",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"adopt",
					"list",
					"health",
					"pin-add",
					"pin-remove",
					"pin-list",
					"auth-start",
					"auth-complete"
				],
				description: "Management action."
			},
			profile: {
				type: "string",
				description: "Binding profile name (adopt filter / pin target / auth-start & auth-complete target)."
			},
			token: {
				type: "string",
				description: "Document token for pin-add / pin-remove."
			},
			fast: {
				type: "boolean",
				description: "list: skip live status verification."
			},
			domain: {
				type: "string",
				description: "auth-start: lark-cli scope domains, comma-separated (default docs)."
			},
			open: {
				type: "boolean",
				description: "auth-start: open the browser at the verification URL (default true)."
			}
		},
		async execute(args) {
			const cap = capture();
			const action = String(args["action"]);
			const profile = args["profile"] !== void 0 ? String(args["profile"]) : void 0;
			switch (action) {
				case "adopt":
					await cmdAdopt({
						runner,
						home
					}, { profiles: profile ? [profile] : void 0 }, cap.emit);
					break;
				case "list":
				case "health":
					await cmdList({
						runner,
						home
					}, {
						fast: args["fast"] === true,
						health: action === "health"
					}, cap.emit);
					break;
				case "pin-add":
				case "pin-remove": {
					const token = args["token"];
					if (token === void 0 || profile === void 0) throw new Error("pin-add / pin-remove 需要 token 与 profile");
					await cmdPin({
						op: action === "pin-add" ? "add" : "remove",
						token: String(token),
						profile
					}, home, cap.emit);
					break;
				}
				case "pin-list":
					await cmdPin({ op: "list" }, home, cap.emit);
					break;
				case "auth-start":
				case "auth-complete":
					if (profile === void 0) throw new Error(`${action} 需要 profile`);
					await cmdAuth({
						runner,
						home
					}, {
						profile,
						domain: args["domain"] !== void 0 ? String(args["domain"]) : void 0,
						complete: action === "auth-complete",
						open: args["open"] !== false
					}, cap.emit);
					break;
				default: throw new Error(`未知 action: ${action}`);
			}
			return cap.payload();
		}
	});
	return disposers;
}
// src/routes.ts
const ROUTE_BASE = "/larklink";
function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
/** 同源栅栏：origin/host 不一致或跨站 sec-fetch 拒绝（照 browser-skill fence 语义）。 */
function fenceViolation(req) {
	const origin = req.headers["origin"];
	if (typeof origin === "string" && origin !== "") try {
		const o = new URL(origin);
		const host = req.headers["host"];
		if (o.host !== host) return "origin mismatch";
	} catch {
		return "bad origin";
	}
	const site = req.headers["sec-fetch-site"];
	if (typeof site === "string" && site !== "same-origin" && site !== "none") return `cross-site ${site}`;
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		let done = false;
		/** 单次收尾：防 end/error/超时重复触发；清掉超时定时器。 */
		const finish = (settle) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			settle();
		};
		const timer = setTimeout(() => finish(() => reject(/* @__PURE__ */ new Error("body timeout"))), 5e3);
		req.on("data", (c) => {
			data += c.toString("utf8");
			if (data.length > 65536) finish(() => reject(/* @__PURE__ */ new Error("body too large")));
		});
		req.on("end", () => finish(() => resolve(data)));
		req.on("error", (e) => finish(() => reject(e)));
	});
}
function captureEmit() {
	let value;
	const emit = (p) => {
		value = p;
	};
	return {
		emit,
		payload: () => value
	};
}
function safeParseBody(text) {
	try {
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
function registerLarklinkRoutes(deps) {
	const { ctx, runner, home } = deps;
	let disposed = false;
	const disposers = [];
	ctx.inject(["webServer"], (injected) => {
		const webServer = injected.get("webServer");
		if (webServer === null || typeof webServer.register !== "function") return () => {};
		if (disposed) return () => {};
		const route = (method, path, handler) => {
			const dispose = webServer.register({
				kind: "exact",
				path,
				handler: (req, res) => {
					const violation = fenceViolation(req);
					if (violation !== void 0) {
						sendJson(res, 403, {
							ok: false,
							error: `forbidden: ${violation}`
						});
						return;
					}
					if ((req.method ?? "GET") !== method) {
						sendJson(res, 405, {
							ok: false,
							error: "method not allowed"
						});
						return;
					}
					Promise.resolve(handler(req, res)).catch((e) => {
						sendJson(res, 500, {
							ok: false,
							error: e.message
						});
					});
				}
			});
			disposers.push(typeof dispose === "function" ? dispose : () => {});
		};
		route("GET", `${ROUTE_BASE}/bindings`, async (req, res) => {
			await readBody(req).catch(() => "");
			const live = new URL(req.url ?? "/", "http://localhost").searchParams.get("live") === "1";
			const cap = captureEmit();
			await cmdList({
				runner,
				home
			}, {
				fast: !live,
				health: false
			}, cap.emit);
			sendJson(res, 200, cap.payload());
		});
		route("POST", `${ROUTE_BASE}/adopt`, async (req, res) => {
			await readBody(req);
			const cap = captureEmit();
			await cmdAdopt({
				runner,
				home
			}, {}, cap.emit);
			sendJson(res, 200, cap.payload());
		});
		route("POST", `${ROUTE_BASE}/health`, async (req, res) => {
			await readBody(req);
			const cap = captureEmit();
			await cmdList({
				runner,
				home
			}, { health: true }, cap.emit);
			sendJson(res, 200, cap.payload());
		});
		const authRoute = (complete) => async (req, res) => {
			const body = safeParseBody(await readBody(req).catch(() => ""));
			const profile = typeof body["profile"] === "string" ? body["profile"] : void 0;
			if (profile === void 0 || profile === "") {
				sendJson(res, 400, {
					ok: false,
					error: "需要 JSON body { profile }"
				});
				return;
			}
			const cap = captureEmit();
			await cmdAuth({
				runner,
				home
			}, {
				profile,
				complete,
				open: !complete
			}, cap.emit);
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
// src/skill-content.ts
/** 内嵌 SKILL 内容（随插件注册到 DSH skills 服务，source: bundled）。 */
const LARKLINK_SKILL_NAME = "larklink";
const LARKLINK_SKILL_DESCRIPTION = "Feishu/Lark document operations + login lifecycle, routed through larklink tools. Use PROACTIVELY, regardless of how many accounts are bound, whenever: (1) the user provides a feishu.cn / larksuite.com / larkoffice.com / doubao.com document link or a bare token (doxcn/shtcn/wikcn/bascn/doccn/fldcn/obcn...), or asks to read/edit/create any Feishu/Lark document, sheet, base, wiki or slides; (2) any lark-cli or lark-* skill operation fails with auth errors, token expiry, needs_refresh, unauthorized, or not-logged-in — larklink triggers the QR login flow automatically (opens the browser; no terminal needed).";
const LARKLINK_SKILL_MARKDOWN = `# larklink —— 飞书/Lark 文档操作路由与登录管理

## 何时使用（无条件触发，不看绑定数量）

- 用户给出 feishu.cn / larksuite.com / larkoffice.com / doubao.com 的文档链接，或 doxcn / doccn / wikcn / shtcn / bascn / fldcn / obcn 裸 token，要求读取或修改
- 用户要求创建/编辑飞书文档、表格、Base、知识库、幻灯片
- 任何 lark-cli / lark-* skill 操作报授权错误（未登录 / token 过期 / needs_refresh / unauthorized / incomplete）——立即走本 skill 的登录修复流程

**单一绑定也要走 larklink**：larklink 统一提供路由、授权生命周期管理（自动触发扫码登录）、目标守卫与审计。不要因为"只有一个账号"就绕过。

## 硬纪律（多账号防串号）

1. 一切文档域操作必须 \`larklink_resolve\` → \`larklink_exec\`，**禁止**直接调用 lark-cli 文档命令（多账号时会静默打到默认账号，单账号时绕过授权管理与审计）。
2. 身份选择优先级：用户显式指定 > 文档 pin > 唯一绑定 > 询问用户。**能力 ≠ 意图**：探测结果、ready 状态、tenantHint 永不构成自动换号理由。绑定失效 → 走登录修复流程，绝不换绑定重试。
3. 执行身份默认 user；以应用身份（bot）执行必须用户明确要求（\`as: "bot"\`），绝不静默回退。

## 标准流程

1. \`larklink_resolve(input)\` → \`resolved\`（profile / confidence / wikiUnwrapNeeded）或 \`ambiguous\`（candidates 含 probe 标注：accessible / no-permission / auth-failed / timeout）
   - 报 \`no-routable-binding\` 且本机有 lark-cli profile：先 \`larklink_bindings(action=adopt)\` 导入再重试 resolve
   - 全新机器（无任何 profile）：提示用户在终端执行 \`larklink bindings add\`（app secret 不经模型）
2. ambiguous → 把候选与标注呈现给用户选择；选择后 \`larklink_resolve(input, askedProfile, pin=true)\` 记住偏好
3. \`larklink_exec(args, url 或 profile)\` 执行 lark-cli 文档命令，返回信封：
   - \`needs-confirmation\`：向用户展示 action 与参数预览；用户明确同意后，**原样命令** + \`yes=true\` + 返回的 \`confirmationId\`（指纹不符会被拒绝——确认不可挪用）
   - \`timeout-unknown\`：禁止直接重试同命令；先只读核查（drive +inspect / docs +fetch）确认服务端实际状态
   - \`error\`：读 error 字段修复参数或授权后重试
4. wiki 链接（wikcn…）先 \`drive +inspect\` 解包出真实 token/type 再路由到对应命令

## 登录修复（识别到授权失效时：先在对话里问，用户同意后再开授权页）

只要 resolve / exec / 探测出现 \`binding-needs-repair\`、\`auth-failed\`、\`needs_refresh\`、\`unauthorized\`、\`incomplete\` 任一信号：

1. **先在 AI 窗口发起确认，不要直接打开浏览器**：用 \`ask_user_question\`（不可用时直接在回复里问）说明「绑定 <name> 的<问题>已失效，是否现在重新授权（会打开授权页面，约 10 分钟有效）？」，选项：**现在重新授权 / 稍后（先不授权）**。用户选稍后 → 告知该操作无法继续，结束本次任务，不要重试
2. 用户同意后：\`larklink_bindings(action=auth-start, profile=<绑定>)\` —— 它会**先实时核验**（needs_refresh ≠ 失效，access token 由 lark-cli 自动刷新）：
   - \`status: "already-ready"\`：绑定其实可用（缓存状态陈旧），**不要**再要求用户扫码——直接原样重试刚才的操作
   - \`status: "auth-pending"\`：该绑定已有进行中的授权流程（未过期）——**不要**再开新页面/重新扫码，直接把返回的 verificationUrl（及 qrcode）给用户，让 TA 在**已打开的页面**完成确认
   - \`status: "auth-started"\`：自动打开系统浏览器并生成二维码（envelope 含 verificationUrl、qrcode 路径、expiresInSeconds）。把 verificationUrl 作为可点链接给用户；若环境支持读图，用 read_image 展示 qrcode PNG；浏览器没自动打开时提醒用户手动点链接或扫码
3. 等用户在浏览器完成授权确认（10 分钟内有效）。用户回复完成后：\`larklink_bindings(action=auth-complete, profile=<绑定>)\`（device_code 已在插件侧暂存，无需携带；过期会报 pending-auth-expired，届时重新 auth-start）
4. auth-complete 返回 ready 后**原样重试**之前的操作

注意：exec 在拦截前也会先实时核验缓存状态（needs_refresh 但实际可用时会直接放行）——只有真正失效（refresh token 过期等）才会返回 binding-needs-repair。**同一流程内绝不重复 auth-start**（重复调用只会复用现有流程，不会新开页面）；auth-complete 失败通常意味着用户还没在浏览器确认——提示用户确认后再次 auth-complete，不要立刻重新发起。绝不静默换绑定。

## 写操作纪律

- \`overwrite\` / 整段替换前**必须先 fetch 最新内容**做增量合并；优先 str_replace 类局部修改（目标文本不存在会失败而非误覆盖）
- 批量多文档：逐个 resolve+exec，失败不中断，最后汇总成功/失败清单
- 超时（timeout-unknown）后先核查再决定，禁止盲目重试

## 命令域白名单（v1）

docs · drive · sheets · markdown · slides · base · whiteboard · wiki · mindnotes

其他域（im / mail / task / calendar…）不经 larklink，直接用 lark-cli / lark-* skills。

## 绑定管理

- \`larklink_bindings\` 工具动作：adopt（导入既有 profile）/ list / health / pin 管理 / **auth-start / auth-complete（扫码登录与授权修复，无密钥经手）**
- 仅以下操作让用户在终端执行：\`larklink bindings add\`（新建应用，app secret 走 stdin）、\`larklink bindings remove\`（破坏性删除）
`;
// src/index.ts
/**
* @timeryu/dsh-larklink —— DSH 插件入口（cordis 契约：name / inject / Config / apply）。
* 工具注册 + 内嵌 SKILL 注册；所有命令走 CLI 层同一执行引擎（Q5-Q9 守卫全量生效）。
*/
const name = "@timeryu/dsh-larklink";
const inject = ["tools"];
/** 运行时配置（cordis 校验并填充默认值）。 */
const Config = Schema.object({
	home: Schema.string().default("").description("larklink 主目录覆盖（默认 ~/.larklink；测试/多实例用）。"),
	execTimeoutMs: Schema.number().default(12e4).description("exec 默认超时（毫秒）；超时按 timeout-unknown 处理。"),
	probeTimeoutMs: Schema.number().default(8e3).description("歧义候选只读探测超时（毫秒）。")
});
function apply(ctx, config = {}, options = {}) {
	const disposers = [];
	disposers.push(...registerLarklinkTools({
		ctx,
		runner: options.runner ?? defaultLarkRunner,
		config: {
			home: config.home || void 0,
			execTimeoutMs: config.execTimeoutMs,
			probeTimeoutMs: config.probeTimeoutMs
		}
	}));
	const skills = ctx.get("skills");
	if (skills != null && typeof skills.register === "function") {
		const unregister = skills.register({
			name: LARKLINK_SKILL_NAME,
			description: LARKLINK_SKILL_DESCRIPTION,
			content: LARKLINK_SKILL_MARKDOWN,
			source: "bundled"
		});
		if (typeof unregister === "function") disposers.push(unregister);
	}
	disposers.push(registerLarklinkRoutes({
		ctx,
		runner: options.runner ?? defaultLarkRunner,
		home: config.home || void 0
	}));
	ctx.effect(() => () => {
		for (const dispose of [...disposers].reverse()) dispose();
	});
}
export { Config, apply, inject, name };
