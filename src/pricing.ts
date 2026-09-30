/**
 * DeepSeek 人民币定价数据。
 *
 * 数据源：`https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`（服务端渲染 HTML，
 * 直接给出人民币单价与北京时间的峰谷时段规则）。
 *
 * 本模块负责：
 * - 从 HTML 解析模型单价（空闲/高峰 × 缓存命中/未命中/输出）
 * - 落盘缓存（TTL）+ 内置兜底表
 * - 与上次快照对比，报告变化
 */

/** 单个模型的一组单价（人民币元 / 百万 tokens）。 */
export interface ModelPricing {
	/** 缓存命中输入：空闲 / 高峰 */
	cacheHit: { offPeak: number; peak: number };
	/** 缓存未命中输入：空闲 / 高峰 */
	cacheMiss: { offPeak: number; peak: number };
	/** 输出：空闲 / 高峰 */
	output: { offPeak: number; peak: number };
}

/** 定价表：模型 ID → 单价。 */
export type PricingTable = Record<string, ModelPricing>;

/** 内置兜底表（来自中文定价页快照，元 / 1M tokens）。*/
export const FALLBACK_PRICING: PricingTable = {
	"deepseek-flash": {
		cacheHit: { offPeak: 0.02, peak: 0.04 },
		cacheMiss: { offPeak: 1, peak: 2 },
		output: { offPeak: 4, peak: 8 },
	},
	"deepseek-v4-pro": {
		cacheHit: { offPeak: 0.15, peak: 0.3 },
		cacheMiss: { offPeak: 4.5, peak: 9 },
		output: { offPeak: 13.5, peak: 27 },
	},
};

/** 旧模型名 → 现行模型名的兼容映射（官方脚注：旧名仍可调用，按 Flash 计费）。 */
const MODEL_ALIASES: Record<string, string> = {
	"deepseek-v4-flash": "deepseek-flash",
	"deepseek-v4-flash-vision-exp": "deepseek-flash",
	"deepseek-chat": "deepseek-v4-pro",
	"deepseek-reasoner": "deepseek-v4-pro",
};

/** 把模型名规范化为定价表中的键。 */
export function normalizeModelName(model: string): string {
	return MODEL_ALIASES[model] ?? model;
}

/** 查某个模型的单价；找不到返回 undefined。 */
export function getModelPricing(table: PricingTable, model: string): ModelPricing | undefined {
	return table[normalizeModelName(model)];
}

// ---------------------------------------------------------------------------
// HTML 解析
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, " ");
}

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\u200b/g, "");
}

interface Cell {
	text: string;
}

/** 从一行 <tr>...</tr> 中提取单元格文本（<td>）。不考虑 rowspan/colspan 的复杂归并。 */
function extractCells(rowHtml: string): string[] {
	const cells: string[] = [];
	const re = /<td[^>]*>([\s\S]*?)<\/td>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rowHtml)) !== null) {
		cells.push(decodeEntities(stripTags(m[1]!)).replace(/\s+/g, " ").trim());
	}
	return cells;
}

/** 解析价格数字：如 "0.02元" → 0.02；"1元" → 1。 */
function parseYuan(text: string): number | undefined {
	const m = /(-?\d+(?:\.\d+)?)\s*元/.exec(text);
	if (!m) return undefined;
	const n = Number.parseFloat(m[1]!);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * 解析中文定价页 HTML，得到定价表。
 *
 * 页面结构（节选）：
 * ```
 * <tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
 * ...
 * <tr><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
 * <tr><td>...</td><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
 * <tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
 * ...
 * <tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
 * ```
 */
export function parsePricingHtml(html: string): PricingTable {
	const table: PricingTable = {};

	// 1) 找模型行：包含 "模型" 且含至少一个 deepseek-* 的 <tr>。
	const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];

	let modelRow: string[] | undefined;
	for (const row of rows) {
		const cells = extractCells(row);
		if (cells.some((c) => c === "模型" || c.startsWith("模型"))) {
			const models = cells.filter((c) => /^deepseek-[\w-]+/.test(c));
			if (models.length > 0) {
				modelRow = models.map((c) => c.replace(/\(\d+\)/g, "").trim());
				break;
			}
		}
	}
	if (!modelRow) return table;

	for (const model of modelRow) {
		table[model] = {
			cacheHit: { offPeak: 0, peak: 0 },
			cacheMiss: { offPeak: 0, peak: 0 },
			output: { offPeak: 0, peak: 0 },
		};
	}

	// 2) 逐行解析价格行。由于存在 rowspan，不同行的单元格数不一：
	//    - 空闲时段行：[分类, 时段, 值1, 值2]
	//    - 高峰时段行（分类列被 rowspan 合并）：[时段, 值1, 值2]
	//    因此需要跨行记住“当前分类”。
	let currentCategory: "cacheHit" | "cacheMiss" | "output" | undefined;
	for (const row of rows) {
		const cells = extractCells(row);
		if (cells.length < 2) continue;

		const joined = cells.join(" ");
		// 更新当前分类（仅当本行自身包含分类文本时）。
		if (joined.includes("缓存命中") && !joined.includes("未命中")) currentCategory = "cacheHit";
		else if (joined.includes("缓存未命中")) currentCategory = "cacheMiss";
		else if (joined.includes("输出")) currentCategory = "output";

		const offPeakIdx = cells.indexOf("空闲时段");
		const peakIdx = cells.indexOf("高峰时段");
		if (offPeakIdx === -1 && peakIdx === -1) continue;
		if (!currentCategory) continue;

		const which: "offPeak" | "peak" = offPeakIdx !== -1 ? "offPeak" : "peak";
		const idx = offPeakIdx !== -1 ? offPeakIdx : peakIdx;

		// 该时段标签之后的单元格，按顺序对应该 modelRow 的模型。
		const values: number[] = [];
		for (let i = idx + 1; i < cells.length; i++) {
			const v = parseYuan(cells[i]!);
			if (v !== undefined) values.push(v);
		}
		for (let mi = 0; mi < modelRow.length; mi++) {
			const model = modelRow[mi]!;
			const value = values[mi];
			if (value === undefined) continue;
			table[model]![currentCategory][which] = value;
		}
	}

	// 3) 校验：至少要有一项非零，否则视为解析失败。
	const hasData = Object.values(table).some(
		(m) => m.cacheHit.peak > 0 || m.cacheMiss.peak > 0 || m.output.peak > 0,
	);
	return hasData ? table : {};
}

// ---------------------------------------------------------------------------
// 变化检测
// ---------------------------------------------------------------------------

/** 定价差异描述。 */
export interface PricingDiff {
	added: string[];
	removed: string[];
	changed: string[];
}

/** 比较两份定价表，返回变化。 */
export function diffPricing(previous: PricingTable, current: PricingTable): PricingDiff {
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];

	for (const model of Object.keys(current)) {
		if (!(model in previous)) {
			added.push(model);
			continue;
		}
		if (JSON.stringify(previous[model]) !== JSON.stringify(current[model])) {
			changed.push(model);
		}
	}
	for (const model of Object.keys(previous)) {
		if (!(model in current)) removed.push(model);
	}
	return { added, removed, changed };
}

/** 差异是否为空。 */
export function isEmptyDiff(diff: PricingDiff): boolean {
	return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
