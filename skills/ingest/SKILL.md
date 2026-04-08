# Ingest Skill

## Workflow
1. 读取源文档并抽取实体、关系、事件。
2. 对每个实体执行 `ebrain get <slug>` 判定是否已有页面。
3. 已存在则更新 `compiled_truth` 并追加 `timeline`；不存在则新建。
4. 对实体关系执行 `ebrain link <from> <to> --context "..."`。
5. 对可日期化事件执行 `ebrain timeline-add <slug> --date YYYY-MM-DD --summary "..."`。

## Entry Criteria
- 深度沟通对象：YES
- 明确业务关系对象：YES
- 仅顺带提及且无上下文：NO
