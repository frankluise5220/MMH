/**
 * Legacy alias: `GET /api/v1/debt/repayable-loan-accounts`.
 *
 * The canonical endpoint is `/api/v1/liability/repayable-loan-accounts`
 * (terminology decision 2026-10-06). The old path is kept forever so older
 * clients and bookmarks never 404.
 */
export { GET } from "../../liability/repayable-loan-accounts/route";
