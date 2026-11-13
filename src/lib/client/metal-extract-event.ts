/**
 * 贵金属「提取实物」的跨组件入口。
 *
 * 提取实物不再单独开弹窗：所有入口（胶囊菜单、持仓工具条、持仓行按钮）都派发
 * `mmh:investment:create`，由页面级唯一的贵金属投资记账窗打开第三个 FT 页签
 * 「提取实物」，在窗口内完成提取实物。
 */
export type MetalExtractRequestDetail = {
  requestId?: string;
  accountId: string;
  metalTypeId?: string | null;
  metalUnitId?: string | null;
};

export function openMetalExtract(detail: MetalExtractRequestDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("mmh:investment:create", {
      detail: {
        requestId: detail.requestId ?? `metal-extract-${Date.now()}`,
        defaultAccountId: detail.accountId,
        defaultProductType: "metal",
        defaultSubtype: "metal_extract",
        defaultMetalTypeId: detail.metalTypeId ?? undefined,
        defaultMetalUnitId: detail.metalUnitId ?? undefined,
      },
    }),
  );
}
