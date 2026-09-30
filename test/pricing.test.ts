import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	diffPricing,
	FALLBACK_PRICING,
	getModelPricing,
	isEmptyDiff,
	normalizeModelName,
	parsePricingHtml,
} from "../src/pricing.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("parsePricingHtml: 解析真实页面快照", () => {
	const html = readFileSync(join(__dirname, "fixtures-pricing.html"), "utf-8");
	const t = parsePricingHtml(html);
	assert.deepEqual(t, FALLBACK_PRICING);
});

test("parsePricingHtml: 空/垃圾输入返回空表", () => {
	assert.deepEqual(parsePricingHtml(""), {});
	assert.deepEqual(parsePricingHtml("<html><body>nothing</body></html>"), {});
});

test("parsePricingHtml: 最小合成表", () => {
	const html = `
	<table>
	<tr><td>模型</td><td>deepseek-a</td><td>deepseek-b</td></tr>
	<tr><td>百万tokens输入 （缓存命中）</td><td>空闲时段</td><td>1元</td><td>2元</td></tr>
	<tr><td>高峰时段</td><td>3元</td><td>4元</td></tr>
	<tr><td>百万tokens输出</td><td>空闲时段</td><td>5元</td><td>6元</td></tr>
	<tr><td>高峰时段</td><td>7元</td><td>8元</td></tr>
	</table>`;
	const t = parsePricingHtml(html);
	assert.equal(t["deepseek-a"]?.cacheHit.offPeak, 1);
	assert.equal(t["deepseek-a"]?.cacheHit.peak, 3);
	assert.equal(t["deepseek-b"]?.cacheHit.offPeak, 2);
	assert.equal(t["deepseek-a"]?.output.peak, 7);
	assert.equal(t["deepseek-b"]?.output.offPeak, 6);
});

test("normalizeModelName: 旧名映射", () => {
	assert.equal(normalizeModelName("deepseek-v4-flash"), "deepseek-flash");
	assert.equal(normalizeModelName("deepseek-chat"), "deepseek-v4-pro");
	assert.equal(normalizeModelName("deepseek-flash"), "deepseek-flash");
	assert.equal(normalizeModelName("unknown-model"), "unknown-model");
});

test("getModelPricing: 直接名与别名", () => {
	assert.equal(getModelPricing(FALLBACK_PRICING, "deepseek-flash")?.output.peak, 8);
	assert.equal(getModelPricing(FALLBACK_PRICING, "deepseek-v4-flash")?.output.peak, 8);
	assert.equal(getModelPricing(FALLBACK_PRICING, "nope"), undefined);
});

test("diffPricing: 变化检测", () => {
	const prev = { a: FALLBACK_PRICING["deepseek-flash"]! };
	const curr = {
		a: FALLBACK_PRICING["deepseek-flash"]!,
		b: FALLBACK_PRICING["deepseek-v4-pro"]!,
	};
	const d = diffPricing(prev, curr);
	assert.deepEqual(d.added, ["b"]);
	assert.deepEqual(d.removed, []);
	assert.equal(isEmptyDiff(d), false);

	const changed = { a: { ...FALLBACK_PRICING["deepseek-flash"]!, output: { offPeak: 9, peak: 9 } } };
	const d2 = diffPricing(prev, changed);
	assert.deepEqual(d2.changed, ["a"]);
});

test("diffPricing: 相同表为空差异", () => {
	assert.equal(isEmptyDiff(diffPricing(FALLBACK_PRICING, FALLBACK_PRICING)), true);
});
