export type EntriesDeleteRequest = {
  entryIds: string[];
  action?: undefined;
} | {
  action: "restore";
  transactionIds: string[];
};

export type EntriesDeleteResponse =
  | { ok: true; message: string; count?: number }
  | { ok: false; error: string };

export async function callDeleteEntries(body: EntriesDeleteRequest): Promise<EntriesDeleteResponse> {
  const res = await fetch("/api/v1/entries/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}