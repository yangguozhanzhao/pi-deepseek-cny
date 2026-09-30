/**
 * 定价与节假日数据的加载（带落盘缓存 + 兜底）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type PricingTable,
	FALLBACK_PRICING,
	diffPricing,
	isEmptyDiff,
	parsePricingHtml,
} from "./pricing.ts";
import { buildHolidaySet, parseTimorHolidays } from "./peak-time.ts";

const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const HOLIDAY_URL = (year: number) => `https://timor.tech/api/holiday/year/${year}/`;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheFile {
	fetchedAt: number;
	data: unknown;
}

function cacheDir(): string {
	return join(getAgentDir(), "pi-deepseek-cny");
}

function cachePath(name: string): string {
	return join(cacheDir(), name);
}

function readCache<T>(name: string, ttlMs: number): T | undefined {
	try {
		const raw = readFileSync(cachePath(name), "utf-8");
		const parsed = JSON.parse(raw) as CacheFile;
		if (typeof parsed.fetchedAt !== "number") return undefined;
		if (Date.now() - parsed.fetchedAt > ttlMs) return undefined;
		return parsed.data as T;
	} catch {
		return undefined;
	}
}

function writeCache(name: string, data: unknown): void {
	try {
		mkdirSync(cacheDir(), { recursive: true });
		const payload: CacheFile = { fetchedAt: Date.now(), data };
		writeFileSync(cachePath(name), JSON.stringify(payload), "utf-8");
	} catch {
		// 缓存失败不影响功能
	}
}

async function fetchText(url: string): Promise<string | undefined> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				signal: controller.signal,
				headers: { "user-agent": "pi-deepseek-cny/0.1 (+https://pi.dev)" },
			});
			if (!res.ok) return undefined;
			return await res.text();
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return undefined;
	}
}

export interface LoadPricingResult {
	table: PricingTable;
	/** 与内置兜底表相比的变化（用于提醒）。 */
	changed: boolean;
}

/**
 * 加载定价表：优先抓取 → 失败读缓存 → 再失败用兜底。
 * @param ttlMs 缓存有效期
 */
export async function loadPricing(ttlMs: number = DEFAULT_TTL_MS): Promise<LoadPricingResult> {
	// 1) 有效缓存
	const cached = readCache<PricingTable>("pricing.json", ttlMs);
	if (cached) {
		return { table: cached, changed: false };
	}

	// 2) 抓取
	const html = await fetchText(PRICING_URL);
	if (html) {
		const parsed = parsePricingHtml(html);
		if (Object.keys(parsed).length > 0) {
			writeCache("pricing.json", parsed);
			const diff = diffPricing(FALLBACK_PRICING, parsed);
			return { table: parsed, changed: !isEmptyDiff(diff) };
		}
	}

	// 3) 过期缓存
	const stale = readCache<PricingTable>("pricing.json", Number.POSITIVE_INFINITY);
	if (stale && Object.keys(stale).length > 0) {
		return { table: stale, changed: false };
	}

	// 4) 兜底
	return { table: FALLBACK_PRICING, changed: false };
}

/** 加载某年的节假日集合：优先抓取 → 失败读缓存 → 再失败用内置兜底。 */
export async function loadHolidays(year: number, ttlMs: number = DEFAULT_TTL_MS): Promise<Set<string>> {
	const name = `holidays-${year}.json`;
	const cached = readCache<string[]>(name, ttlMs);
	if (cached) return buildHolidaySet(year, cached);

	const text = await fetchText(HOLIDAY_URL(year));
	if (text) {
		const raw = JSON.parse(text) as unknown;
		const list = parseTimorHolidays(raw, year);
		if (list.length > 0) {
			writeCache(name, list);
			return buildHolidaySet(year, list);
		}
	}

	const stale = readCache<string[]>(name, Number.POSITIVE_INFINITY);
	if (stale) return buildHolidaySet(year, stale);

	return buildHolidaySet(year);
}
