/**
 * 涨跌颜色配置
 *
 * red_up_green_down: 红涨绿跌（中国习惯）— 涨(正数)=红, 跌(负数)=绿
 * green_up_red_down: 绿涨红跌（国际习惯）— 涨(正数)=绿, 跌(负数)=红
 */
export type ColorScheme = "red_up_green_down" | "green_up_red_down";

const schemes: Record<ColorScheme, { up: string; down: string; neutral: string }> = {
  red_up_green_down: {
    up: "text-red-600",
    down: "text-emerald-700",
    neutral: "text-slate-600",
  },
  green_up_red_down: {
    up: "text-emerald-700",
    down: "text-red-600",
    neutral: "text-slate-600",
  },
};

/** 根据数值和色系返回颜色 class */
export function pnlColor(n: number, scheme: ColorScheme): string {
  const s = schemes[scheme] ?? schemes.red_up_green_down;
  if (n > 0) return s.up;
  if (n < 0) return s.down;
  return s.neutral;
}

/** 从 cookie 中读取色系偏好 */
export function getColorSchemeFromCookie(cookieHeader: string | null): ColorScheme {
  if (!cookieHeader) return "red_up_green_down";
  const match = cookieHeader.match(/colorScheme=([^;]+)/);
  if (match && (match[1] === "red_up_green_down" || match[1] === "green_up_red_down")) {
    return match[1] as ColorScheme;
  }
  return "red_up_green_down";
}