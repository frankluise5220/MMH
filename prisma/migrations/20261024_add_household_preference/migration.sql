-- 账簿级设置入库：此前这些值只存在于浏览器 cookie，换设备/清缓存就丢，
-- 而且服务端完全读不到（时区、语言、日期格式都需要服务端一致）。
-- 新表 1:1 于 Household，主键即 householdId，因此不需要额外索引。
CREATE TABLE "HouseholdPreference" (
    "householdId" TEXT NOT NULL,
    "sessionDays" INTEGER NOT NULL DEFAULT 30,
    "fundUnitsDecimals" INTEGER NOT NULL DEFAULT 2,
    "aiPanelEnabled" BOOLEAN NOT NULL DEFAULT true,
    "timeZone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "colorScheme" TEXT NOT NULL DEFAULT 'red_up_green_down',
    "creditCardLabelMode" TEXT NOT NULL DEFAULT 'short_last4',
    "creditCardLabelTemplate" TEXT,
    "creditCardSidebarLabelTemplate" TEXT,
    "creditBillHideZero" BOOLEAN NOT NULL DEFAULT false,
    "creditBillHideSettled" BOOLEAN NOT NULL DEFAULT false,
    "creditBillShowRecentCycles" BOOLEAN NOT NULL DEFAULT true,
    "displayLanguage" TEXT NOT NULL DEFAULT 'zh-CN',
    "dateDisplayFormat" TEXT NOT NULL DEFAULT 'yyyy-mm-dd',
    "sidebarGroupBy" TEXT NOT NULL DEFAULT 'kind',
    "sidebarHideZero" BOOLEAN NOT NULL DEFAULT false,
    "sidebarHideInitialData" BOOLEAN NOT NULL DEFAULT false,
    "sidebarShowFixedAssets" BOOLEAN NOT NULL DEFAULT true,
    "sidebarShowAllCashEntries" BOOLEAN NOT NULL DEFAULT true,
    "sidebarShowReimbursements" BOOLEAN NOT NULL DEFAULT true,
    "detailDateBackground" BOOLEAN NOT NULL DEFAULT false,
    "rowHeightMode" INTEGER NOT NULL DEFAULT 35,
    "accountLabelFields" TEXT,
    "accountDropdownRestrictType" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseholdPreference_pkey" PRIMARY KEY ("householdId")
);

ALTER TABLE "HouseholdPreference"
    ADD CONSTRAINT "HouseholdPreference_householdId_fkey"
    FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
