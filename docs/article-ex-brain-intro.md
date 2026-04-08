# 受 Karpathy 的 LLM Wiki 启发，让个人知识库成为你的"第二大脑"

> 我读了 [Karpathy 的 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 和 [Garry Tan 的 GBrain](https://gist.github.com/garrytan/49c88e83cf8d7ae95e087426368809cb) 之后，深受启发——他们用最简单的东西（LLM + 本地存储）搭出了一个能"理解"知识的系统。我能不能再往前走一步？于是就做了 ex-brain。



## 这类工具是不是太多了？

市面上的工具，我总觉得有两个问题：

**传统笔记**（Notion、Obsidian 这类）——功能很强大，但你写进去的东西，它不会帮你"消化"。你记了一条信息，三个月后它还是那条信息，静静地躺在那里。想找关联？靠你自己翻。

**AI 笔记**（Mem、Granola）——确实有 AI 帮你整理了，但感觉就整理那一下，之后呢？更重要的是，AI 怎么理解你的内容、怎么归类、怎么提取要点，这些逻辑你完全没法控制。它的脑子不是你的脑子。

**如果知识库能像人脑一样，每次写入新信息都自动"更新"认知，会怎样？**

这里有一个核心概念：**Compiled Truth**——翻译过来就是"编译后的真相"。听着有点拗口，但道理很简单。



## 核心机制一：智能编译

### 先说问题：信息越记越多，越看越累

你往知识库写东西，传统工具怎么做？要么追加到页面末尾，要么新建一个页面。结果就是——东西越来越多。

举个例子，你记了三条关于 River AI 的信息：

```
3月：River AI 完成 A 轮融资，5000 万美元
6月：Sarah Chen 接任 CEO，创始人转顾问
8月：B 轮 1.2 亿美元
```

半年后你想看 River AI 现状，得读完三条，自己在脑子里拼出"现在是什么情况"。但在人脑里这事儿很自然——听到新消息，你就知道"哦，之前那个已经过时了"。工具却不会这么想。

### "编译"你的知识库

ex-brain 的核心就是这个编译机制。你跑一条命令：

```bash
ebrain compile companies/river-ai \
  "River AI 上了 A 轮，5000 万美元" \
  --source meeting_notes \
  --date 2024-05-20
```

系统会干这几件事：

**第一步：让 LLM 分析这是什么类型的信息**

它会判断这条消息是：
- 状态变了（融资阶段从 Seed 变成 Series A）？
- 还是发生了个事件（产品发布了）？
- 还是更正了旧信息？

**第二步：根据类型决定怎么处理**

- 状态类的（融资阶段、CEO）→ 直接**更新**，旧值扔进历史记录
- 事实类的（成立年份、行业）→ **追加**，不删旧的
- 事件类的 → 同时记到**时间线**里

**第三步：更新 Compiled Truth**

编译完之后，你的页面变成这样：

```markdown
## Status
- **Funding Stage**: Series A (Source: meeting_notes, 2024-05-20)
- **Valuation**: ~$50M

## History
- 之前是 Seed（到 2024-05-20 为止）

## Facts
- A 轮领投方是 Sequoia
- 2020 年成立的
```

你看，"当前真相"一目了然。之前的信息没丢，但在 History 里，不会干扰你读现在的情况。

### 这背后的想法

我觉得知识不是都一样的。有些信息会"过期"，有些不会：

| 类型 | 怎么处理 | 例子 |
|-----|---------|------|
| 状态信息 | 会过期，要更新 | 融资阶段、CEO、员工数 |
| 事实信息 | 不过期，留着 | 成立时间、行业、总部 |
| 事件信息 | 记下来当历史 | 产品发布、融资完成 |

这个分类不是写死的规则——是 LLM 每次编译时自己判断的。它看语义，不是看关键词。



## 核心机制二：时间线自动抽取

### 时间是理解变化的关键

人对"变化"的理解，很大程度靠时间线。你看一个公司的发展，就是看时间线上发生了什么。

ex-brain 能自动从文本里抽时间线事件：

```bash
ebrain timeline extract companies/river-ai
```

它从你的 Compiled Truth 和历史记录里，把事件拎出来：

```json
[
  {
    "date": "2024-05-20",
    "summary": "A 轮融资完成，5000 万",
    "detail": "Sequoia 领投"
  },
  {
    "date": "2024-06-15",
    "summary": "Sarah Chen 接任 CEO"
  }
]
```

### 日期格式随便写

系统认各种日期格式：

- `2024-05-20`（ISO）
- `2024年5月20日`（中文）
- `May 20, 2024`（英文）
- `last week`、`yesterday`（相对日期）

不用你统一格式，它自己能理解。

### 编译和抽取是配合的

时间线不是单独的功能——它跟编译是一体的。你 `compile` 一条信息，系统自动把里面的事件拎到时间线里。

整个流程是这样：

```
你写："River AI 上了 A 轮"
      ↓
系统：这是状态更新 + 事件
      ↓
系统：更新融资阶段 → Series A
      ↓
系统：时间线加一条 → "A 轮完成"
```



## 核心机制三：自动关联实体

### 知识不是孤立的事实

一条知识有价值，往往是因为它和其他知识有联系。"Ali Partovi 是 Neo 创始人"——这条信息的关键不只是 Ali 或 Neo，而是"创始人"这个关系。

ex-brain 用 LLM 自动识别文本里的实体关系：

```bash
ebrain put people/ali-partovi --file notes.md

# 系统自动认出：
# - Ali Partovi founder_of Neo
# - Ali Partovi invested_in 其他公司
```

它能识别的关系类型：

| 关系 | 例子 |
|-----|------|
| 创始人 | Ali founder_of Neo |
| 工作地 | Sarah works_at River AI |
| 领导 | John leader_of Engineering |
| 投资 | Sequoia invested_in River AI |
| 收购 | Google acquired YouTube |

### 关系被发现时，自动建页面

系统发现一个新实体，会自动建个页面记下来：

```markdown
# 自动创建的 people/sarah-chen

## Facts
- **CEO_of** [River AI](companies/river-ai): 2024年6月接任
```

你的知识网络就这样自己长起来了。



## 核心机制四：混合检索

### 光靠一种搜索不够

全文搜索——精确，但不懂语义。搜"融资"，找不到"funding round"。
向量搜索——懂语义，但可能漏精确词。搜"Sequoia"，可能给你一堆"sequoia tree"的乱七八糟结果。

ex-brain 用 **seekdb** 的混合检索，两个一起用：

```bash
# 精确词搜
ebrain search "River AI Series A"

# 语义问
ebrain query "哪些公司最近融资了？"
```

### 搜索结果有加权

系统不是随便返回结果，有个评分逻辑：

- **语义匹配**占大头（85%）——向量相似度
- **新鲜度**有加成（10%）——最近更新的内容更重要
- **类型**也有影响（5%）——人物类型通常值得关注

这样你搜出来的东西，既相关，又新鲜，又重要。



## 技术上怎么实现的

### 我选了 seekdb

这个项目用 [seekdb](https://docs.seekdb.ai/) 做底层。为什么选它？

- **嵌入式**：一个 SQLite 文件就能跑，不用搭数据库服务
- **混合检索**：原生支持全文 + 向量，不用拼两套系统
- **嵌入集成**：内置嵌入函数，支持 OpenAI、DashScope 各种模型
- **SQL 兼容**：熟悉的 SQL 语法，建表建索引都顺手

代码大概这样：

```typescript
// 连数据库——就是一个文件路径
const db = await BrainDb.connect("~/.ebrain/data/ebrain.db");

// 建个向量集合
const pages = await db.getOrCreateCollection({
  name: "ebrain_pages",
  embeddingFunction: createBrainEmbeddingFunction(settings.embed),
});

// 混合检索
const hits = await pages.hybridSearch({
  query: { whereDocument: { $contains: "融资" } },
  nResults: 10,
});
```

简单说，seekdb 把"存数据"和"语义检索"这两件事合到一起了。做 AI 应用的话，这是个不错的选择。

### 数据结构

数据怎么存的？简单说：

- **pages 表**：存每个知识页面（slug、标题、compiled_truth）
- **links 表**：存实体之间的关联
- **timeline_entries 表**：存时间线事件
- **ebrain_pages 集合**：存向量嵌入，用来做语义检索

关系表和向量集合是同一套数据库，数据一致性不用操心。



## 让 AI 直接用你的知识库

ex-brain 有个 MCP Server。如果你用 Claude，配置一下就能让它直接读你的知识库：

```json
// Claude Desktop 配置里加这个
{
  "mcpServers": {
    "ebrain": {
      "command": "ebrain",
      "args": ["serve"]
    }
  }
}
```

然后 Claude 就能用这些工具：

| 工具 | 干什么 |
|-----|-------|
| `brain_get` | 读页面 |
| `brain_put` | 写页面 |
| `brain_search` | 搜 |
| `brain_compile` | 编译新信息 |
| `brain_link` | 建关联 |

你可以让 Claude 帮你整理知识，它直接操作你的本地数据库。不用复制粘贴了。



## 设计时的一些想法

**本地优先**——数据就在你电脑上，一个 SQLite 文件。不用联网，不用担心服务商倒闭。

**完全可编程**——所有操作都能用命令行跑。这样你写脚本、接 AI、自动化都行：

```bash
# 管道输入
cat note.md | ebrain put my/note --stdin

# JSON 输出，方便脚本处理
ebrain get companies/river-ai --json | jq '.compiledTruth'
```

**幂等操作**——重复跑不会出问题。你 `put` 同一个文件十次，结果还是一样的。不怕手滑多跑了。

**命令结构统一**——都用 `resource verb` 的模式：

```bash
ebrain timeline list companies/river-ai
# 不是 timeline-list 这种乱七八糟的
```

这样命令好猜，不用翻文档。



## 顺便说一下 seekdb

既然用到了 [seekdb](https://docs.seekdb.ai/)，就多说两句。这是个专门给 AI 应用设计的数据库：

- **嵌入模式**：不用搭服务器，一个文件就能跑。适合个人项目和本地应用。
- **混合检索**：全文和向量检索都有，不用拼两套。
- **嵌入函数集成**：自带嵌入接口，接 OpenAI、本地模型都方便。
- **SQL 兼容**：语法跟 MySQL 一样，熟悉的人上手快。
- **远程模式**：如果你想团队共享数据，也可以连远程服务。

如果你也在做需要"本地存储 + 语义检索"的项目，seekdb 真的可以试试。ex-brain 就是拿它搭的，体验挺顺的。



## 数据怎么进知识库？

知识库不能是空的，你得往里填东西。手工写太累，从网页复制粘贴又得清理格式。

我推荐用 [MarkSnip](https://chromewebstore.google.com/detail/kcbaglhfgbkjdnpeokaamjjkddempipm)——一个浏览器扩展，一键把网页剪藏成干净的 Markdown。

**它能干什么：**

- 一键剪藏整页或选中内容
- 自动提取正文（用 Mozilla 的 Readability）
- 代码块带语言标签，表格对齐，数学公式也支持
- 本地处理，不传云端

**配合 ex-brain：**

```bash
# MarkSnip 剪藏后保存为 article.md
# 然后导入知识库
cat article.md | ebrain put articles/my-article --stdin

# 或者智能编译（让 LLM 整理）
ebrain compile companies/river-ai --file article.md --source web_clip
```

这样就形成了一个完整流程：浏览网页 → MarkSnip 剪藏 → ex-brain 编译 → 知识库自动更新。



## 想试试吗？

```bash
# 安装
bun install -g ex-brain

# 初始化——就是建个数据库文件
ebrain init

# 写第一个页面
ebrain put companies/river-ai --type company --content "
River AI 做 AI 分析平台的。
2020 年成立的。
"

# 编译一条新信息
ebrain compile companies/river-ai \
  "River AI 上了 A 轮，Sequoia 领投" \
  --source news \
  --date 2024-05-20

# 搜一下
ebrain search "River AI 融资"

# 如果用 Claude，启动 MCP 服务
ebrain serve
```

---

## 以后想做的事

这个项目还在早期，但核心机制已经能跑起来了。我有几个想继续探索的方向，每个方向都挺有意思：

**冲突处理**——新信息说 CEO 是 Sarah Chen，但你之前记的是 John Doe。这怎么办？现在的做法是直接替换，把旧的扔进 History。但更好的方式是标记出来，让人看一眼确认。有时候两个信息都对，只是时间点不同；有时候确实是错误信息，得让人判断。

**信息衰减**——一条信息太久没更新，它的可信度是不是该打个问号？比如你 2022 年记的「公司有 50 人」，到 2024 年这条信息可能已经过时了。系统可以标注「上次更新：2022 年」，提醒你注意时效性。这不是简单的过期删除，而是给用户一个信号。

**关联传播**——River AI 的 CEO 变了，那 Sarah Chen 的页面是不是该自动更新？现在系统会创建关联页面，但不会反向同步。理想情况是：一处更新，关联的地方都有提醒，但不会自动改——毕竟你不知道 Sarah Chen 是不是同时兼了其他职位。

**批量编译**——你现在有 100 条关于某公司的新闻，想一次性整理进去。逐条 compile 太慢，但一次性喂进去又怕 LLM 处理不好。需要一个中间方案：分批处理、增量合并、保持可控。

这些方向不是简单加功能，而是涉及「知识该怎么管理」的根本问题。如果你有想法，欢迎来聊聊。

---

## 最后说几句

做这个项目，其实是在回答一个我一直琢磨的问题：**知识库应该是什么样的？**

我觉得，好的知识库不应该只是个「仓库」。它应该有点像人的记忆——会更新、会遗忘、会把新信息和旧信息串起来。你现在用的工具，可能只是做到了「存」，但没做到「活」。

Karpathy 和 Garry Tan 的想法给了我启发：用 LLM 来「消化」知识。ex-brain 在这个基础上加了点自己的想法——信息的时效性分类、时间线自动抽取、实体关联生长。这些机制让知识库不只是静态的笔记，而是能跟着你的认知一起变化的东西。

当然，这个项目还很粗糙。编译的逻辑不够聪明，时间线提取偶尔会漏，实体关联有时候认错。但核心想法是清楚的：**知识是活的，工具也应该让它活起来。**

如果你也觉得现在的知识库工具不够「聪明」，不妨试试 ex-brain。或者你有更好的想法，欢迎来讨论——知识管理这件事，还有很多可以探索的空间。

---

*ex-brain 是开源的，MIT 许可证。感谢 Karpathy 和 Garry Tan 的思路启发，感谢 seekdb 团队做的好工具。*