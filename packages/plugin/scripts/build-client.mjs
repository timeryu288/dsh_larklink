/**
 * 客户端 bundle 构建：esbuild(tsx → cjs, peer external) 包进 window.__ModuleLoader__.load
 * 工厂（与 browser-skill 插件 client.cjs 同构）。
 */
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [resolve(root, "src/client/index.tsx")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  jsx: "automatic",
  external: ["react", "react-dom", "react/jsx-runtime"],
  minify: true,
  legalComments: "none",
  write: false,
});

const outputFile = result.outputFiles[0];
if (outputFile === undefined) throw new Error("esbuild 未产出 client bundle");
const code = outputFile.text;
const wrapped = `window.__ModuleLoader__.load({
	id: "@timeryu288/dsh-larklink",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${code
  .split("\n")
  .map((line) => `\t\t${line}`)
  .join("\n")}
		return module.exports;
	}
});
`;

const out = resolve(root, "lib/client.cjs");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, wrapped, "utf8");
console.log(`client.cjs written (${(wrapped.length / 1024).toFixed(1)} kB)`);
