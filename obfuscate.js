/**
 * 代码保护 — 对 esbuild 全量 bundle 做选择性混淆
 *
 * 策略：禁用高性能代价的 transform (Pack, ObjectExtraction, VariableMasking)，
 * 保留低代价但有效的保护 (RenameVariables, StringConcealing, ControlFlowFlattening)。
 *
 * 性能预算：加载时间 < 500ms（无混淆 ~170ms）
 */

const fs = require("fs");
const path = require("path");
const { obfuscateWithProfiler } = require("../references/js-confuser");

const targets = [
	{ file: path.resolve(__dirname, "dist/extension.js"), target: "node" },
	{ file: path.resolve(__dirname, "dist/webview.js"), target: "browser" },
];

async function obfuscateFile(filePath, targetEnv) {
	const code = fs.readFileSync(filePath, "utf-8");
	const inputSize = Buffer.byteLength(code);
	const label = path.basename(filePath);

	console.log("[obfuscate] %s: input %s KB, %d lines",
		label, (inputSize / 1024).toFixed(1), code.split("\n").length);

	const startTime = performance.now();

	const result = await obfuscateWithProfiler(code, {
		target: targetEnv,
		compact: true,                 // 单行输出，防止模板字符串内换行
		hexadecimalNumbers: true,      // 数字用十六进制表示

		// ── 零代价 ──
		renameVariables: true,         // 变量名混淆
		renameGlobals: true,           // 全局变量也重命名
		renameLabels: true,            // 标签重命名
		movedDeclarations: true,       // 声明位置随机化
		shuffle: true,                 // 语句顺序打乱
		calculator: true,              // 数字表达式复杂化

		// ── 低代价 ──
		stringConcealing: true,        // 字符串 → 解码函数调用
		duplicateLiteralsRemoval: 0.5, // 重复字面量合并
		stringSplitting: 0.25,         // 字符串拆分           (medium: 0.25)
		deadCode: 0.1,                 // 插入死代码           (medium: 0.1)
		opaquePredicates: 0.5,         // 不透明谓词
		astScrambler: true,            // 连续表达式合并

		// ── 中等代价 ──
		controlFlowFlattening: 0.25,   // 控制流扁平化         (medium: 0.25)
		dispatcher: 0.08,              // 函数调用调度表       (medium: 0.5)
		globalConcealing: true,        // 全局变量间接访问     (medium: true)

		// ── 禁用（性能杀手或不兼容） ──
		lock: false,                   // integrity + dispatcher/globalConcealing 组合破坏 proto 初始化
		pack: false,                   // new Function() 5MB → 30s+ 启动
		objectExtraction: false,       // proxy getter/setter → 10x 慢
		variableMasking: false,        // 同上
		flatten: false,                // 不稳定 + 极高代价
		rgf: false,                    // eval 不兼容 extension host
		minify: false,                 // esbuild 已做
		stringCompression: false,      // 依赖 Function() 构造器
	});

	const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
	const outputSize = Buffer.byteLength(result.code);
	const { profileData } = result;

	console.log("[obfuscate] %s: output %s KB", label, (outputSize / 1024).toFixed(1));
	console.log("[obfuscate] %s: ratio %s%%, time %ss, transforms %d/%d",
		label, ((outputSize / inputSize) * 100).toFixed(0), elapsed,
		profileData.totalTransforms, profileData.totalPossibleTransforms);

	const transforms = Object.entries(profileData.transforms)
		.sort((a, b) => b[1].transformTime - a[1].transformTime);
	for (const [name, data] of transforms) {
		if (data.transformTime < 1) continue;
		console.log("  %s %sms", name.padEnd(35), data.transformTime.toFixed(0).padStart(6));
	}

	fs.writeFileSync(filePath, result.code);
	console.log("[obfuscate] written to %s", path.relative(process.cwd(), filePath));
}

async function main() {
	for (const { file, target } of targets) {
		await obfuscateFile(file, target);
	}
}

main().catch((e) => {
	console.error("[obfuscate] failed:", e.message);
	process.exit(1);
});
