-- 债券成为独立的业务行类型（EntryBusinessLink.businessType = 'bond'）。
-- 此前债券流水在业务链接层冒充理财（'wealth'），导致备注/关联标签显示「理财交易」，
-- 且侧表指向 wealth_transactions 而不是 bond_transactions。
ALTER TYPE "EntryBusinessType" ADD VALUE IF NOT EXISTS 'bond';
