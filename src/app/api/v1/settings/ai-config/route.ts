import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getOrCreateMasterKey, encrypt, decrypt, isEncrypted } from "@/lib/auth/encrypt";

export const runtime = "nodejs";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

export async function GET() {
  const channels = await prisma.aiChannel.findMany({
    orderBy: { createdAt: "asc" },
    include: { AiModel: { orderBy: { createdAt: "asc" } } },
  });
  const masterKey = await getOrCreateMasterKey();
  const activeModel = await prisma.aiModel.findFirst({ where: { active: true } });
  // Decrypt apiKey in each channel before returning
  const decoded = channels.map(ch => ({
    ...ch,
    apiKey: ch.apiKey && isEncrypted(ch.apiKey) ? decrypt(ch.apiKey, masterKey) : ch.apiKey,
  }));
  return NextResponse.json({ ok: true, channels: decoded, activeModelId: activeModel?.id ?? null }, { headers: cors() });
}

const ChannelSchema = z.object({
  name: z.string().min(1).max(80),
  baseUrl: z.string().min(4).max(300),
  apiKey: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = ChannelSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "缺少必填字段" }, { status: 400, headers: cors() });
  }
  const masterKey = await getOrCreateMasterKey();
  const encryptedApiKey = parse.data.apiKey && !isEncrypted(parse.data.apiKey)
    ? encrypt(parse.data.apiKey, masterKey)
    : parse.data.apiKey;
  const created = await prisma.aiChannel.create({
    data: { name: parse.data.name, baseUrl: parse.data.baseUrl, apiKey: encryptedApiKey },
    include: { AiModel: true },
  });
  return NextResponse.json({ ok: true, channel: created }, { headers: cors() });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400, headers: cors() });

  const existing = await prisma.aiChannel.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, error: "AI 渠道不存在" }, { status: 404, headers: cors() });

  await prisma.aiChannel.delete({ where: { id } });
  return NextResponse.json({ ok: true }, { headers: cors() });
}

const ModelSchema = z.object({
  model: z.string().min(1).max(80),
  name: z.string().max(80).optional(),
  channelId: z.string(),
  vision: z.boolean().optional(),
});

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  if (body && "model" in body && "channelId" in body) {
    const parse = ModelSchema.safeParse(body);
    if (!parse.success) return NextResponse.json({ ok: false, error: "缺少必填字段" }, { status: 400, headers: cors() });
    const created = await prisma.aiModel.create({
      data: { model: parse.data.model, name: parse.data.name, channelId: parse.data.channelId, vision: parse.data.vision ?? false },
    });
    return NextResponse.json({ ok: true, model: created }, { headers: cors() });
  }

  // Set active model
  if (body && "activeModelId" in body) {
    const activeModelId = (body as any).activeModelId as string;
    await prisma.aiModel.updateMany({ where: { active: true }, data: { active: false } });
    if (activeModelId) {
      await prisma.aiModel.update({ where: { id: activeModelId }, data: { active: true } });
    }
    return NextResponse.json({ ok: true }, { headers: cors() });
  }

  // Delete model
  if (body && "deleteModelId" in body) {
    const deleteModelId = (body as any).deleteModelId as string;
    const modelExists = await prisma.aiModel.findUnique({ where: { id: deleteModelId } });
    if (!modelExists) return NextResponse.json({ ok: false, error: "AI 模型不存在" }, { status: 404, headers: cors() });
    await prisma.aiModel.delete({ where: { id: deleteModelId } });
    return NextResponse.json({ ok: true }, { headers: cors() });
  }

  return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400, headers: cors() });
}