"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import {
  SESSION_DAYS_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  sessionCookieOptions,
} from "@/lib/server/session-cookies";

const PASSWORD_KEY = "access_password";

async function ensureUser(username: string, isSystem = false) {
  const existing = await prisma.user.findFirst({ where: { name: username } });
  if (!existing) {
    await prisma.user.create({ data: { name: username, role: "admin", isSystem: isSystem || username === "admin" } });
  }
}

function resolveSessionMaxAge(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  const raw = cookieStore.get(SESSION_DAYS_COOKIE)?.value ?? "30";
  const days = Number(raw);
  const normalizedDays = Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 1), 365) : 30;
  return normalizedDays * 24 * 60 * 60;
}

export type LoginState = {
  error?: string;
};

export async function login(_prev: LoginState | undefined, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim() || "admin";
  const password = String(formData.get("password") ?? "").trim();

  if (!password) return { error: "请输入密码" };

  const setting = await prisma.systemSetting.findUnique({
    where: { key: PASSWORD_KEY },
  });

  const noPassword = !setting || setting.value.length === 0;
  const passwordMatch = password === (setting?.value ?? "");

  if (!noPassword && !passwordMatch) {
    return { error: "密码错误" };
  }

  // 验证通过，写入 cookie
  if (username) {
    try { await ensureUser(username); } catch { /* ignore */ }
  }

  const cookieStore = await cookies();
  const maxAge = resolveSessionMaxAge(cookieStore);
  const cookieOptions = sessionCookieOptions(maxAge);
  cookieStore.set(VERIFIED_COOKIE, "ok", cookieOptions);
  if (username) {
    cookieStore.set(USERNAME_COOKIE, username, cookieOptions);
  }

  redirect("/");
}

export type SetupState = {
  error?: string;
};

export async function setupPassword(_prev: SetupState | undefined, formData: FormData): Promise<SetupState> {
  const username = String(formData.get("username") ?? "").trim() || "admin";
  const newPassword = String(formData.get("newPassword") ?? "").trim();
  const confirmPassword = String(formData.get("confirmPassword") ?? "").trim();

  if (!username) return { error: "请输入用户名" };
  if (!newPassword) return { error: "请输入密码" };
  if (newPassword !== confirmPassword) return { error: "两次输入的密码不一致" };

  // 保存密码
  const isFirstSetup = !(await prisma.systemSetting.findUnique({ where: { key: PASSWORD_KEY } }));

  await prisma.systemSetting.upsert({
    where: { key: PASSWORD_KEY },
    create: { key: PASSWORD_KEY, value: newPassword },
    update: { value: newPassword },
  });

  // 首次设置时创建系统 admin 用户
  if (isFirstSetup && username) {
    try { await ensureUser(username, true); } catch { /* ignore */ }
  }

  // 直接写入 cookie 并跳转
  const cookieStore = await cookies();
  const maxAge = resolveSessionMaxAge(cookieStore);
  const cookieOptions = sessionCookieOptions(maxAge);
  cookieStore.set(VERIFIED_COOKIE, "ok", cookieOptions);
  cookieStore.set(USERNAME_COOKIE, username, cookieOptions);

  redirect("/");
}
