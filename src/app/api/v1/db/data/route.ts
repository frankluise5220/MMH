import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

/**
 * Agent-safe generic database API.
 *
 * GET    /api/v1/db/data?model=TxRecord&take=100&skip=0
 * POST   /api/v1/db/data { model, data }
 * PUT    /api/v1/db/data { model, id, data }
 * DELETE /api/v1/db/data?model=TxRecord&id=...
 *
 * Auth: browser session cookie, Authorization: Bearer <admin password>, or X-Api-Key.
 * This route intentionally blocks secret-bearing models and scopes household models
 * to the authenticated household.
 */

type ModelField = {
  name: string;
  type: string;
  kind: string;
  isRequired: boolean;
  isId: boolean;
  isReadOnly?: boolean;
  hasDefaultValue?: boolean;
};

type ModelInfo = {
  name: string;
  clientName: string;
  fields: readonly ModelField[];
};

const BLOCKED_MODELS = new Set([
  "AccessKey",
  "AiChannel",
  "ApiKey",
  "EmailAccount",
  "FundQueryApi",
  "PasswordResetToken",
  "SystemSetting",
  "User",
  "UserSettings",
]);

const READ_ALLOWED_MODELS = new Set([
  "Account",
  "AccountAlias",
  "AccountGroup",
  "BillOverride",
  "Category",
  "CommandAlias",
  "CreditCardCycle",
  "FundConfirmDays",
  "FundFeeRate",
  "FundHolding",
  "FundNavCache",
  "FundSnapshot",
  "Institution",
  "InsuranceProduct",
  "RegularInvestPlan",
  "Tag",
  "TxRecord",
]);

const WRITE_ALLOWED_MODELS = new Set([
  "Account",
  "AccountAlias",
  "AccountGroup",
  "BillOverride",
  "Category",
  "CommandAlias",
  "CreditCardCycle",
  "FundConfirmDays",
  "FundFeeRate",
  "FundNavCache",
  "Institution",
  "InsuranceProduct",
  "RegularInvestPlan",
  "Tag",
  "TxRecord",
]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function lowerFirst(value: string) {
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}

function getModelInfo(input: string): ModelInfo | null {
  const dmmfModels = Prisma?.dmmf?.datamodel?.models ?? [];
  const matched = dmmfModels.find((model: any) => model.name === input || lowerFirst(model.name) === input);
  if (!matched) return null;
  return {
    name: matched.name,
    clientName: lowerFirst(matched.name),
    fields: matched.fields.map((field: ModelField) => ({
      name: field.name,
      type: field.type,
      kind: field.kind,
      isRequired: field.isRequired,
      isId: field.isId,
      isReadOnly: field.isReadOnly,
      hasDefaultValue: field.hasDefaultValue,
    })),
  };
}

function getPrismaModel(modelInfo: ModelInfo) {
  return (prisma as any)[modelInfo.clientName];
}

function jsonNumber(raw: unknown, fallback: number) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function serializeRow(row: any) {
  const processed: any = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Prisma.Decimal) processed[key] = value.toString();
    else if (value instanceof Date) processed[key] = value.toISOString();
    else processed[key] = value;
  }
  return processed;
}

function parseJsonParam(raw: string | null) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("where 必须是 JSON object");
  }
  return parsed;
}

