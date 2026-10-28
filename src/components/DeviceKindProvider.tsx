"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { DeviceKind } from "@/lib/device-kind";

/**
 * 设备形态由服务端判定后下发给客户端，客户端组件据此选择渲染哪一套 UI 树。
 *
 * 为什么不直接在客户端 `matchMedia`：那会在首帧渲染出「桌面树」，水合后才
 * 切成「移动树」，手机上能看到一次明显跳动；而 `md:` 断点的问题则是它回答
 * 的是窗口宽度，不是设备本身。服务端读请求头可以在 HTML 里就定好，无需水合。
 */
const DeviceKindContext = createContext<DeviceKind>("desktop");

export function DeviceKindProvider({ value, children }: { value: DeviceKind; children: ReactNode }) {
  return <DeviceKindContext.Provider value={value}>{children}</DeviceKindContext.Provider>;
}

export function useDeviceKind(): DeviceKind {
  return useContext(DeviceKindContext);
}

export function useIsMobileDevice(): boolean {
  return useContext(DeviceKindContext) === "mobile";
}
