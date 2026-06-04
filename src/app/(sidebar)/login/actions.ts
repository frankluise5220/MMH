"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";

const PASSWORD_KEY = "access_password";
const VERIFIED_KEY = "wiseme_access_password_verified";
const USERNAME_KEY = "wiseme_username";

async function ensureUser(username: string, isSystem = false) {
  const existing = await prisma.user.findFirst({ where: { name: username } });
  if (!existing) {
    await prisma.user.create({ data: { name: username, role: "admin", isSystem: isSystem || username === "admin" } });
  }
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

  // 验证通过，设 cookie
  if (username) {
    try { await ensureUser(username); } catch { /* ignore */ }
  }

  const cookieStore = await cookies();
  cookieStore.set(VERIFIED_KEY, "ok", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  if (username) {
    cookieStore.set(USERNAME_KEY, username, {
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
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

  // 直接设 cookie 并跳转
  const cookieStore = await cookies();
  cookieStore.set(VERIFIED_KEY, "ok", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  cookieStore.set(USERNAME_KEY, username, {
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  redirect("/");
}
