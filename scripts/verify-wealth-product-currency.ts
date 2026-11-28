/**
 * 理财产品主数据的币种只能是「建主数据那一刻的落库值」，不能当作身份键，
 * 更不能用来拒绝一笔已有记录。
 *
 * 背景（2026-11-27 用户报错）：库里有一条 USD 的理财产品主数据
 * 「FTGF 布兰迪环球增值入息基金A类 @ 众安银行」，而引用它的理财账户是 HKD。
 * 2026-11-02 的重构在 `resolveOrCreateWealthProduct` 里加了「同名产品币种不一致
 * 就抛错」，于是这条记录每次保存都被拦下：
 *   Same-name wealth product already exists, but its currency is USD;
 *   the current currency is HKD
 * 用户上个月（没有该校验时）同样的编辑是正常的，属回归。
 *
 * 规则：产品币种在**新建**时取「显式币种 ?? 账户币种 ?? CNY」；一旦主数据存在，
 * 无论币种是否等于当前账户，一律照用（同一只基金有美元/港币份额，历史记录也可能
 * 就是拿别的币种主数据记的）。防重复由唯一键 (householdId, institutionId, name)
 * 保证，不需要再用币种兜一层。
 */
import assert from "node:assert/strict";

void (async () => {
  const { resolveOrCreateWealthProduct } = await import("../src/lib/server/wealth-product");

  type Row = {
    id: string;
    householdId: string;
    institutionId: string | null;
    name: string;
    productType: string;
    currency: string;
    annualRate: number | null;
    isActive: boolean;
  };

  function fakeTx(rows: Row[]) {
    const created: Row[] = [];
    const tx = {
      wealthProduct: {
        findFirst: async (args: {
          where: {
            id?: string;
            householdId: string;
            institutionId?: string | null;
            name?: string;
            productType?: string;
          };
        }) => {
          const w = args.where;
          return (
            rows.find(
              (row) =>
                (w.id == null || row.id === w.id) &&
                row.householdId === w.householdId &&
                (w.institutionId === undefined || row.institutionId === w.institutionId) &&
                (w.name === undefined || row.name === w.name) &&
                (w.productType === undefined || row.productType === w.productType),
            ) ?? null
          );
        },
        create: async (args: { data: Omit<Row, "id"> }) => {
          const row = { id: `new-${created.length + 1}`, ...args.data };
          created.push(row);
          rows.push(row);
          return row;
        },
      },
    };
    return { tx, created };
  }

  const usdMaster: Row = {
    id: "p-usd",
    householdId: "h1",
    institutionId: "inst-zhongan",
    name: "FTGF布兰迪环球增值入息基金A类",
    productType: "wealth",
    currency: "USD",
    annualRate: null,
    isActive: true,
  };

  // ① 按主键命中（记录自己带的产品外键）+ 账户是 HKD：照用，不抛错。
  {
    const { tx } = fakeTx([{ ...usdMaster }]);
    const product = await resolveOrCreateWealthProduct(tx as never, {
      householdId: "h1",
      productId: "p-usd",
      institutionId: "inst-zhongan",
      currency: "HKD",
      fallbackCurrency: "HKD",
      name: "FTGF布兰迪环球增值入息基金A类",
    });
    assert.equal(product?.id, "p-usd");
    assert.equal(product?.currency, "USD");
  }

  // ② 按「机构 + 名称」命中同名主数据 + 账户是 HKD：照用，不抛错、不新建。
  {
    const { tx, created } = fakeTx([{ ...usdMaster }]);
    const product = await resolveOrCreateWealthProduct(tx as never, {
      householdId: "h1",
      institutionId: "inst-zhongan",
      currency: "HKD",
      fallbackCurrency: "HKD",
      name: "FTGF布兰迪环球增值入息基金A类",
    });
    assert.equal(product?.id, "p-usd");
    assert.equal(created.length, 0, "同名主数据已存在时不得再建一条");
  }

  // ③ 全新产品：币种取显式值；没有显式值时退回账户币种；两者都没有才 CNY。
  {
    const { tx } = fakeTx([]);
    const product = await resolveOrCreateWealthProduct(tx as never, {
      householdId: "h1",
      institutionId: "inst-b",
      currency: "HKD",
      name: "新产品",
    });
    assert.equal(product?.currency, "HKD");
    assert.equal(product?.institutionId, "inst-b");
  }
  {
    const { tx } = fakeTx([]);
    const product = await resolveOrCreateWealthProduct(tx as never, {
      householdId: "h1",
      institutionId: "inst-c",
      currency: null,
      fallbackCurrency: "USD",
      name: "新产品2",
    });
    assert.equal(product?.currency, "USD");
  }
  {
    const { tx } = fakeTx([]);
    const product = await resolveOrCreateWealthProduct(tx as never, {
      householdId: "h1",
      institutionId: null,
      name: "通用产品",
    });
    assert.equal(product?.currency, "CNY");
  }

  // ④ 投顾产品必须带机构（这条是硬的，不要被上面的「宽松」带跑）。
  {
    const { tx } = fakeTx([]);
    await assert.rejects(
      () =>
        resolveOrCreateWealthProduct(tx as never, {
          householdId: "h1",
          productType: "advisor",
          name: "某投顾组合",
        }),
      /机构/,
    );
  }

  console.log("verify-wealth-product-currency: 7 assertions passed");
})();
