# LiveAssets：把交互式用户指导编译成可执行的程序性记忆

[English README](./README.md)

---

## 最新更新

- **[2026/04/07]** **OpenClaw-LiveAsset** 正式发布。它是一个 OpenClaw 插件，能把用户在对话中的纠正沉淀成可复用、可执行的程序性资产，无需微调。

---

## 项目简介

**OpenClaw-LiveAsset** 想解决的问题很直接：用户明明已经把智能体教会了一次，但这些纠正往往不会在下一次对话里继续生效。LiveAssets 的做法，是把这些“做事方式”编译成可见、可编辑、可执行的 runtime 代码资产，让它们真正成为个人智能体的程序性记忆。

每个 LiveAsset 都是一个有边界的程序性对象，里面明确记录了匹配条件、输入控制、过程控制 和 输出控制。这样一来，用户纠正不仅能跨会话保留，还能在运行时以确定性的方式被触发和执行。当用户继续给出反馈时，LiveAssets 会更新对应代码资产，在 OpenClaw 中对原始 query 重新执行控制，并检查新结果是否真的修复了问题。整体设计受到 [ACT-R](http://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/526FSQUERY.pdf) 的启发。

这个仓库已经打包好一个可直接运行的 [OpenClaw](https://openclaw.ai) snapshot 和 LiveAsset 插件。`openclaw/` 是上游 runtime，`live_assets/` 是插件实现，所有本地 state 都放在 `.local/` 下。

### 核心特性

**把纠正变成看得见的 assets**：用户纠正不会被埋进 prompt 补丁或模型权重里，而是被保存为有边界、可直接编辑的 runtime assets。

**生成时先做验证**：系统会通过 Match Agent 和 Control Agent 编译多轮纠正，在 asset 落盘前验证并修复 matching logic。

**运行时确定性生效**：asset 不是“尽量遵循”的提示建议，而是结合 matching logic、input control、process control 和 output control 在运行时真正执行。

**反馈会形成闭环更新**：收到新反馈后，LiveAssets 会更新 asset、重新运行同一 query，并在保留修改前检查新结果是否更符合要求。

**提供可视化工作台**：内置 Web UI 可以查看 activation trace、直接编辑 asset，并在不手改 JSON 的情况下细化规则。

### 方法对比

下面这张表延续了技术报告里的分析框架，用来说明 LiveAssets 和常见个性化方法的差别。


| 方法         | 主要单元                | 程序逻辑 | 确定性约束  | 用户可见且可编辑 |
| ---------- | ------------------- | ---- | ------ | -------- |
| 记忆系统       | 事实与偏好               | 否    | 否      | 有限       |
| skill 模块   | Prompt 与工具白名单       | 有限   | 否      | 有限       |
| 基于训练的方法    | 模型权重                | 否    | 隐含在权重中 | 否        |
| LiveAssets | 有边界的 runtime assets | 是    | 是      | 是        |


---

## 快速开始

### 前置依赖

- Node.js `>=22.12.0`
- `pnpm`
- Python `3.11+`
- `curl`

### 1. 安装并配置

```bash
cp .env.example .env          # 配置你的 API Key
./scripts/bootstrap.sh
./scripts/check.sh
```

对于 preset demo，唯一必需的变量是 `OPENAI_API_KEY`。只有在使用 OpenAI 兼容接口时，才需要额外设置 `OPENAI_API_BASE_URL` 和 `OPENAI_MODEL`。仓库根目录下的脚本默认加载 `./.env`。如果想使用其他 env 文件，请设置 `ARTIFACT_ENV_PATH=/absolute/path/to/.env`。

### 2. 选择启动路径

如果你想最快跑起 demo，请执行：

```bash
./scripts/run-preset.sh
```

这会在 `.local/preset/` 下生成一套 preset 配置，把 `fixtures/assets/` 中的示例 assets 复制到 asset 目录，并启动带有 Control UI 和 `/live-assets/` 页面的 gateway。

支持的模式：

- **默认 OpenAI**：设置 `OPENAI_API_KEY`
- **OpenAI 兼容接口**：设置 `OPENAI_API_KEY`、`OPENAI_API_BASE_URL` 和 `OPENAI_MODEL`，其中模型名必须是该接口要求的原始 model ID

如果你想走完整的 OpenClaw 首次初始化流程，请执行：

```bash
./scripts/init-real.sh
./scripts/run-real.sh
```

`init-real.sh` 会在仓库本地的 `OPENCLAW_STATE_DIR` 和 `OPENCLAW_CONFIG_PATH` 下运行初始化向导，并把 `live_assets` 挂载进生成后的 config。

启动后，终端会打印本地的 Control UI 和 LiveAssets URL。之后你就可以直接和 agent 对话并给出纠正，LiveAsset 会在后台捕获这些 feedback。

### 3. 常用命令


| 任务                | 命令                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 停止 preset gateway | `OPENCLAW_STATE_DIR=.local/preset/state OPENCLAW_CONFIG_PATH=.local/preset/state/openclaw.json node openclaw/openclaw.mjs gateway stop` |
| 停止 real gateway   | `OPENCLAW_STATE_DIR=.local/real/state OPENCLAW_CONFIG_PATH=.local/real/state/openclaw.json node openclaw/openclaw.mjs gateway stop`     |
| 重置 preset 状态      | `ARTIFACT_RESET=1 ./scripts/run-preset.sh`                                                                                              |
| 重置 real 初始化状态     | `ARTIFACT_RESET=1 ./scripts/init-real.sh`                                                                                               |
| 源码改动后重建           | `ARTIFACT_FORCE_BOOTSTRAP=1 ./scripts/bootstrap.sh`                                                                                     |
| 仅重建 UI            | `pnpm --dir openclaw run ui:build`                                                                                                      |


---

## 致谢

OpenClaw-LiveAsset 构建于以下项目之上：

- [OpenClaw](https://openclaw.ai)：核心个人 AI 助手框架。

---

## 引用

如果你在学术工作中使用 OpenClaw-LiveAsset，请引用技术报告：

- [LiveAsset Technical Report](docs/LiveAsset_Blog_ming.pdf)

BibTeX 会在引用元数据确定后补充到这里。

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。