function normalizeScalarValue(field: ModelField, value: unknown) {
  if (value === undefined) return undefined;
  if (value === "" || value === null) return field.isRequired ? undefined : null;

  switch (field.type) {
    case "Boolean":
      if (typeof value === "boolean") return value;
      if (String(value).toLowerCase() === "true") return true;
      if (String(value).toLowerCase() === "false") return false;
      return undefined;
    case "Int": {
      const n = Number(value);
      return Number.isInteger(n) ? n : undefined;
    }
    case "Float": {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case "Decimal":
      return String(value);
    case "DateTime": {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
    default:
      return value;
  }
}

function normalizeData(modelInfo: ModelInfo, data: Record<string, unknown>, mode: "create" | "update") {
  const fieldMap = new Map(modelInfo.fields.map((field) => [field.name, field]));
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const field = fieldMap.get(key);
    if (!field || field.kind !== "scalar") continue;
    if (field.isId || field.isReadOnly) continue;
    if (mode === "update" && (key === "createdAt" || key === "updatedAt" || key === "householdId")) continue;
    const nextValue = normalizeScalarValue(field, value);
    if (nextValue !== undefined) normalized[key] = nextValue;
  }

  return normalized;
}

function hasField(modelInfo: ModelInfo, fieldName: string) {
  return modelInfo.fields.some((field) => field.name === fieldName);
}

function hasRelation(modelInfo: ModelInfo, relationName: string) {
  return modelInfo.fields.some((field) => field.kind === "object" && field.name === relationName);
}

function assertModelAllowed(modelInfo: ModelInfo, write = false) {
  if (BLOCKED_MODELS.has(modelInfo.name)) {
    throw new Error(`模型 ${modelInfo.name} 不允许通过 Agent DB API 访问`);
  }
  if (!READ_ALLOWED_MODELS.has(modelInfo.name)) {
    throw new Error(`模型 ${modelInfo.name} 未列入 Agent DB API 访问白名单`);
  }
  if (write && !WRITE_ALLOWED_MODELS.has(modelInfo.name)) {
    throw new Error(`模型 ${modelInfo.name} 不允许通过 Agent DB API 写入`);
  }
}

function scopedWhere(modelInfo: ModelInfo, householdId: string, baseWhere: Record<string, unknown> = {}) {
  if (hasField(modelInfo, "householdId")) return { ...baseWhere, householdId };
  if (hasRelation(modelInfo, "Account")) return { ...baseWhere, Account: { householdId } };
  if (hasRelation(modelInfo, "account")) return { ...baseWhere, account: { householdId } };
  if (hasRelation(modelInfo, "transactions")) return { ...baseWhere, transactions: { householdId } };
  return baseWhere;
}

async function validateReferencedOwnership(data: Record<string, unknown>, householdId: string) {
  const accountIds = new Set<string>();
  for (const key of ["accountId", "toAccountId", "cashAccountId"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) accountIds.add(value.trim());
  }

  if (accountIds.size > 0) {
    const count = await prisma.account.count({
      where: { id: { in: [...accountIds] }, householdId },
    });
    if (count !== accountIds.size) throw new Error("引用账户不存在或不属于当前账簿");
  }

  const entryId = data.entryId;
  if (typeof entryId === "string" && entryId.trim()) {
    const existing = await prisma.txRecord.findFirst({
      where: { id: entryId.trim(), householdId },
      select: { id: true },
    });
    if (!existing) throw new Error("引用交易不存在或不属于当前账簿");
  }
}

async function requireScope(req: Request) {
  try {
    return await getApiHouseholdScope(req);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "未授权" },
      { status: 401, headers: corsHeaders() },
    );
  }
}

function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

async function ensureOwnedRecord(model: any, modelInfo: ModelInfo, id: string, householdId: string) {
  const existing = await model.findFirst({ where: scopedWhere(modelInfo, householdId, { id }) });
  if (!existing) return { ok: false as const, status: 404, error: "记录不存在" };
  return { ok: true as const, existing };
}

