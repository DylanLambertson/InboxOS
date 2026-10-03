import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AVATAR_MAX_BYTES, avatarUrl, type Teammate } from "@shared/profile";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { isAvatarKeyFor, newAvatarKey, sniffImageType } from "../lib/avatar";
import { getPolicy } from "../lib/settings";
import { getUser, profileFields, toMe, type UserRow } from "../lib/users";
import { now } from "../lib/util";

// ---- My photo (mounted at /api/me/avatar) ----------------------------------------------------

export const meAvatarRoutes = new Hono<AppEnv>();

/** Upload a profile photo (PNG, JPEG, WebP or GIF, up to 2 MB). Replaces any previous one. */
meAvatarRoutes.post("/", async (c) => {
  const declared = Number(c.req.header("content-length") ?? 0);
  // Multipart adds a little overhead around the file itself.
  if (declared > AVATAR_MAX_BYTES + 64 * 1024) throw new HTTPException(413, { message: "Photos can be up to 2 MB." });
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new HTTPException(400, { message: "Upload a photo." });
  }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new HTTPException(400, { message: "Upload a photo." });
  if (file.size > AVATAR_MAX_BYTES) throw new HTTPException(413, { message: "Photos can be up to 2 MB." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Trust the bytes, not the declared type: this decides how the photo is served.
  const type = sniffImageType(bytes.subarray(0, 16));
  if (!type) throw new HTTPException(400, { message: "Use a PNG, JPEG, WebP or GIF image." });

  const u = c.get("user");
  const user = await getUser(c.env.DB, u.id);
  if (!user) throw new HTTPException(404);
  const key = newAvatarKey(u.id);
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
  await c.env.DB.prepare("UPDATE users SET avatar_key = ?, updated_at = ? WHERE id = ?").bind(key, now(), u.id).run();
  if (isAvatarKeyFor(u.id, user.avatar_key)) await c.env.FILES.delete(user.avatar_key).catch(() => undefined);
  await audit(c, { action: "user.avatar_updated", targetType: "user", targetId: u.id });
  const updated = await getUser(c.env.DB, u.id);
  return c.json(toMe(updated!, await getPolicy(c.env.DB)));
});

/** Remove the photo and go back to initials. */
meAvatarRoutes.delete("/", async (c) => {
  const u = c.get("user");
  const user = await getUser(c.env.DB, u.id);
  if (!user) throw new HTTPException(404);
  if (user.avatar_key) {
    await c.env.DB.prepare("UPDATE users SET avatar_key = NULL, updated_at = ? WHERE id = ?").bind(now(), u.id).run();
    if (isAvatarKeyFor(u.id, user.avatar_key)) await c.env.FILES.delete(user.avatar_key).catch(() => undefined);
    await audit(c, { action: "user.avatar_removed", targetType: "user", targetId: u.id });
  }
  const updated = await getUser(c.env.DB, u.id);
  return c.json(toMe(updated!, await getPolicy(c.env.DB)));
});

// ---- Anyone's photo (mounted at /api/users) ----------------------------------------------------

export const userRoutes = new Hono<AppEnv>();

/**
 * A teammate's photo, for signed-in people only. The URL carries the photo's random key
 * (?v=…), so a matching request is cached for a year; a new photo means a new URL.
 */
userRoutes.get("/:id/avatar", async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.notFound();
  const row = await c.env.DB.prepare("SELECT avatar_key FROM users WHERE id = ?").bind(id).first<{ avatar_key: string | null }>();
  if (!row || !isAvatarKeyFor(id, row.avatar_key)) return c.notFound();
  const version = row.avatar_key.split("/").pop()!;
  const etag = `"${version}"`;
  const cache = c.req.query("v") === version ? "private, max-age=31536000, immutable" : "private, no-cache";
  if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cache } });
  const obj = await c.env.FILES.get(row.avatar_key);
  if (!obj) return c.notFound();
  const type = obj.httpMetadata?.contentType ?? "";
  return new Response(obj.body, {
    headers: {
      "Content-Type": /^image\/(png|jpeg|webp|gif)$/.test(type) ? type : "application/octet-stream",
      "Cache-Control": cache,
      ETag: etag,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// ---- Team directory (mounted at /api/people) ----------------------------------------------------

export const peopleRoutes = new Hono<AppEnv>();

type DirectoryRow = Pick<UserRow, "id" | "name" | "email" | "avatar_color" | "avatar_key" | "job_title" | "phone" | "bio" | "pronouns" | "department" | "location" | "timezone" | "website">;

/** Everyone active in the workspace, for the People directory. */
peopleRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, email, avatar_color, avatar_key, job_title, phone, bio, pronouns, department, location, timezone, website
     FROM users WHERE status = 'active' ORDER BY name COLLATE NOCASE, email LIMIT 5000`,
  ).all<DirectoryRow>();
  return c.json(
    results.map<Teammate>((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      color: r.avatar_color,
      avatarUrl: avatarUrl(r.id, r.avatar_key),
      jobTitle: r.job_title ?? "",
      phone: r.phone ?? "",
      ...profileFields(r),
    })),
  );
});
