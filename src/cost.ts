/**
 * DeepSeek 人民币峰谷计费。
 *
 * 根据 token 用量、峰谷标志与单价，计算费用（人民币元）。
 */
import type { ModelPricing } from "./pricing.ts";

/** 计费所需的 token 用量（与 pi 的 Usage 对齐，仅取需要的字段）。 */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 费用明细（人民币元）。 */
export interface CostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** 单价（元 / 百万 tokens）。 */
export interface Rates {
	input: number;
	output: number;
	cacheRead: number;
}

/**
 * 选取某模型在某峰谷状态下的单价。
 *
 * 注意：DeepSeek 官方把输入分为「缓存命中」与「缓存未命中」两档：
 * - `cacheRead` 走命中价
 * - `input`（未命中部分）走未命中价
 * - `cacheWrite`：DeepSeek 不单独计价，按未命中输入计（与 pi 的 cacheWrite 行为对齐的处理）。
 */
export function selectRates(pricing: ModelPricing, isPeak: boolean): Rates {
	const period = isPeak ? "peak" : "offPeak";
	return {
		input: pricing.cacheMiss[period],
		output: pricing.output[period],
		cacheRead: pricing.cacheHit[period],
	};
}

/**
 * 计算一次请求的费用。
 *
 * @param usage token 用量
 * @param rates 单价（元 / 百万 tokens）
 */
export function computeCost(usage: TokenUsage, rates: Rates): CostBreakdown {
	const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;

	const input = perMillion(usage.input, rates.input);
	const output = perMillion(usage.output, rates.output);
	const cacheRead = perMillion(usage.cacheRead, rates.cacheRead);
	// DeepSeek 不单独计缓存写入；按未命中输入价计。
	const cacheWrite = perMillion(usage.cacheWrite, rates.input);

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
}
