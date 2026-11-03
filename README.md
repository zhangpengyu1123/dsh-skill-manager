# dsh-skill-manager · 技能面板

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 侧边栏的**技能管理**插件：在左侧导航新增「技能」入口，集中管理本机安装的 agent 技能。

> 适用于 DSH `0.2.x`（`@deepseek-ai/dsh` 系列，2026）。纯 JavaScript，无构建步骤、无运行时依赖。

## 功能

| 功能 | 说明 |
| --- | --- |
| 技能清单 | 汇总部署级 + 各 agent preset + 各工作项目的技能（含项目内 `.dsh/skills`、`.agents/skills`）；支持按名称搜索 |
| 调用统计 | 增量扫描会话日志，统计每个技能的历史调用次数；支持「刷新统计」 |
| 排序 | 默认按**调用次数**降序，可切换名称 / 安装时间 / 更新时间 |
| 筛选 | 状态（全部/已启用/已禁用/已绑定）、**标签（任一）**、**安装时间**（近 7/30/90 天/更早）、**更新时间** |
| AI 标签 | 闲时（所有会话空闲）批量让默认模型给每个技能生成 1–2 个中文标签；**每个技能只生成一次**，失败全局退避，最大限度节省 token |
| 手工标签 | 每个技能可增删自己的标签；AI 标签可一键隐藏（mute） |
| 启用 / 禁用 | 滑块开关。禁用后该技能立即从模型侧技能目录消失，`skill` 工具调用被拒绝 |
| 项目可见范围 | 把一个技能绑定到 1~N 个工作项目：只有这些项目里的会话能看到并调用它；不绑定 = 所有项目可见 |
| 安装 / 更新时间 | 记录每个技能文件的时间戳（创建/修改），用于展示与筛选 |
| 删除 | 仅用户/项目技能可删；内置（随 DSH 或插件包安装）技能受保护；删除移动到 `~/.dsh/skill-trash`，可手动恢复 |

## 安装

> 包名 `@local/dsh-skill-manager`：DSH 的本地/第三方插件命名；安装后侧边栏入口叫「技能」，Loader 行 id 为 `skill-manager`。

### 方式 A：DSH Web「插件」页（推荐）

1. 打开 DSH Web，左侧点击「插件」。
2. 点击「安装插件」，输入 Git 地址：
   ```text
   git+https://github.com/zhangpengyu1123/dsh-skill-manager.git
   ```
3. 安装完成后启用；左侧导航出现「技能」。

### 方式 B：CLI

```bash
dsh plugin --profile web add git+https://github.com/zhangpengyu1123/dsh-skill-manager.git
```

随后在 DSH Web「插件」页启用 `@local/dsh-skill-manager`。

### 方式 C：本地目录调试

```bash
dsh plugin --profile web add /path/to/dsh-skill-manager
```

并在「插件」页启用。

> 注意：浏览器端插件模块的 `id` 必须与包名完全一致。若你修改了包名，请同步修改 `client.js` 里 `window.__ModuleLoader__.load({ id })`，并硬刷新一次 DSH 页面（否则旧页面会报 “loaded without registering”）。

## 使用

1. 左侧栏点击「技能」。
2. 搜索 / 标签 / 时间 / 状态筛选 + 排序定位技能。
3. 行尾开关启用或禁用；「⋯」打开项目可见范围、标签编辑、删除。
4. 顶部「AI 标签」可立即触发一次批量打标签（空闲时也会自动进行）。

### 可见性规则

- 绑定值是工作区 id；解析技能目录时用会话的工作目录（cwd）匹配工作区：精确匹配优先，其次最长路径前缀（支持子目录、Windows 大小写不敏感）。
- 已绑定技能：cwd 命中绑定的工作区才可见；不属于任何工作区、或项目未绑定 → 隐藏。
- 未绑定技能：所有项目可见。

## 数据与隐私

- 状态：`<DSH_HOME>/skill-manager/state.json`（`DSH_HOME` 默认 `~/.dsh`），原子写、损坏自愈。
- 删除的技能进入 `<DSH_HOME>/skill-trash/`，不会真正销毁。
- AI 标签复用当前默认模型（`agentDefaultModel`），每次最多 8 个技能 / 300 输出 token，且只处理**尚未打过 AI 标签**的技能；失败会指数退避，不会反复消耗。
- 本地 HTTP 接口只监听回环地址（与 DSH 本机 Web 同姿态，无额外鉴权），请勿反向代理到公网。

## 开发

```bash
# 语法自检
node --check index.js
node --check client.js

# 本地安装（link 方式）后，修改 index.js 需要让 profile 重算一次（插件页禁用/启用）
```

结构：

- `index.js` — Host 半边：按 Agent 作用域注册技能门禁 provider、按工作区收集清单、会话日志统计、AI 打标、HTTP API、状态持久化。
- `client.js` — 浏览器半边：`window.__ModuleLoader__.load` 注册 `sidebar.panellist` 入口与 `main` 面板；纯 React + DSH 主题 token。
- `cordis.patch.yml` — 插件的 Loader 行（`id: skill-manager`）。
- `locale/*.json` — 插件展示元数据。

## English

A skills manager panel for the DSH Web sidebar. Browse every locally installed agent skill (deployment, preset, and per-project), see call counts from session logs, sort by calls/name/timestamps, filter by status/tags/install or update time, toggle skills on or off, scope a skill to one or more workspaces, edit tags (AI-generated or manual), and remove user/project skills to a trash directory. Built-in skills are protected.

Install from Git in the DSH **Plugins** page with:

```text
git+https://github.com/zhangpengyu1123/dsh-skill-manager.git
```

## License

MIT
