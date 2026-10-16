/**
 * pi-deepseek-cny
 *
 * footer 状态行：按会话 token 与消息时间重算峰谷费用（人民币，不碰 pi 落盘逻辑）。
 */
import type { ExtensionAPI, ExtensionUIContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { computeCost, selectRates, type CostBreakdown, type TokenUsage } from "../src/cost.ts";
import { loadHolidays, loadPricing } from "../src/data.ts";
import { getBeijingParts, isPeakTime } from "../src/peak-time.ts";
import { getModelPricing, type PricingTable } from "../src/pricing.ts";

const DEEPSEEK_PROVIDER = "deepseek";
/** footer 状态行 key（第 3 行，不占用默认两行）。 */
const STATUS_KEY = "deepseek-cn";

/** 人民币金额（元），保留 2 位小数。 */
function cny(n: number): string {
	return `¥${n.toFixed(2)}`;
}

/**
 * 一次调用的三档 token（未命中输入 / 命中读 / 输出），不含 cacheWrite。
 * 与费用三档、均价分母同源，避免口径不一致。
 */
function tokenTiers(usage: Partial<TokenUsage> | undefined): { input: number; cacheRead: number; output: number } {
	return {
		input: usage?.input ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		output: usage?.output ?? 0,
	};
}

/**
 * 会话费用聚合（人民币元）。
 * 口径：total = peak + off-peak = miss + hit + output；cache_warm 完全独立，不计入以上任何项。
 */
interface CostBuckets {
	/** 主调用总金额（不含 cache_warm）。 */
	total: number;
	/** 高峰时段产生的费用。 */
	peak: number;
	/** 空闲时段产生的费用。 */
	offPeak: number;
	/** 缓存未命中输入（input 档）。 */
	input: number;
	/** 缓存命中读取（cacheRead 档）。 */
	cacheRead: number;
	/** 输出。 */
	output: number;
	/** cache_warm 预热调用产生的费用（完全独立，不计入 total / 时段 / 档位）。 */
	cacheWarm: number;
	/** 主调用 token 总数（用于折算每亿 token 均价，不含 cache_warm）。 */
	tokens: number;
}

function emptyBuckets(): CostBuckets {
	return { total: 0, peak: 0, offPeak: 0, input: 0, cacheRead: 0, output: 0, cacheWarm: 0, tokens: 0 };
}

/**
 * 把一次计费的明细并入聚合。
 * 主调用：计入 total / 时段 / 三档（三者恒等）以及三档 token（自统，与均价分母同源）。
 * cache_warm：只计入 cache_warm，不影响其它项。
 *
 * tokens：本次调用的三档 token 用量（不含 cacheWrite）。cache_warm 不计入。
 */
function addCost(
	buckets: CostBuckets,
	breakdown: CostBreakdown,
	peak: boolean,
	isCacheWarm: boolean,
	tokens: { input: number; cacheRead: number; output: number },
): void {
	if (isCacheWarm) {
		buckets.cacheWarm += breakdown.total;
		return;
	}
	// DeepSeek 无独立缓存写入价，官网仅三档：未命中输入 / 命中输入 / 输出。
	// 故 total 取三档之和（不含 cacheWrite），保证恒等式成立。
	const main = breakdown.input + breakdown.cacheRead + breakdown.output;
	buckets.total += main;
	if (peak) buckets.peak += main;
	else buckets.offPeak += main;
	buckets.input += breakdown.input;
	buckets.cacheRead += breakdown.cacheRead;
	buckets.output += breakdown.output;
	buckets.tokens += tokens.input + tokens.cacheRead + tokens.output;
}

/** 当前时段名称：高峰“峰” / 空闲“谷”。 */
function peakName(peak: boolean): string {
	return peak ? "峰" : "谷";
}

/**
 * 当前时段单价标签（元 / 百万 tokens）：时段名后紧跟。
 * 三档用“/”分隔，顺序固定为 miss/hit/out。
 */
function rateLabel(rates: { input: number; cacheRead: number; output: number }): string {
	return `${cny(rates.input)}/${cny(rates.cacheRead)}/${cny(rates.output)}`;
}

/**
 * 组装 footer 状态行文本（人民币元）。
 * 格式：
 *   谷 ¥1.00/¥0.02/¥4.00 ｜¥0.05 + ¥0.04 + ¥0.09 = 峰¥0.00 + 谷¥0.19 = 总¥0.19｜单价 ¥5.95/亿
 * 顺序：三档费用 = 峰 + 谷 = 总 ｜ 均价（元/亿 token）。
 * 均价 = 总费用 / 总 token * 1e8；无 token 时显示 ¥0.00。
 * 末尾 4 个空格：与其它扩展的状态行在视觉上分隔开。
 */
function statusText(peak: boolean, buckets: CostBuckets, rateText: string): string {
	const tiers = `${cny(buckets.input)} + ${cny(buckets.cacheRead)} + ${cny(buckets.output)}`;
	const byPeriod = `峰${cny(buckets.peak)} + 谷${cny(buckets.offPeak)}`;
	const avgPerYi = buckets.tokens > 0 ? (buckets.total / buckets.tokens) * 1e8 : 0;
	const head = rateText ? `${peakName(peak)} ${rateText}` : peakName(peak);
	return `${head} ｜${tiers} = ${byPeriod} = 总${cny(buckets.total)}｜单价 ${cny(avgPerYi)}/亿    `;
}

/** 从消息时间取年份（北京时间）。 */
function shanghaiYear(time: Date): number {
	return Number.parseInt(getBeijingParts(time).date.slice(0, 4), 10);
}

/** 计费关心的 assistant 消息形状（结构化窄化，避免依赖未导出的类型）。 */
interface UsageBearingMessage {
	role: "assistant";
	provider: string;
	model: string;
	timestamp: number;
	usage?: Partial<TokenUsage>;
}

function asUsageBearing(message: MessageEndEvent["message"]): UsageBearingMessage | undefined {
	const m = message as unknown as Partial<UsageBearingMessage>;
	if (m.role !== "assistant") return undefined;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return undefined;
	if (typeof m.timestamp !== "number") return undefined;
	return m as UsageBearingMessage;
}

/** 会话历史里计费关心的条目形状（assistant 消息、usage 条目）。 */
interface CostBearingEntry {
	type: string;
	/** usage 条目特有：类别（如 cache_warm）。 */
	kind?: string;
	provider?: string;
	model?: string;
	/** usage 条目的时间戳为 ISO 字符串。 */
	timestamp?: string;
	usage?: Partial<TokenUsage>;
	message?: {
		role?: string;
		provider?: string;
		model?: string;
		timestamp?: number;
		usage?: Partial<TokenUsage>;
	};
}

export default function piDeepseekCn(pi: ExtensionAPI): void {
	// 会话费用聚合。由历史重算初始化，之后按每条消息增量累加。
	let buckets = emptyBuckets();
	let sessionReady = false;

	// 运行时数据（懒加载 + 缓存）。
	let pricing: PricingTable | undefined;
	let pricingReady: Promise<void> | undefined;
	/** 上次加载定价表的时间，超过 TTL 后重新抓取。 */
	let pricingLoadedAt = 0;
	const PRICING_TTL_MS = 24 * 60 * 60 * 1000; // 每天更新一次
	// 节假日按年缓存，避免重复加载。
	const holidayCache = new Map<number, Set<string>>();
	const holidayLoading = new Map<number, Promise<void>>();

	/** 确保定价表可用；超过 TTL（每天）会重新抓取一次。 */
	async function ensurePricing(ctx: {
		ui: { notify(msg: string, type?: "info" | "warning" | "error"): void };
	}): Promise<void> {
		if (pricingReady) {
			await pricingReady;
		}
		const fresh = pricing && Date.now() - pricingLoadedAt < PRICING_TTL_MS;
		if (fresh) return;

		pricingReady = (async () => {
			// 传 ttlMs=0 绕过磁盘缓存，保证每天真正读一次官网。
			const result = await loadPricing(0);
			pricing = result.table;
			pricingLoadedAt = Date.now();
			if (result.changed) {
				ctx.ui.notify("pi-deepseek-cny: DeepSeek 定价页有变化，已更新单价（请留意费用口径）。", "warning");
			}
		})();
		await pricingReady;
	}

	async function ensureHolidays(year: number): Promise<void> {
		const pending = holidayLoading.get(year);
		if (pending) {
			await pending;
			return;
		}
		if (holidayCache.has(year)) return;

		const p = (async () => {
			const set = await loadHolidays(year);
			holidayCache.set(year, set);
		})();
		holidayLoading.set(year, p);
		try {
			await p;
		} finally {
			holidayLoading.delete(year);
		}
	}

	/** 判断某时刻是否高峰（北京时间 + 法定节假日）。 */
	async function isPeakAt(time: Date): Promise<boolean> {
		await ensureHolidays(shanghaiYear(time));
		return isPeakTime(time, holidayCache.get(shanghaiYear(time)));
	}

	/**
	 * 取某模型在某峰谷下的单价标签（元 / 百万 tokens），用于时段名后展示。
	 * 模型名缺失或无定价表时返回空字符串。
	 */
	function currentRates(model: string | undefined, peak: boolean): string {
		if (!pricing || !model) return "";
		const modelPricing = getModelPricing(pricing, model);
		if (!modelPricing) return "";
		return rateLabel(selectRates(modelPricing, peak));
	}

	/** 刷新 footer 状态行（dim 着色，与默认 footer 其它行一致）。 */
	function refreshStatus(ui: ExtensionUIContext, peak: boolean, model: string | undefined): void {
		ui.setStatus(STATUS_KEY, ui.theme.fg("dim", statusText(peak, buckets, currentRates(model, peak))));
	}

	/**
	 * 按 model + 时间 + token 用量算一次计费明细（人民币元）。
	 * 峰谷取该次调用自身的时间。模型无定价表时返回 undefined。
	 */
	async function costOf(
		model: string,
		timestamp: number,
		usage: Partial<TokenUsage>,
	): Promise<{ breakdown: CostBreakdown; peak: boolean } | undefined> {
		if (!pricing) return undefined;
		const modelPricing = getModelPricing(pricing, model);
		if (!modelPricing) return undefined;
		const peak = await isPeakAt(new Date(timestamp));
		const rates = selectRates(modelPricing, peak);
		const tokens: TokenUsage = {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
		};
		return { breakdown: computeCost(tokens, rates), peak };
	}

	/**
	 * 扫描 session 分支重算聚合费用（人民币元）。
	 * 纳入：deepseek 的 assistant 消息 + 带 provider/model 的 usage 条目（如 cache_warm）。
	 * 只读历史，不读也不改写落盘的 usage.cost；用于启动时初始化（支持恢复旧会话）。
	 *
	 * 用 getBranch() 而非 getEntries()：只统计当前分支，
	 * 避免把编辑/重试产生的废弃分支重复计入（pi 官方建议）。
	 *
	 * 不统计 toolResult：其 usage 为工具内嵌模型调用，消息不带 provider/model，
	 * 无法可靠归属到 deepseek，计入会高估费用。
	 */
	async function recomputeFromHistory(sessionManager: { getBranch(): unknown[] }): Promise<CostBuckets> {
		const result = emptyBuckets();
		for (const raw of sessionManager.getBranch()) {
			const entry = raw as CostBearingEntry;
			if (entry.type === "message") {
				const m = entry.message;
				if (m?.role !== "assistant" || m.provider !== DEEPSEEK_PROVIDER) continue;
				if (typeof m.model !== "string" || typeof m.timestamp !== "number") continue;
				const cost = await costOf(m.model, m.timestamp, m.usage ?? {});
				if (cost) addCost(result, cost.breakdown, cost.peak, false, tokenTiers(m.usage));
			} else if (entry.type === "usage") {
				// usage 条目（如 cache_warm）自带 provider/model/timestamp/usage。
				if (entry.provider !== DEEPSEEK_PROVIDER) continue;
				if (typeof entry.model !== "string" || typeof entry.timestamp !== "string") continue;
				const ts = Date.parse(entry.timestamp);
				if (Number.isNaN(ts)) continue;
				const cost = await costOf(entry.model, ts, entry.usage ?? {});
				if (cost) addCost(result, cost.breakdown, cost.peak, entry.kind === "cache_warm", tokenTiers(entry.usage));
			}
		}
		return result;
	}

	// 启动时重算历史（含恢复的旧会话），初始化 footer 状态行。
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (ctx.model?.provider !== DEEPSEEK_PROVIDER) return;

		await ensurePricing(ctx);
		if (!pricing) return;

		buckets = await recomputeFromHistory(ctx.sessionManager);
		sessionReady = true;
		// 时段按当前时刻判断，单价用当前模型。
		refreshStatus(ctx.ui, await isPeakAt(new Date()), ctx.model?.id);
	});

	// 每条 assistant 消息结束时更新 footer 状态行。
	// 注意：此时当前消息尚未落盘（message_end 早于 persistence），
	// 故用历史初始化聚合值后，本次费用直接取自 event.message。
	pi.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (ctx.model?.provider !== DEEPSEEK_PROVIDER) return;

		await ensurePricing(ctx);
		if (!pricing) return;

		const assistant = asUsageBearing(event.message);
		if (!assistant) return;
		if (assistant.provider !== DEEPSEEK_PROVIDER) return;

		if (!sessionReady) {
			buckets = await recomputeFromHistory(ctx.sessionManager);
			sessionReady = true;
		}

		const cost = await costOf(assistant.model, assistant.timestamp, assistant.usage ?? {});
		if (cost) addCost(buckets, cost.breakdown, cost.peak, false, tokenTiers(assistant.usage));

		// 时段与单价均用该条消息自身的模型与时间。
		refreshStatus(ctx.ui, cost?.peak ?? false, assistant.model);
	});
}
