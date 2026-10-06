import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit, clientIp } from "../lib/audit";
import { hashPassword, passwordProblem } from "../lib/password";
import { rateLimit } from "../lib/ratelimit";
import { createSession } from "../lib/session";
import { createFirstOwner, publicSetupStatus, setupKeyMatches } from "../lib/setup";
import { recordSignIn } from "../lib/sign-ins";
import { parseBody, zEmail } from "../lib/validate";

/** Public: setup progress, and creating the first owner on a fresh install. */
export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get("/status", async (c) => c.json(await publicSetupStatus(c.env)));

setupRoutes.post("/owner", async (c) => {
  const ip = clientIp(c) ?? "unknown";
  // Guessing the setup key must be slow: a handful of tries per address per quarter hour.
  if (!(await rateLimit(c.env.DB, `setup-owner:ip:${ip}`, 8, 900)) || !(await rateLimit(c.env.DB, "setup-owner:all", 60, 900))) {
    throw new HTTPException(429, { message: "Too many attempts. Wait 15 minutes and try again." });
  }
  const body = await parseBody(
    c,
    z.object({
      setupKey: z.string().max(1000),
      name: z.string().trim().min(1, "Enter your name").max(120),
      email: zEmail,
      password: z.string().max(256),
    }),
  );
  // Refuse cheaply once an owner exists, before checking the key.
  const any = await c.env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
  if (any) throw new HTTPException(409, { message: "This workspace already has an owner. Sign in instead." });
  if (!(await setupKeyMatches(c.env, body.setupKey))) {
    await audit(c, { action: "setup.owner_key_rejected", actor: null, meta: { email: body.email } });
    throw new HTTPException(403, { message: "That setup key isn't right. Check where to find it below and paste it again." });
  }
  const problem = passwordProblem(body.password);
  if (problem) throw new HTTPException(400, { message: problem });

  const id = await createFirstOwner(c.env.DB, { email: body.email, name: body.name, passwordHash: await hashPassword(body.password) });
  if (!id) throw new HTTPException(409, { message: "This workspace already has an owner. Sign in instead." });

  await createSession(c, id);
  const actor = { id, email: body.email };
  await audit(c, { action: "setup.owner_created", targetType: "user", targetId: id, actor, meta: { email: body.email } });
  await recordSignIn(c, { outcome: "success", method: "password", user: { id, email: body.email, name: body.name } });
  return c.json({ ok: true, id }, 201);
});
