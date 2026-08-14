import { prisma } from "../src/lib/db/prisma";

async function main() {
  const topLevelSystemCategories = [
    { name: "支出", type: "expense", isSystem: true },
    { name: "收入", type: "income", isSystem: true },
    { name: "投资", type: "investment", isSystem: true },
    { name: "转账", type: "transfer", isSystem: true },
  ];

  const topLevelMap: Record<string, string> = {};

  for (const cat of topLevelSystemCategories) {
    let existing = await prisma.category.findFirst({
      where: { name: cat.name, type: cat.type }
    });

    if (!existing) {
      existing = await prisma.category.create({
        data: cat
      });
      console.log(`Created: ${cat.type} - ${cat.name}`);
    } else {
      await prisma.category.update({
        where: { id: existing.id },
        data: { isSystem: true, parentId: null }
      });
      console.log(`Updated: ${cat.type} - ${cat.name} (set as top-level, isSystem=true)`);
    }
    topLevelMap[cat.type] = existing.id;
  }

  const allCategories = await prisma.category.findMany({
    where: { parentId: null }
  });

  for (const cat of allCategories) {
    if (topLevelMap[cat.type] && cat.id !== topLevelMap[cat.type]) {
      const children = await prisma.category.findMany({
        where: { parentId: cat.id }
      });

      for (const child of children) {
        await prisma.category.update({
          where: { id: child.id },
          data: { parentId: topLevelMap[cat.type] }
        });
        console.log(`Re-parented: ${child.name} -> ${cat.name} (new parent: ${cat.type})`);
      }

      await prisma.category.delete({ where: { id: cat.id } });
      console.log(`Deleted duplicate: ${cat.type} - ${cat.name}`);
    }
  }

  const finalCategories = await prisma.category.findMany({
    orderBy: [{ type: 'asc' }, { name: 'asc' }]
  });
  console.log('\nFinal categories:');
  finalCategories.forEach(c => {
    console.log(`  ${c.type} | ${c.name} | parentId=${c.parentId} | isSystem=${c.isSystem}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());