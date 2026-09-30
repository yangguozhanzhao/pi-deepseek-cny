# pi-deepseek-cny

[![CI](https://github.com/yangguozhanzhao/pi-deepseek-cny/actions/workflows/ci.yml/badge.svg)](https://github.com/yangguozhanzhao/pi-deepseek-cny/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-deepseek-cny.svg)](https://www.npmjs.com/package/pi-deepseek-cny)
[![license](https://img.shields.io/npm/l/pi-deepseek-cny.svg)](./LICENSE)

为 DeepSeek 用户优化的 [Pi](https://pi.dev) 扩展：在 footer 里常驻显示**人民币峰谷计价的费用统计**。

## 功能

在一个 footer 状态行里显示：

```
▲ miss ¥2.00 · hit ¥0.04 · out ¥8.00 ｜ total ¥0.05 = peak ¥0.01 + off-peak ¥0.03 = miss ¥0.01 + hit ¥0.00 + output ¥0.04 ｜ warm ¥0.00
```

分段含义：

| 段 | 内容 |
|---|---|
| `▲` / `▼` + 单价 | 当前时段图标（▲ 高峰 / ▼ 空闲）与该时段的三档单价（元 / 百万 tokens） |
| `total = peak + off-peak` | 总费用按时段拆分 |
| `= miss + hit + output` | 同一总费用按档位拆分（缓存未命中输入 / 缓存命中输入 / 输出） |
| `｜ warm` | `cache_warm` 预热调用费用，**不计入**上面的 total |

关键口径：

- 所有金额为**人民币元**，保留 2 位小数。
- 恒等式始终成立：`total = peak + off-peak = miss + hit + output`。
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

- `toolResult` 消息（数据结构不含 provider/model，无法归属）。

统计由两种方式得出：

- 启动时（`session_start`）扫描会话历史全量重算，因此**恢复旧会话也能正确累计**。
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
