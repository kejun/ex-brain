# ex-brain

CLI 个人知识库，基于 [seekdb](https://docs.seekdb.ai/) 构建，支持页面管理、混合检索、时间线、标签、导入导出与 MCP Server。

## 核心功能

- **知识图谱可视化** - 交互式图谱，展示实体关联关系
- **智能编译** - 语义分析，智能更新 Compiled Truth
- **时间线管理** - 自动提取事件，记录历史演变
- **混合检索** - 全文搜索 + 向量语义查询
- **实体链接** - 自动识别实体，创建关联页面

<img src="https://mdn.alipayobjects.com/huamei_ytl0i7/afts/img/A*TqdfTZ-yCPwAAAAAgBAAAAgAejCYAQ/original" width="800">

## 数据采集

推荐使用 [MarkSnip](https://chromewebstore.google.com/detail/kcbaglhfgbkjdnpeokaamjjkddempipm) 作为数据采集工具：

- 一键剪藏网页为 Markdown 格式
- 支持代码块、表格、数学公式
- 本地处理，隐私友好
- 支持 Obsidian 集成

配合 ex-brain 使用：

```bash
# MarkSnip 剪藏后，导入到知识库
cat article.md | ebrain put articles/slug --stdin

# 或智能编译
ebrain compile companies/river-ai --file article.md --source web_clip
```

## 安装

```bash
# 全局安装（需要 Bun 或 Node.js）
bun install -g ex-brain
# 或
npm install -g ex-brain

ebrain --help
```

## 快速开始

```bash
# 初始化（自动创建 ~/.ebrain/data/ebrain.db）
ebrain init

# 写入页面
ebrain put my/note --file note.md

# 知识图谱可视化
ebrain graph                    # 启动图谱 Web UI (http://localhost:3000)
ebrain graph --port 8080 --open # 指定端口并自动打开浏览器

# 智能编译新信息
ebrain compile companies/river-ai "River AI completed Series A funding" --source meeting_notes

# 从页面提取时间线事件
ebrain timeline extract companies/river-ai

# 检索
ebrain search "某主题"
ebrain query "某问题"

# 启动 MCP Server（供 AI 工具调用）
ebrain serve
```

## 配置

编辑 `~/.ebrain/settings.json`：

```jsonc
{
  "db": { "path": "~/.ebrain/data/ebrain.db" },
  "embed": {
    "provider": "hash",          // 或 "openai_compatible"
    "baseURL": "...",
    "model": "...",
    "dimensions": 1024,
    "apiKey": "sk-..."
  }
}
```

运行 `ebrain config` 查看当前生效配置。详见 [docs/ebrain-cli.md](docs/ebrain-cli.md)。

## 开发

```bash
bun install
bun run src/cli.ts --help
bun test
```
