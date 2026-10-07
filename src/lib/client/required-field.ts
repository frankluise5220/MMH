/**
 * 必填字段红框的**统一实现**（全项目唯一来源）。
 *
 * 用途：标记「必填」的表单字段（常显，与填写/校验状态无关）。用法三种，任选其一：
 *   1. 包住自研下拉/自研输入（`SmartSelect`、`CalcInput`、原生控件组）：
 *        `<div className={REQUIRED_FIELD_CLASS}><SmartSelect ... /></div>`
 *   2. 直接拼进原生控件 className：
 *        `<input className={`form-input ${REQUIRED_FIELD_CLASS}`} />`
 *   3. 作为组件的 className 传入（如 `DateStepper`、`CalcInput` 的 className 落在外层/输入框上）：
 *        `<DateStepper className={REQUIRED_FIELD_CLASS} ... />`
 *
 * 视觉：1px 玫红（`rose-200/80`）ring（box-shadow 环，不是 border，所以不会改变盒子尺寸，
 * 可以和 `form-input` 自带的圆角/边框叠加）；`rounded-[10px]` 与外层控件的圆角对齐，让 ring 贴合。
 *
 * 注：本常量原为 `RegularInvestForm`（计划任务）与 `TransactionFormModal` 各自的文件内副本，
 * 2026-10-07 抽到这里统一，改样式只需改这一处。
 */
export const REQUIRED_FIELD_CLASS = "rounded-[10px] ring-1 ring-rose-200/80";
