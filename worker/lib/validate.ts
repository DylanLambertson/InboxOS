import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/** Parse and validate a JSON body; responds 400 with a readable message on failure. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Request body must be JSON" });
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
    throw new HTTPException(400, { message: `${path}${issue.message}` });
  }
  return r.data;
}

export const zEmail = z.string().trim().toLowerCase().email().max(254);
export const zAddress = z.object({ email: zEmail, name: z.string().trim().max(200).optional() });
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #4f46e5");
export const zId = z.string().min(1).max(64);
