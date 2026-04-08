# Query Skill

## Strategy
1. 关键词优先：`ebrain search "<query>"`。
2. 语义补充：`ebrain query "<question>"`。
3. 结构化过滤：`ebrain list --type <type> --tag <tag>`。

## Ranking Heuristic
- 混合分：关键词相关性 + 语义相似度。
- 类型匹配加权：问人优先人物页。
- 新鲜度加权：近 30 天更新内容适度上浮。
