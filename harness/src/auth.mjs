/**
 * 页面鉴权 —— 无状态签名会话。
 *
 * 为什么不直接上 HTTP Basic：Basic 的浏览器弹窗无法显式登出，且每次新会话都要重输；
 * 这里用一个「由密码派生出的令牌」当 cookie 值 —— 不落库、不存会话表、重启后仍有效，
 * 改密码则所有旧会话立即失效（这正是我们想要的语义）。
 *
 * 未启用鉴权时（密码被显式设为 AUTH_DISABLED_SENTINEL，或配置被清空且默认值也为空）
 * 鉴权整体关闭，页面行为与之前完全一致。
 */

import crypto from "node:crypto";
import { AUTH_DISABLED_SENTINEL, DEFAULT_UI_PASSWORD } from "./schema.mjs";

const COOKIE_NAME = "mmh_harness_session";
const TOKEN_SALT = "mmh-bug-harness-session-v1";
const DEFAULT_MAX_AGE_SEC = 7 * 24 * 3600;

/**
 * 是否启用鉴权。
 *
 * 注意：schema 的默认密码是 `mmh12345`（非空），所以「留空」不等于关闭 ——
 * 留空只会回落到默认密码。要真正关掉登录必须显式填 `-`。
 */
export function authEnabled(cfg) {
  const password = String(cfg.ui?.password ?? "");
  return password !== "" && password !== AUTH_DISABLED_SENTINEL;
}

/** 当前是否仍在使用初始密码（页面据此显示改密提醒）。 */
export function usingDefaultPassword(cfg) {
  return authEnabled(cfg) && String(cfg.ui?.password ?? "") === DEFAULT_UI_PASSWORD;
}

/** 由密码派生会话令牌（定长，便于定时安全比较）。 */
function tokenFor(password) {
  return crypto.createHmac("sha256", String(password)).update(TOKEN_SALT).digest("hex");
}

export function sessionToken(cfg) {
  return tokenFor(cfg.ui.password);
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 校验用户输入的密码。 */
export function verifyPassword(cfg, input) {
  if (!authEnabled(cfg)) return true;
  return timingSafeEqual(tokenFor(input), tokenFor(cfg.ui.password));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** 请求是否已通过鉴权。未启用鉴权时恒为 true。 */
export function isAuthenticated(cfg, req) {
  if (!authEnabled(cfg)) return true;
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies[COOKIE_NAME];
  if (!value) return false;
  return timingSafeEqual(value, sessionToken(cfg));
}

/** 下发会话 cookie。未启用鉴权时返回 null。 */
export function sessionCookieHeader(cfg, maxAgeSec = DEFAULT_MAX_AGE_SEC) {
  if (!authEnabled(cfg)) return null;
  // 注意：不设 Secure —— 页面跑在 http:// 上；SameSite=Lax 防 CSRF。
  return `${COOKIE_NAME}=${sessionToken(cfg)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { COOKIE_NAME };
