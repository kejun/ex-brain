# 文档摄取：PDF / Word / HTML / URL

`ebrain put --file` 支持把 PDF、Word（`.docx`）、HTML、JSON、纯文本以及 `http(s)://` URL 直接摄取为 ex-brain 页面，自动抽取内容并保存来源元数据。旧的 `ebrain ingest` CLI 命令已移除；请统一使用 `ebrain put --file <source>`。

## 支持的格式

| 类型 | 扩展名 | Content-Type | 解析器 |
| --- | --- | --- | --- |
| PDF | `.pdf` | `application/pdf` | [`unpdf`](https://github.com/unjs/unpdf)（基于 PDF.js 的 serverless 构建） |
| Word | `.docx` | `…wordprocessingml.document` | [`mammoth`](https://github.com/mwilliamson/mammoth.js) |
| HTML | `.html`/`.htm` | `text/html` | `@mozilla/readability` 正文抽取 + `node-html-markdown` 转 Markdown |
| JSON | `.json` | `application/json`, `*+json` | `JSON.stringify(JSON.parse(...), null, 2)` |
| Markdown | `.md`/`.mdx`/`.markdown` | `text/markdown` | UTF-8 直接读取 |
| 纯文本 | `.txt`/`.csv`/`.log`/`.yaml`… | `text/*` | UTF-8 直接读取 |

> **不支持** 旧版 `.doc` (OLE 二进制)。摄取时会给出明确报错并提示用 `libreoffice --convert-to docx` 转换。

格式自动识别顺序：
1. 显式 `--format <kind>` 参数
2. HTTP `Content-Type` / 文件扩展名
3. 文件头 magic bytes（`%PDF`、ZIP `PK\x03\x04`、OLE `D0CF11E0`）
4. 如内容看起来是文本则按 UTF-8 兜底，否则报错

## 命令行用法

```bash
# 本地 PDF
ebrain put --file report.pdf

# 本地 Word
ebrain put --file meeting-notes.docx

# 远程 URL（自动按 Content-Type 解析）
ebrain put --file https://example.com/whitepaper.pdf

# 远程 HTML 文章（正文抽取后转 Markdown）
ebrain put --file https://example.com/article --format html

# 自定义 slug + 试运行
ebrain put docs/q4-report --file report.pdf --dry-run

# 长 HTML 字符串通过 stdin 导入
cat page.html | ebrain put clips/page --stdin --format html

# 显式覆盖类型 / 调整下载上限 / 调整超时
ebrain put --file https://big.example.com/x.pdf \
  --max-bytes 104857600 \
  --timeout 60000 \
  --type research-paper
```

### 主要参数

- `--file <source>`：本地路径或 `http(s)://` URL。
- `--stdin`：从管道读取 Markdown；配合 `--format html` 时从管道读取 HTML 字符串并转 Markdown。
- `--type <type>`：覆盖页面 `type` 字段，默认使用检测到的 kind（如 `pdf`、`docx`）。
- `<slug>`：可选位置参数，覆盖默认的 `ingest/<sanitized-filename-without-ext>` slug。
- `--format <kind>`：强制 kind，绕过自动识别（`pdf|docx|html|json|markdown|text`）。
- `--max-bytes <number>`：URL/文件大小上限，默认 50 MiB。
- `--timeout <ms>`：URL 获取超时，默认 30 s。
- `--dry-run`：只打印将要写入的元数据，不落库。

### 自动写入的元数据

每次摄取除了把抽取的文本或 Markdown 写入 `compiled_truth` 之外，还会：

- 在 `frontmatter` 中保存 `sourceFile`、`sourceType`（`url`/`file`/`stdin`）、`sourceKind`、`sourceMimeType`、`sourceBytes`、`sourceFileName` 以及 parser 相关元数据（如 PDF 页数、mammoth 警告、HTML readability 标题/摘要）。
- 追加一条 timeline 事件：`Ingested <kind> <fileName>`，URL 来源会把 URL 记入 `detail`。
- 在 `raw_data` 表中记录一份 JSON 摘要，方便后续 `ebrain raw get <slug>` 追溯原始来源。

## MCP 工具

新增 MCP 工具 `brain_ingest_document`，签名：

```jsonc
{
  "source": "string (file path or http(s) URL, required)",
  "slug": "string?",
  "type": "string?",
  "format": "text|markdown|pdf|docx|doc|html|json|unknown?",
  "max_bytes": "number?",
  "timeout_ms": "number?"
}
```

返回 JSON：
```jsonc
{
  "ok": true,
  "slug": "ingest/whitepaper",
  "kind": "pdf",
  "sourceType": "url",
  "sourceRef": "https://example.com/whitepaper.pdf",
  "fileName": "whitepaper.pdf",
  "mimeType": "application/pdf",
  "bytes": 482915,
  "contentLength": 12340,
  "page": { "slug": "ingest/whitepaper", "updatedAt": "..." },
  "metadata": { "pageCount": 18, "parser": "unpdf" }
}
```

旧的 `brain_ingest`（直接传文本）保持不变，主要用于 LLM 已经拿到正文的场景。CLI 侧请使用 `ebrain put`。

## 限制与注意事项

- **图像型 PDF**：`unpdf` 仅抽取已嵌入的文本流；扫描件需额外 OCR 步骤后再 ingest。
- **`.doc` 旧格式**：不支持，请先转 `.docx` 或 `.pdf`。
- **大文件**：默认上限 50 MiB，可用 `--max-bytes` 调整；过大文件会在下载/读取阶段提前报错。
- **HTML 抽取**：默认先用 Readability 抽正文，再转 Markdown，能保留标题、链接、列表和图片引用；抽取失败时退回整页 HTML 转 Markdown，最后才退回纯文本剥离。脚本驱动的 SPA 页面建议先用浏览器渲染再保存。
- **运行时依赖**：`seekdb` 依赖 `libaio`，缺失时会报 `libaio.so.1 not found`，请在系统层安装（如 Debian/Ubuntu：`apt install libaio1t64` 并补软链 `libaio.so.1`）。

## 冒烟脚本

相关测试覆盖 PDF / DOCX / TXT / HTML 文件摄取、HTML Markdown 转换，以及 `--stdin --format html` 的长字符串导入。
