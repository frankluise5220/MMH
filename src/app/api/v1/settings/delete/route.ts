import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

const BodySchema = z.object({
  entity: z.enum(["accountGroup", "account", "institution", "category"]),
  id: z.string().min(1),
});

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "参数不正确" }, { status: 400 });
  }

  const { entity, id } = parse.data;

  if (entity === "accountGroup") {
    const used = await prisma.account.count({ where: { groupId: id } });
    if (used > 0) return NextResponse.json({ ok: false, error: "已有账户属于该分组，无法删除" }, { status: 409 });
    await prisma.accountGroup.delete({ where: { id } });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  }

  if (entity === "account") {
    const used = await prisma.txRecord.count({ where: { accountId: id } });
    if (used > 0) return NextResponse.json({ ok: false, error: "该账户已产生流水记录，无法删除" }, { status: 409 });
    await prisma.account.delete({ where: { id } });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  }

  if (entity === "institution") {
    const used = await prisma.account.count({ where: { institutionId: id } });
    if (used > 0) return NextResponse.json({ ok: false, error: "已有账户使用该机构，无法删除" }, { status: 409 });
    await prisma.institution.delete({ where: { id } });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  }

  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) return NextResponse.json({ ok: false, error: "类别不存在" }, { status: 404 });

  if (category.isSystem) {
    return NextResponse.json({ ok: false, error: "系统内置类别，无法删除" }, { status: 409 });
  }

  const [children, used] = await Promise.all([
    prisma.category.count({ where: { parentId: id } }),
    prisma.txRecord.count({
      where: {
        OR: [
          { categoryId: id },
          { categoryId: null, categoryName: category.name },
        ],
      },
    }),
  ]);

  if (children > 0) return NextResponse.json({ ok: false, error: "该类别有子级，无法删除" }, { status: 409 });
  if (used > 0) return NextResponse.json({ ok: false, error: "该类别已产生流水记录，无法删除" }, { status: 409 });

  await prisma.category.delete({ where: { id } });
  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true });
}

