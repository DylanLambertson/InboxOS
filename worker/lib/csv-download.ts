import { now } from "./util";

/** A CSV file download (UTF-8 with a BOM so spreadsheet apps pick the right encoding). */
export function csvDownload(name: string, csv: string): Response {
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name.replace(/[^a-z0-9-]/gi, "-")}-${now().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Most rows an export returns. */
export const EXPORT_MAX_ROWS = 10_000;
