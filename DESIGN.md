# Codex 设计语言 → WeMail 主题规格

来源：OpenAI Codex 官网页面 + 产品 UI 截图的 Firecrawl 提取（2025-11）。
证据存于 `.firecrawl/`（branding JSON + 产品截图 PNG）。

## 提取结论（Codex 真实风格）

### 色彩 — 近单色，色彩只用于语义
| 角色 | 值 | 来源 |
|---|---|---|
| 主色 / 强调 | `#000000`（营销）/ `#181818`（文档站） | branding.primary |
| 画布 | `#FFFFFF` | branding.background |
| 次级文字 | `#5D5D5D`–`#6E6E6E` | branding.textPrimary + 截图 |
| 三级/元信息 | `#8E8E93`–`#A0A6AD` | 截图（日期、行号、非激活 Tab） |
| 次级表面（卡片/气泡/代码片） | `#EFEFEF`–`#F5F5F5` | 截图 |
| 边框 | `#E4E4E7`–`#ECECEC`，统一 1px hairline | 截图 |
| 终端覆盖层（唯一深色面） | `#1C1C1E` 底 / `#EDEDED` 字 | 截图 |

**原则：无装饰性品牌色。** 颜色 = 元数据（diff 红绿、状态徽章），采用 GitHub 语义色：
绿 `#1A7F37`、红 `#CF222E`、警告 `#9A6700`、蓝 `#0550AE`。

### 形状
- 4px 基础网格；卡片 ~10–12px 圆角；内联代码片 5–6px；徽章/按钮全圆胶囊（999px）
- **按钮：主 = 黑底白字胶囊；次 = `#F5F5F5` 底黑字胶囊；无阴影**

### 分层
- 应用内部完全扁平：容器靠 1px 边框或灰度色差区分，不加阴影
- 阴影只出现在真正的浮层（模态、终端覆盖层）

### 字体
- OpenAI Sans（专有）≈ Inter/Söhne 级几何 grotesque；正文 400，标题 600
- **规则：代码/路径/终端一律 mono，其余 sans** —— mono/sans 承担层级
- 密度：编辑式留白，卡片 padding ~16px，列表行距 ~8–10px

## WeMail token 映射（`themes/codex.css`）

| WeMail token | 值 | 说明 |
|---|---|---|
| `--color-canvas` / `--color-paper` / `--color-paper-2` | `#ffffff` | 纯白画布，卡片靠边框 |
| `--color-paper-3` | `#f5f5f5` | 浮动 chrome（侧栏/Agent/草稿） |
| `--color-paper-4` | `#ececec` | chrome 悬停/激活 |
| `--color-summary-surface` / `--color-workbench-surface` | `#fafafa` / `#ffffff` | |
| `--color-sidebar(-hover/-active)` | `#fafafa` / `#f0f0f0` / `#ececec` | |
| `--color-ink` / `ink-2` / `ink-3` / `ink-4` | `#0d0d0d` / `#444444` / `#616165` / `#8e8e93` | |
| `--color-edge` / `edge-2` / `edge-3` | `#e9e9e9` / `#d9d9d9` / `#f3f3f3` | hairline |
| `--color-coral*`（品牌强调） | `#0d0d0d`（bg → `#f0f0f0`） | 强调色降为近黑 |
| `--color-green/red/blue/amber` | GitHub 语义色（见上） | 保留，用于状态 |
| `--color-term-*` | `#1c1c1e` 底 / `#ededed` 字 / GitHub 终端色 | 中性炭黑 |
| `--color-focus` | `#0d0d0d` | |
| `--shadow-*` | 中性 `rgba(0,0,0,…)` | 浮层保留，组件层扁平 |

## 应用策略
- 新增第四主题 `codex`（`data-theme="codex"`），opt-in；`system` 的浅色解析指向 codex，
  使默认外观即黑白灰；`paper`（暖石色）保留可回退。
- 纯 token 覆盖，不改组件。深色主题已是中性灰，仅存个别暖色残留，本次不动。
