"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  initialFundCode: string;
  baseQuery: URLSearchParams;
  view: "investmoney" | "investfund";
  children: (fundCode: string, setFundCode: (code: string) => void) => React.ReactNode;
};

export function FundViewWrapper({ initialFundCode, baseQuery, view, children }: Props) {
  const router = useRouter();
  const [fundCode, setFundCode] = useState(initialFundCode);

  function switchFund(code: string) {
    setFundCode(code);
    // Update URL without full navigation
    const q = new URLSearchParams(baseQuery);
    q.set("view", view);
    q.set("fundCode", code);
    const url = `/?${q.toString()}`;
    window.history.replaceState(null, "", url);
  }

  return <>{children(fundCode, switchFund)}</>;
}
