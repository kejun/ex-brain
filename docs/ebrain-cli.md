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
  },
  "extraction": {
    "confidenceThreshold": 0.7              // 实体提取置信度阈值 (0~1)，低于此值的关系将被忽略
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
| `EBRAIN_CONFIDENCE_THRESHOLD` | 实体提取置信度阈值 (0~1，默认 `0.7`) |

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

### 实体提取配置

- `extraction.confidenceThreshold`：实体关系置信度阈值（0~1），默认 `0.7`。
  - LLM 提取的实体关系置信度低于此值时将被忽略。
  - 可通过环境变量 `EBRAIN_CONFIDENCE_THRESHOLD` 覆盖。
  - 调高 → 更精准但可能遗漏实体；调低 → 更全面但可能产生误报。

### 智能编译（Intelligent Compile）

`ebrain compile` 和 `ebrain smart-ingest` 提供智能化的知识录入流程：

- **`ebrain compile <slug> <info>`**：将新信息智能编译到指定页面的 `compiled truth` 中，自动合并、去重、更新。
- **`ebrain smart-ingest [slug]`**：完整智能录入流程，依次执行：
  1. 编译 truth（智能合并信息到页面）
  2. 提取时间线事件（自动识别日期和关键事件）
  3. 创建实体链接（自动识别相关实体并建立关联页面）

两个命令都依赖 LLM 配置，未配置时会跳过 AI 步骤并给出提示。

### `query --llm` 多层上下文

`ebrain query --llm "问题"` 使用多层上下文构建丰富的检索结果：

1. **语义搜索** — 找到与问题最匹配的页面
2. **多层上下文收集**：
   - **页面内容** — 每个匹配页面的 compiled truth + timeline
   - **原始文档** — 通过 `raw set` 存储的原始导入文档
   - **关联页面** — 入链和出链页面，按与问题的语义相关性过滤
3. **LLM 合成** — 生成带 `[[slug|title]]` 引用的来源标注回答

使用 `--context-limit N` 控制纳入上下文的页面数量（默认 5）。

### 嵌入进程退出码（macOS 等）

- `seekdb` 嵌入原生库在**进程退出**时可能返回 **139 (SIGSEGV)**，但 JSON 输出仍完整。
- 若需稳定 **0 退出码**，请改用远程库（设置 `EBRAIN_SEEKDB_HOST` 或 settings.json 中的 `db.remote.host`）。

### 查询安全（Query Sanitizer）

- 所有搜索查询在进入 seekdb 前会自动清理特殊字符（单引号、双引号、反斜杠、控制字符等），防止 JSON 解析错误。
- 当向量搜索失败时，自动回退到 SQL LIKE 搜索，确保操作不中断。

构建单文件 bundle（可选，仅用于本地调试）：

```bash
bun run build
bun run dist/cli.js --help
```

## 核心命令

- `ebrain config` — 查看当前生效的配置
- `ebrain put <slug> --file <path>`（也支持 `--stdin`，幂等 upsert；省略 slug 时自动生成）
- `ebrain get <slug>`（`--json` 输出结构化数据）
- `ebrain delete <slug>`（支持 `--dry-run` 预览删除影响）
- `ebrain list [--type person] [--tag yc]`
- `ebrain search <query>`
- `ebrain query <question>`（支持 `--llm` 基于多层上下文生成回答，`--context-limit N` 控制上下文深度）
- `ebrain link <from> <to> [--context "..."]`（幂等）
- `ebrain backlinks <slug>`
- `ebrain timeline list <slug>`
- `ebrain timeline add <slug> --date YYYY-MM-DD --summary "..."`
- `ebrain timeline extract <slug>` — 从页面内容智能提取时间线事件
- `ebrain tag list <slug>`
- `ebrain tag add <slug> <tag>`（幂等）
- `ebrain tag remove <slug> <tag>`
- `ebrain raw get <slug> [--source x]`
- `ebrain raw set <slug> --source x --data '{"a":1}'`（也支持 `--stdin`）
- `ebrain import <paths...>`（支持 `--dry-run` 预览；`--skip-index` 跳过向量索引以避免 seekdb 崩溃。接受目录和/或文件，支持 shell glob 如 `*.docx`）
- `ebrain export --dir <dir>`
- `ebrain ingest [source] [--type doc] [--slug …] [--format pdf|docx|html|json|markdown|text] [--max-bytes N] [--timeout ms]` — 接受本地文件路径或 `http(s)://` URL，自动抽取 PDF / Word `.docx` / HTML / JSON / 纯文本（亦支持 `--stdin`），详见 `docs/document-ingestion.md`
- `ebrain embed <slug>` / `ebrain embed --all`
- `ebrain init`
- `ebrain stats`
- `ebrain compile <slug> <info>` — 智能编译新信息到页面的 compiled truth
- `ebrain smart-ingest [slug]` — 完整智能录入：编译 truth + 提取时间线 + 创建实体链接
- `ebrain graph [--port N] [--open]` — 启动知识图谱可视化 Web UI
- `ebrain serve` — 启动 MCP Server（stdio 模式，供 AI 工具集成）
- `ebrain tools-json` — 打印 MCP 工具发现 JSON

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
