# 任务目录契约（MMH Bug Harness）

本目录由 `mmh-bug-harness` 常驻服务自动维护。第三方 harness **只读 `pending/`**，
处理完后把整个任务子目录移动到 `claimed/` 或 `done/`。

## 目录结构

```
tasks/
  README.md                 本文件
  index.json                全部任务的机读索引（每轮重建，含 counts）
  pending/<id>/             待处理任务
    task.md                 任务规格（YAML front-matter + Markdown 正文）
    task.json               同一任务的机读结构（含 spec 与原始内容）
    assets/                 用户上传的截图等附件
  claimed/<id>/             harness 认领中（由 harness 移动过来）
  done/<id>/                harness 已完成（由 harness 移动过来）
  skipped/<id>/             分诊判定非缺陷（建议/提问/赞助/重复），仅备查
```

## 任务 ID 规则

- GitHub issue：`GH-<number>`（如 `GH-22`）
- 反馈邮件：`MAIL-<messageId 摘要>`

## 推荐执行流程

1. 读 `index.json`，取 `status === "pending"` 的条目（或直接遍历 `pending/*/task.md`）。
2. 读取 `pending/<id>/task.md`，按 front-matter 的 `workspace_hint` 定位 MMH 检出目录。
3. 认领：`mv pending/<id> claimed/<id>`（服务下一轮会把状态记为 `claimed`）。
4. 按任务正文与 `constraints` 修改代码。
5. 完成后：`mv claimed/<id> done/<id>`（服务记为 `done`）。
   若判断无法修复，在该目录写 `BLOCKED.md` 说明卡点，然后同样移入 `done/`。

## 硬约束（每个任务的 front-matter 与正文都会重申）

- **只修改代码，不要 git commit / git push / 开 PR** —— 改动留在工作区待人工提交。
- 改动后跑 `npx tsc --noEmit` 自检。
- 只改相关文件，不顺带重构。

## 状态回流

服务每轮扫描 `claimed/` 与 `done/`，把文件所在目录名当作任务状态写回 `index.json`。
harness **不需要**调用任何 API，也不需要写状态文件 —— 移动目录就是唯一的回写方式。
