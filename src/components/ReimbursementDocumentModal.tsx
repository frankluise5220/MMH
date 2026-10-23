"use client";

import type { ComponentProps } from "react";
import { ReimbursementEditor } from "./ReimbursementEditor";
import { ReimbursementFormModal } from "./ReimbursementFormModal";

/**
 * 报销单窗口的唯一入口：新建 / 编辑 / 审核都从这里调用。
 *
 * 三个场景是**同一张单据的三种状态**，窗口外壳（`EntryModalShell`：标题栏、页签、FT 卡片、
 * 按钮行、层级、高度）与纸面（`ReimbursementDocumentForm`：抬头网格、明细表、合计行、
 * 原始记录块）都已共用；这里只按 `mode` 选择状态模型：
 *  - `create`：单据还不存在，表单在本地草稿上编辑，提交时一次性创建（`ReimbursementFormModal`）；
 *  - `edit`  ：服务端单据，抬头与明细逐项保存，明细行带 id，可增量增删改（`ReimbursementEditor`）；
 *  - `audit` ：只读纸面 + 审批区（审批日期 / 金额 / 备注），保存即提交审批。
 *
 * 两个实现之所以分开，是因为数据模型不同（草稿行 vs 服务端行 id），
 * 但窗口外观与纸面结构是同一套，调用方不必再关心这件事。
 */
type CreateProps = ComponentProps<typeof ReimbursementFormModal>;
type EditorProps = Omit<ComponentProps<typeof ReimbursementEditor>, "mode">;

export type ReimbursementDocumentModalProps =
  | ({ mode: "create" } & CreateProps)
  | ({ mode: "edit" | "audit" } & EditorProps);

export function ReimbursementDocumentModal(props: ReimbursementDocumentModalProps) {
  if (props.mode === "create") {
    // 多出的 `mode` 新建窗不会读取，它只认草稿相关字段。
    return <ReimbursementFormModal {...props} />;
  }
  const { mode, ...editorProps } = props;
  return <ReimbursementEditor {...editorProps} mode={mode} />;
}
