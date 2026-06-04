import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import SettingsCategoriesClient from "./client";

export const dynamic = "force-dynamic";

async function createCategory(formData: FormData) {
  "use server";

  const name = String(formData.get("categoryName") ?? "").trim();
  const parentIdRaw = String(formData.get("parentId") ?? "").trim();
  const parentId = parentIdRaw ? parentIdRaw : null;

  if (!name) return;

  let type = "expense";
  let parentType: string | null = null;

  if (parentId) {
    const parent = await prisma.category.findUnique({ where: { id: parentId } });
    if (parent) {
      type = parent.type;
      parentType = parent.type;
    }
  }

  await prisma.category.create({
    data: { name, parentId, type: parentType ?? type },
  }).catch(() => null);

  revalidatePath("/settings/categories");
  revalidatePath("/accounts");
  revalidatePath("/");
}

async function deleteCategory(formData: FormData) {
  "use server";

  const categoryId = String(formData.get("categoryId") ?? "").trim();
  if (!categoryId) return;

  const existing = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!existing || existing.isSystem) return;

  await prisma.category.delete({ where: { id: categoryId } });

  revalidatePath("/settings/categories");
  revalidatePath("/accounts");
  revalidatePath("/");
}

export default async function SettingsCategoriesPage() {
  const categories = await prisma.category.findMany({
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  return <SettingsCategoriesClient categories={categories} />;
}