export async function GET(req: NextRequest) {
  const scope = await requireScope(req);
  if (isResponse(scope)) return scope;

  try {
    const { searchParams } = new URL(req.url);
    const modelInfo = getModelInfo(searchParams.get("model") ?? "");
    if (!modelInfo) return NextResponse.json({ ok: false, error: "缺少或无效的 model 参数" }, { status: 400, headers: corsHeaders() });
    assertModelAllowed(modelInfo);

    const model = getPrismaModel(modelInfo);
    if (!model) return NextResponse.json({ ok: false, error: `模型 ${modelInfo.name} 不存在` }, { status: 400, headers: corsHeaders() });

    const take = Math.min(Math.max(jsonNumber(searchParams.get("take"), 100), 1), 500);
    const skip = Math.max(jsonNumber(searchParams.get("skip"), 0), 0);
    const orderByField = searchParams.get("orderBy") || (hasField(modelInfo, "createdAt") ? "createdAt" : "id");
    const orderByDir = searchParams.get("orderDir") === "asc" ? "asc" : "desc";
    if (!hasField(modelInfo, orderByField)) {
      return NextResponse.json({ ok: false, error: `排序字段 ${orderByField} 不存在` }, { status: 400, headers: corsHeaders() });
    }

    const where = {
      ...scopedWhere(modelInfo, scope.householdId, parseJsonParam(searchParams.get("where"))),
    };

    const [data, total] = await Promise.all([
      model.findMany({ where, orderBy: { [orderByField]: orderByDir }, take, skip }),
      model.count({ where }),
    ]);

    return NextResponse.json({ ok: true, data: data.map(serializeRow), page: { take, skip, total } }, { headers: corsHeaders() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "查询失败" }, { status: 500, headers: corsHeaders() });
  }
}

export async function POST(req: NextRequest) {
  const scope = await requireScope(req);
  if (isResponse(scope)) return scope;

  try {
    const body = await req.json();
    const modelInfo = getModelInfo(String(body?.model ?? ""));
    if (!modelInfo || !body?.data) {
      return NextResponse.json({ ok: false, error: "缺少 model 或 data 参数" }, { status: 400, headers: corsHeaders() });
    }
    assertModelAllowed(modelInfo, true);

    const model = getPrismaModel(modelInfo);
    const data = normalizeData(modelInfo, body.data, "create");
    if (hasField(modelInfo, "householdId")) data.householdId = scope.householdId;
    await validateReferencedOwnership(data, scope.householdId);

    const created = await model.create({ data });
    return NextResponse.json({ ok: true, data: serializeRow(created) }, { headers: corsHeaders() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "创建失败" }, { status: 500, headers: corsHeaders() });
  }
}

export async function PUT(req: NextRequest) {
  const scope = await requireScope(req);
  if (isResponse(scope)) return scope;

  try {
    const body = await req.json();
    const modelInfo = getModelInfo(String(body?.model ?? ""));
    const id = String(body?.id ?? "").trim();
    if (!modelInfo || !id || !body?.data) {
      return NextResponse.json({ ok: false, error: "缺少 model、id 或 data 参数" }, { status: 400, headers: corsHeaders() });
    }
    assertModelAllowed(modelInfo, true);

    const model = getPrismaModel(modelInfo);
    const ownership = await ensureOwnedRecord(model, modelInfo, id, scope.householdId);
    if (!ownership.ok) return NextResponse.json({ ok: false, error: ownership.error }, { status: ownership.status, headers: corsHeaders() });

    const data = normalizeData(modelInfo, body.data, "update");
    await validateReferencedOwnership(data, scope.householdId);
    const updated = await model.update({ where: { id }, data });
    return NextResponse.json({ ok: true, data: serializeRow(updated) }, { headers: corsHeaders() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "更新失败" }, { status: 500, headers: corsHeaders() });
  }
}

export async function DELETE(req: NextRequest) {
  const scope = await requireScope(req);
  if (isResponse(scope)) return scope;

  try {
    const { searchParams } = new URL(req.url);
    const modelInfo = getModelInfo(searchParams.get("model") ?? "");
    const id = String(searchParams.get("id") ?? "").trim();
    if (!modelInfo || !id) {
      return NextResponse.json({ ok: false, error: "缺少 model 或 id 参数" }, { status: 400, headers: corsHeaders() });
    }
    assertModelAllowed(modelInfo, true);

    const model = getPrismaModel(modelInfo);
    const ownership = await ensureOwnedRecord(model, modelInfo, id, scope.householdId);
    if (!ownership.ok) return NextResponse.json({ ok: false, error: ownership.error }, { status: ownership.status, headers: corsHeaders() });

    await model.delete({ where: { id } });
    return NextResponse.json({ ok: true }, { headers: corsHeaders() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "删除失败" }, { status: 500, headers: corsHeaders() });
  }
}
