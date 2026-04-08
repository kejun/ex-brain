# ex-brain

CLI 个人知识库，基于 [seekdb](https://docs.seekdb.ai/) 构建，支持页面管理、混合检索、时间线、标签、导入导出与 MCP Server。

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
