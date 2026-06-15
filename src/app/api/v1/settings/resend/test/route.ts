import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/resend/test
 * 使用传入的 Resend 配置发送测试邮件
 * Body: { apiKey: string, from: string }（可选：不传则用已保存配置）
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  let apiKey = String(body.apiKey ?? "").trim();
  let from = String(body.from ?? "").trim();

  // 如果没传配置，从 SystemSetting 读取
  if (!apiKey || !from) {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "resend_config" } });
    if (setting) {
      try {
        const parsed = JSON.parse(setting.value) as { apiKey?: string; from?: string };
        if (!apiKey) apiKey = parsed.apiKey ?? "";
        if (!from) from = parsed.from ?? "";
      } catch {}
    }
  }

  if (!apiKey || !from) {
    return NextResponse.json({ ok: false, error: "请填写 Resend API Key 和发件地址" }, { status: 400 });
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      from,
      to: from, // 测试发给自己
      subject: "WiseMe Resend 测试邮件",
      text: "如果你收到这封邮件，说明 Resend 发件配置正确。",
      html: "<div><h2>WiseMe Resend 测试邮件</h2><p>如果你收到这封邮件，说明 Resend 发件配置正确。</p></div>",
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
    return NextResponse.json({ ok: false, error: data?.message || data?.error || `Resend 发信失败：${res.status}` });
  }

  return NextResponse.json({ ok: true });
}
