/**
 * DeepSeek 峰谷时段判断。
 *
 * 官方规则（中文定价页）：
 *   高峰时段 = 北京时间 周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00
 *   其余时段（含周末、中国法定节假日全天）为空闲时段。
 *
 * 注意：峰谷时段以北京时间（Asia/Shanghai）为准。
 */

const SHANGHAI_TZ = "Asia/Shanghai";

/** 高峰时段（北京时间，小时，左闭右开）：[9,12) 与 [14,18)。 */
const PEAK_HOUR_RANGES: ReadonlyArray<readonly [number, number]> = [
	[9, 12],
	[14, 18],
];

/** 北京时间的日期/时间/星期分解。 */
export interface BeijingParts {
	/** YYYY-MM-DD（北京时间） */
	date: string;
	/** 0=周日 … 6=周六（北京时间） */
	weekday: number;
	/** 小时 0-23（北京时间） */
	hour: number;
}

function toBeijingParts(time: Date): BeijingParts {
	// en-CA 输出 YYYY-MM-DD；weekday 用 en-US 的 short 名更稳。
	const date = new Intl.DateTimeFormat("en-CA", {
		timeZone: SHANGHAI_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(time);

	const hourStr = new Intl.DateTimeFormat("en-GB", {
		timeZone: SHANGHAI_TZ,
		hour: "2-digit",
		hour12: false,
	}).format(time);

	const weekdayStr = new Intl.DateTimeFormat("en-US", {
		timeZone: SHANGHAI_TZ,
		weekday: "short",
	}).format(time);

	const weekdayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};

	// en-GB 在部分实现里午夜会输出 "24"，归一为 0。
	let hour = Number.parseInt(hourStr, 10);
	if (hour === 24) hour = 0;

	return {
		date,
		weekday: weekdayMap[weekdayStr] ?? 0,
		hour,
	};
}

/** 是否周末（北京时间）。 */
export function isWeekend(parts: BeijingParts): boolean {
	return parts.weekday === 0 || parts.weekday === 6;
}

/** 是否处于高峰小时区间（不考虑周末/节假日）。 */
export function isPeakHour(parts: BeijingParts): boolean {
	return PEAK_HOUR_RANGES.some(([start, end]) => parts.hour >= start && parts.hour < end);
}

/**
 * 判断某个时刻是否为 DeepSeek 高峰时段。
 *
 * @param time 请求/消息时间
 * @param holidays 中国法定节假日集合（YYYY-MM-DD）。缺省表示无节假日信息（仅按工作日/周末判断）。
 */
export function isPeakTime(time: Date, holidays?: ReadonlySet<string>): boolean {
	const parts = toBeijingParts(time);
	if (isWeekend(parts)) return false;
	if (holidays?.has(parts.date)) return false;
	return isPeakHour(parts);
}

/** 导出内部的时间分解，供测试与其他模块复用。 */
export function getBeijingParts(time: Date): BeijingParts {
	return toBeijingParts(time);
}

// ---------------------------------------------------------------------------
// 中国法定节假日
// ---------------------------------------------------------------------------

/**
 * 已知的中国法定节假日（兜底数据，YYYY-MM-DD）。
 *
 * 数据源：`https://timor.tech/api/holiday/year/{year}/`（含调休放假安排）。
 * 运行时优先使用抓取结果；抓取失败时回退到本表（仅覆盖列出的年份）。
 */
const FALLBACK_HOLIDAYS: Record<number, readonly string[]> = {
	2025: [
		"2025-01-01",
		"2025-01-28",
		"2025-01-29",
		"2025-01-30",
		"2025-01-31",
		"2025-02-01",
		"2025-02-02",
		"2025-02-03",
		"2025-02-04",
		"2025-04-04",
		"2025-04-05",
		"2025-04-06",
		"2025-05-01",
		"2025-05-02",
		"2025-05-03",
		"2025-05-04",
		"2025-05-05",
		"2025-05-31",
		"2025-06-01",
		"2025-06-02",
		"2025-10-01",
		"2025-10-02",
		"2025-10-03",
		"2025-10-04",
		"2025-10-05",
		"2025-10-06",
		"2025-10-07",
		"2025-10-08",
	],
	2026: [
		"2026-01-01",
		"2026-01-02",
		"2026-01-03",
		"2026-02-15",
		"2026-02-16",
		"2026-02-17",
		"2026-02-18",
		"2026-02-19",
		"2026-02-20",
		"2026-02-21",
		"2026-02-22",
		"2026-02-23",
		"2026-04-04",
		"2026-04-05",
		"2026-04-06",
		"2026-05-01",
		"2026-05-02",
		"2026-05-03",
		"2026-05-04",
		"2026-05-05",
		"2026-06-19",
		"2026-06-20",
		"2026-06-21",
		"2026-09-25",
		"2026-09-26",
		"2026-09-27",
		"2026-10-01",
		"2026-10-02",
		"2026-10-03",
		"2026-10-04",
		"2026-10-05",
		"2026-10-06",
		"2026-10-07",
	],
};

/** 节假日抓取结果的返回形状（与 FALLBACK_HOLIDAYS 不同的字段名，便于测试区分）。*/
export interface HolidayFetchResult {
	/** 放假日（YYYY-MM-DD）。*/
	holidays: readonly string[];
}

/**
 * 解析 timor.tech 的响应为“放假日”列表。
 *
 * 响应形状：`{ holiday: { "MM-DD": { holiday: boolean, date: "YYYY-MM-DD" } } }`
 * 只保留 `holiday === true` 的日期（放假日）；`holiday === false` 是调休补班日，不算节假日。
 * 若提供了 year，则输出归一为完整 YYYY-MM-DD。
 */
export function parseTimorHolidays(raw: unknown, year?: number): string[] {
	const out: string[] = [];
	if (!raw || typeof raw !== "object") return out;
	const holiday = (raw as { holiday?: unknown }).holiday;
	if (!holiday || typeof holiday !== "object") return out;
	for (const value of Object.values(holiday as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as { holiday?: unknown; date?: unknown };
		if (entry.holiday !== true) continue;
		const date = typeof entry.date === "string" ? entry.date : undefined;
		if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.push(date);
	}
	if (year !== undefined) {
		return out.filter((d) => d.startsWith(`${year}-`));
	}
	return out;
}

/** 合并兜底表与抓取结果为一个节假日集合。 */
export function buildHolidaySet(year: number, fetched?: readonly string[]): Set<string> {
	const set = new Set<string>(FALLBACK_HOLIDAYS[year] ?? []);
	for (const d of fetched ?? []) set.add(d);
	return set;
}

/** 某天是否为已知的中国法定节假日。 */
export function isChineseHoliday(date: string, holidays: ReadonlySet<string>): boolean {
	return holidays.has(date);
}
