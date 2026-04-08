# ebrain CLI（Bun + seekdb-js）

`ebrain` 是一个本地优先的个人知识库 CLI，基于 `seekdb-js` 嵌入模式构建，支持页面管理、混合检索、时间线、标签、导入导出与 MCP Server。

## 安装与运行

### 全局安装（推荐）

```bash
bun install -g ex-brain    # 或 npm install -g ex-brain
ebrain --help
```

### 本地开发

```bash
bun install
bun run src/cli.ts --help
```

## 配置

### `~/.ebrain/settings.json`（推荐）

所有配置集中管理，首次运行自动使用默认值。可用 `ebrain config` 查看当前生效配置。

```jsonc
{
  "db": {
    "path": "~/.ebrain/data/ebrain.db",   // 本地模式（默认路径）
    "remote": {                             // 填了 host 即启用远程模式
      "host": "127.0.0.1",
      "port": 3306,
      "user": "ebrain",
      "password": "",
      "database": "ebrain",
      "tenant": ""
    }
  },
  "embed": {
    "provider": "hash",                     // "hash" | "openai_compatible"
    "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "text-embedding-v4",
    "dimensions": 1024,
    "apiKey": "",                           // 直接写 key（不建议，留空走 apiKeyEnv）
    "apiKeyEnv": "DASHSCOPE_API_KEY"        // 从环境变量读取 key
  },
  "llm": {
    "baseURL": "https://coding.dashscope.aliyuncs.com/v1",
    "model": "qwen-plus",
    "apiKey": "",                           // 直接写 key（不建议，留空走 apiKeyEnv）
    "apiKeyEnv": "DASHSCOPE_API_KEY"        // 从环境变量读取 key
  }
}
```

### 优先级

**CLI 参数 `--db`** > **环境变量 `EBRAIN_*`** > **`~/.ebrain/settings.json`** > **代码默认值**

### 环境变量（向后兼容）

环境变量仍然可用，且会**覆盖** settings.json 中的对应值。

| 变量 | 说明 |
|------|------|
| `EBRAIN_SEEKDB_HOST` | 远程 seekdb 主机（存在即启用远程模式） |
| `EBRAIN_SEEKDB_PORT` | 端口（默认 3306） |
| `EBRAIN_SEEKDB_USER` | 用户名（默认 root） |
| `EBRAIN_SEEKDB_PASSWORD` | 密码 |
| `EBRAIN_SEEKDB_DATABASE` | 数据库名（默认 ebrain） |
| `EBRAIN_SEEKDB_TENANT` | 租户 |
| `EBRAIN_EMBED_PROVIDER` | `hash`（默认）或 `openai_compatible` |
| `EBRAIN_EMBED_BASE_URL` | 嵌入 API 路径 |
| `EBRAIN_EMBED_MODEL` | 嵌入模型名 |
| `EBRAIN_EMBED_DIMENSIONS` | 输出维度 |
| `EBRAIN_EMBED_API_KEY` | 直接写入 Key |
| `EBRAIN_EMBED_API_KEY_ENV` | Key 所在环境变量名（默认 `DASHSCOPE_API_KEY`） |

### 嵌入服务（embedding）

- **默认**（`hash`）：确定性本地 Hash 向量（384 维），无网络依赖。
- **`openai_compatible`**：使用 OpenAI 兼容 API（如 DashScope 千问 `text-embedding-v4`，1024 维）。
- 若选了 `openai_compatible` 但未提供 Key，CLI 会**警告并回退**到 hash。
- 从 **Hash（384 维）** 切换到真实模型时，已有集合维度不一致，需**删除本地库重建**。

### LLM（大语言模型）

- `llm.baseURL`：OpenAI 兼容的聊天 API 端点。
- `llm.model`：模型名（默认 `qwen-plus`）。
- `llm.apiKey` / `llm.apiKeyEnv`：密钥配置方式与 embed 相同。
- 嵌入（embed）和 LLM 使用**独立的 baseURL 和 API Key**，互不干扰。

### 嵌入进程退出码（macOS 等）

- `seekdb` 嵌入原生库在**进程退出**时可能返回 **139 (SIGSEGV)**，但 JSON 输出仍完整。
- 若需稳定 **0 退出码**，请改用远程库（设置 `EBRAIN_SEEKDB_HOST` 或 settings.json 中的 `db.remote.host`）。

构建单文件 bundle（可选，仅用于本地调试）：

```bash
bun run build
bun run dist/cli.js --help
```

## 核心命令

- `ebrain config` — 查看当前生效的配置
- `ebrain put <slug> --file <path>`（也支持 `--stdin`，幂等 upsert）
- `ebrain get <slug>`（`--json` 输出结构化数据）
- `ebrain delete <slug>`（新增，支持 `--dry-run`）
- `ebrain list [--type person] [--tag yc]`
- `ebrain search <query>`
- `ebrain query <question>`
- `ebrain link <from> <to> [--context "..."]`（幂等）
- `ebrain backlinks <slug>`
- `ebrain timeline list <slug>`
- `ebrain timeline add <slug> --date YYYY-MM-DD --summary "..."`
- `ebrain tag list <slug>`
- `ebrain tag add <slug> <tag>`（幂等）
- `ebrain tag remove <slug> <tag>`
- `ebrain raw get <slug> [--source x]`
- `ebrain raw set <slug> --source x --data '{"a":1}'`（也支持 `--stdin`）
- `ebrain import <dir>`（支持 `--dry-run` 预览）
- `ebrain export --dir <dir>`
- `ebrain ingest [file] [--type doc]`（支持 `--stdin`）
- `ebrain embed <slug>` / `ebrain embed --all`
- `ebrain init`
- `ebrain stats`
- `ebrain serve`
- `ebrain tools-json`

> 旧命令名 `timeline`、`timeline-add`、`tags`、`tag`、`untag` 保留为隐藏别名，向后兼容。

## 设计原则

- **零交互**：所有输入通过 flag 或 stdin，智能体可安全调用
- **幂等**：`put`、`link`、`tag add` 等操作重复执行不产生副作用
- **--dry-run**：所有写操作支持预览，不实际修改数据
- **--stdin**：`put`、`ingest`、`raw set` 支持管道输入
- **结构化输出**：`--json` 统一输出 JSON，智能体可解析
- **快速失败**：缺少必要参数时立即报错并给出正确用法示例
- **命令可预测**：`timeline list`/`tag list`/`raw get` 遵循 `resource verb` 模式


## 数据模型

关系表：
- `pages`
- `links`
- `timeline_entries`
- `page_tags`
- `raw_data`
- `ingest_log`

检索集合：
- `ebrain_pages`（用于向量/全文混合检索）

## MCP 配置示例

默认模式（无需 `--db`，自动使用 `~/.ebrain/data/ebrain.db`）：

```json
{
  "mcpServers": {
    "ebrain": {
      "command": "ebrain",
      "args": ["serve"]
    }
  }
}
```

指定路径：

```json
{
  "mcpServers": {
    "ebrain": {
      "command": "ebrain",
      "args": ["serve", "--db", "/absolute/path/to/ebrain.db"]
    }
  }
}
```

## 参考

- [seekdb 概览](https://docs.seekdb.ai/seekdb/seekdb-overview/)
