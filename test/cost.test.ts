import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCost, selectRates } from "../src/cost.ts";
import { FALLBACK_PRICING } from "../src/pricing.ts";

const flash = FALLBACK_PRICING["deepseek-flash"]!;
const pro = FALLBACK_PRICING["deepseek-v4-pro"]!;

test("selectRates: 峰谷选取", () => {
	const off = selectRates(flash, false);
	assert.equal(off.input, 1);
	assert.equal(off.output, 4);
	assert.equal(off.cacheRead, 0.02);

	const peak = selectRates(flash, true);
	assert.equal(peak.input, 2);
	assert.equal(peak.output, 8);
	assert.equal(peak.cacheRead, 0.04);
});

test("selectRates: pro 模型", () => {
	const peak = selectRates(pro, true);
	assert.equal(peak.input, 9);
	assert.equal(peak.output, 27);
	assert.equal(peak.cacheRead, 0.3);
});

test("computeCost: 全缓存命中（空闲）", () => {
	// 1M cacheRead → 0.02 元
	const c = computeCost({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, selectRates(flash, false));
	assert.equal(c.cacheRead, 0.02);
	assert.equal(c.total, 0.02);
});

test("computeCost: 缓存未命中输入（高峰）", () => {
	// 1M input → 2 元（flash 高峰未命中）
	const c = computeCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, selectRates(flash, true));
	assert.equal(c.input, 2);
	assert.equal(c.total, 2);
});

test("computeCost: 输出", () => {
	// 1M output → 8 元（flash 高峰输出）
	const c = computeCost({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, selectRates(flash, true));
	assert.equal(c.output, 8);
});

test("computeCost: 混合用量", () => {
	const usage = { input: 1602, output: 75, cacheRead: 500, cacheWrite: 0 };
	const c = computeCost(usage, selectRates(flash, true));
	// input: 1602/1e6*2
	assert.ok(Math.abs(c.input - (1602 / 1e6) * 2) < 1e-12);
	// output: 75/1e6*8
	assert.ok(Math.abs(c.output - (75 / 1e6) * 8) < 1e-12);
	// cacheRead: 500/1e6*0.04
	assert.ok(Math.abs(c.cacheRead - (500 / 1e6) * 0.04) < 1e-12);
	assert.ok(Math.abs(c.total - (c.input + c.output + c.cacheRead + c.cacheWrite)) < 1e-12);
});

test("computeCost: cacheWrite 按未命中输入价计", () => {
	const c = computeCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, selectRates(flash, false));
	assert.equal(c.cacheWrite, 1); // 空闲未命中价 = 1
});
