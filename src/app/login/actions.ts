"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";

const PASSWORD_KEY = "access_password";
const VERIFIED_KEY = "mmh_access_password_verified";
const USERNAME_KEY = "mmh_username";
const SESSION_DAYS_KEY = "mmh_session_days";

async function ensureUser(username: string, isSystem = false) {
  const existing = await prisma.user.findFirst({ where: { name: username } });
  if (!existing) {
    await prisma.user.create({ data: { name: username, role: "admin", isSystem: isSystem || username === "admin" } });
  }
}

function resolveSessionMaxAge(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  const raw = cookieStore.get(SESSION_DAYS_KEY)?.value ?? "30";
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

  if (!password) return { error: "璇疯緭鍏ュ瘑鐮?" };

  const setting = await prisma.systemSetting.findUnique({
    where: { key: PASSWORD_KEY },
  });

  const noPassword = !setting || setting.value.length === 0;
  const passwordMatch = password === (setting?.value ?? "");

  if (!noPassword && !passwordMatch) {
    return { error: "瀵嗙爜閿欒" };
  }

  // 楠岃瘉閫氳繃锛岃 cookie
  if (username) {
    try { await ensureUser(username); } catch { /* ignore */ }
  }

  const cookieStore = await cookies();
  const maxAge = resolveSessionMaxAge(cookieStore);
  cookieStore.set(VERIFIED_KEY, "ok", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  if (username) {
    cookieStore.set(USERNAME_KEY, username, {
      sameSite: "lax",
      path: "/",
      maxAge,
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

  if (!username) return { error: "璇疯緭鍏ョ敤鎴峰悕" };
  if (!newPassword) return { error: "璇疯緭鍏ュ瘑鐮?" };
  if (newPassword !== confirmPassword) return { error: "涓ゆ杈撳叆鐨勫瘑鐮佷笉涓€鑷?" };

  // 淇濆瓨瀵嗙爜
  const isFirstSetup = !(await prisma.systemSetting.findUnique({ where: { key: PASSWORD_KEY } }));

  await prisma.systemSetting.upsert({
    where: { key: PASSWORD_KEY },
    create: { key: PASSWORD_KEY, value: newPassword },
    update: { value: newPassword },
  });

  // 棣栨璁剧疆鏃跺垱寤虹郴缁?admin 鐢ㄦ埛
  if (isFirstSetup && username) {
    try { await ensureUser(username, true); } catch { /* ignore */ }
  }

  // 鐩存帴璁?cookie 骞惰烦杞?
  const cookieStore = await cookies();
  const maxAge = resolveSessionMaxAge(cookieStore);
  cookieStore.set(VERIFIED_KEY, "ok", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  cookieStore.set(USERNAME_KEY, username, {
    sameSite: "lax",
    path: "/",
    maxAge,
  });

  redirect("/");
}
