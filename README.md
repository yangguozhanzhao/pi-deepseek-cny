# pi-deepseek-cny

[![CI](https://github.com/yangguozhanzhao/pi-deepseek-cny/actions/workflows/ci.yml/badge.svg)](https://github.com/yangguozhanzhao/pi-deepseek-cny/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-deepseek-cny.svg)](https://www.npmjs.com/package/pi-deepseek-cny)
[![license](https://img.shields.io/npm/l/pi-deepseek-cny.svg)](./LICENSE)

为 DeepSeek 用户优化的 [Pi](https://pi.dev) 扩展：在 footer 里常驻显示**人民币峰谷计价的费用统计**。

## 功能

在一个 footer 状态行里显示：

```
峰 ¥2.00/¥0.04/¥8.00 ｜¥0.35 + ¥0.35 + ¥0.46 = 峰¥0.63 + 谷¥0.53 = 总¥1.16｜¥9.92/亿|¥0.04/轮|
```

分段含义：

| 段 | 内容 |
|---|---|
| `峰` / `谷` | 当前时段：`峰` = 高峰（红色），`谷` = 空闲（绿色）|
| `¥a/¥b/¥c` | 当前时段的三档挂牌单价（元 / 百万 tokens），顺序固定为 miss / hit / out |
| `¥x + ¥y + ¥z` | 本期三档费用（未命中输入 + 缓存命中输入 + 输出）|
| `= 峰… + 谷…` | 同一总费用按时段拆分 |
| `= 总…` | 本期总费用（人民币）|
| `｜¥n/亿` | 本期均价：总费用 ÷ 总 token × 1 亿（总 token = 未命中输入 + 缓存命中输入 + 输出，不含 cache_warm）|
| `｜¥n/轮` | 本期每轮均价：总费用 ÷ 轮数（一个 user 消息到下一个 user 消息之前 = 1 轮）|

关键口径：

- 所有金额为**人民币元**，保留 2 位小数。
- 恒等式始终成立：`三档之和 = 峰 + 谷 = 总`（对应 `total = peak + off-peak = miss + hit + output`）。
- **三档 token 与均价同源**：`总 token = miss + hit + out`（不含 cache_warm），均价分母即此值，不重复统计。
- **¥n/亿**：`总费用 ÷ 总 token × 1e8`；无 token 时为 ¥0.00。
- **¥n/轮**：`总费用 ÷ 轮数`；无轮时为 ¥0.00。
- `cache_warm` 完全独立，不参与总额与各档统计。
- **不改写 pi 落盘的 `usage.cost`**：pi 自身的费用记录保持原样，本扩展只在 footer 重新计算展示。

## 计价规则

- **单价**：抓取 DeepSeek 中文定价页 `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`，每天更新一次；抓取失败时回退本地缓存，再失败用内置兜底表。
- **峰谷**：北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为高峰，其余（含周末、法定节假日全天）为空闲。
- **每条调用按自身时间判定峰谷**，因此跨时段的历史消息会各自按当时的单价计算。
- 节假日数据来自 `https://timor.tech/api/holiday/year/{year}/`，按年缓存。

## 统计范围

计入费用：

- `provider === "deepseek"` 的 **assistant 消息**（每次调用都计费，即使 token 为 0）。
- `provider === "deepseek"` 的 **`usage` 条目**（如 `cache_warm`）。

不计入：

- `toolResult` 消息（其 `usage` 为工具内嵌模型调用，且消息不带 provider/model，无法可靠归属到 deepseek）。

统计由两种方式得出：

- 启动时（`session_start`）扫描**当前分支**（`getBranch()`）全量重算，因此**恢复旧会话也能正确累计**，且不会重复计入编辑/重试产生的废弃分支。
- 之后每条消息结束时（`message_end`）增量累加。

## 安装

```bash
pi install npm:pi-deepseek-cny
```

或在项目中通过 Pi 的扩展配置引入 `./extensions/index.ts`。

## 开发

```bash
npx tsc --noEmit   # 类型检查
npm test           # 单元测试
```

## 结构

```
extensions/index.ts   扩展入口：footer 状态行、事件处理
src/cost.ts           人民币峰谷计费（computeCost / selectRates）
src/pricing.ts        定价表解析、旧模型名映射、变化检测
src/data.ts           定价与节假日的抓取 + 缓存 + 兜底
src/peak-time.ts      峰谷时段判断与节假日解析
```
