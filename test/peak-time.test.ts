import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildHolidaySet,
	getBeijingParts,
	isPeakHour,
	isPeakTime,
	isWeekend,
	parseTimorHolidays,
} from "../src/peak-time.ts";

// 构造北京时间某一时刻的 UTC Date。
// 北京时间 = UTC+8，所以 北京 10:00 = UTC 02:00。
function beijing(iso: string): Date {
	return new Date(iso);
}

test("getBeijingParts: 时区与星期解析", () => {
	// 2026-09-30 是周三
	const p = getBeijingParts(new Date("2026-09-30T02:00:00Z")); // 北京 10:00
	assert.equal(p.date, "2026-09-30");
	assert.equal(p.weekday, 3); // Wed
	assert.equal(p.hour, 10);
});

test("getBeijingParts: 午夜归一为 0", () => {
	const p = getBeijingParts(new Date("2026-09-30T16:00:00Z")); // 北京次日 00:00
	assert.equal(p.date, "2026-10-01");
	assert.equal(p.hour, 0);
});

test("isWeekend: 周六周日", () => {
	// 2026-10-03 周六，2026-10-04 周日
	assert.equal(isWeekend(getBeijingParts(new Date("2026-10-03T02:00:00Z"))), true);
	assert.equal(isWeekend(getBeijingParts(new Date("2026-10-04T02:00:00Z"))), true);
	// 2026-09-30 周三
	assert.equal(isWeekend(getBeijingParts(new Date("2026-09-30T02:00:00Z"))), false);
});

test("isPeakHour: 9-12 与 14-18 区间", () => {
	const at = (h: number) => isPeakHour({ date: "2026-09-30", weekday: 3, hour: h });
	assert.equal(at(8), false);
	assert.equal(at(9), true); // 左闭
	assert.equal(at(11), true);
	assert.equal(at(12), false); // 右开
	assert.equal(at(13), false);
	assert.equal(at(14), true);
	assert.equal(at(17), true);
	assert.equal(at(18), false); // 右开
});

test("isPeakTime: 工作日峰谷", () => {
	// 2026-09-30 周三
	assert.equal(isPeakTime(beijing("2026-09-30T02:00:00Z")), true); // 北京 10:00
	assert.equal(isPeakTime(beijing("2026-09-30T04:30:00Z")), false); // 北京 12:30
	assert.equal(isPeakTime(beijing("2026-09-30T07:00:00Z")), true); // 北京 15:00
	assert.equal(isPeakTime(beijing("2026-09-30T00:00:00Z")), false); // 北京 08:00
});

test("isPeakTime: 周末全天空闲", () => {
	// 2026-10-03 周六
	assert.equal(isPeakTime(beijing("2026-10-03T02:00:00Z")), false); // 北京 10:00 周六
});

test("isPeakTime: 法定节假日全天空闲", () => {
	// 2026-10-01 国庆，周四
	const holidays = buildHolidaySet(2026);
	assert.equal(isPeakTime(beijing("2026-10-01T02:00:00Z"), holidays), false); // 北京 10:00 但节假日
	// 对照：同周的不同日 2026-09-30 周三 10:00 应为高峰
	assert.equal(isPeakTime(beijing("2026-09-30T02:00:00Z"), holidays), true);
});

test("parseTimorHolidays: 只取放假日，排除调休补班", () => {
	const raw = {
		holiday: {
			"01-01": { holiday: true, date: "2025-01-01" },
			"01-26": { holiday: false, date: "2025-01-26" }, // 调休补班
			"01-28": { holiday: true, date: "2025-01-28" },
		},
	};
	const got = parseTimorHolidays(raw, 2025);
	assert.deepEqual(got.sort(), ["2025-01-01", "2025-01-28"]);
});

test("parseTimorHolidays: 容错", () => {
	assert.deepEqual(parseTimorHolidays(null), []);
	assert.deepEqual(parseTimorHolidays({}), []);
	assert.deepEqual(parseTimorHolidays({ holiday: "x" }), []);
});

test("buildHolidaySet: 兜底+抓取合并", () => {
	const s = buildHolidaySet(2025, ["2025-12-25"]);
	assert.equal(s.has("2025-01-01"), true); // 兜底表
	assert.equal(s.has("2025-12-25"), true); // 抓取补充
});
