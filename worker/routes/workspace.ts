import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sanitizeTheme } from "@shared/theme";
import { FEATURE_KEYS, presetFeatures, presetFor, sanitizeWorkspace, type UseCase } from "@shared/workspace";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { loadSettings, saveSetting } from "../lib/settings";
import { parseBody } from "../lib/validate";

/** Signed-in: what this workspace is for and which features are on. */
export const workspaceRoutes = new Hono<AppEnv>();
workspaceRoutes.get("/", async (c) => c.json((await loadSettings(c.env.DB)).workspace));

const zUseCase = z.enum(["team", "agency", "support", "personal", "startup", "enterprise"] satisfies UseCase[]);

/** Admin console: change the use case and feature switches. */
export const adminWorkspaceRoutes = new Hono<AppEnv>();

adminWorkspaceRoutes.put("/", async (c) => {
  const body = await parseBody(
    c,
    z.object({
      useCase: zUseCase.optional(),
      features: z.partialRecord(z.enum(FEATURE_KEYS), z.boolean()).optional(),
      /**
       * Also reset features, theme and the preset's policy defaults to the use
       * case's preset. Without it, only the use case label (and any listed
       * features) change.
       */
      applyPreset: z.boolean().optional(),
    }),
  );
  const user = c.get("user");
  const settings = await loadSettings(c.env.DB);
  let workspace = settings.workspace;

  if (body.applyPreset) {
    if (!body.useCase) throw new HTTPException(400, { message: "Choose a use case to apply." });
    // Presets can change security policy (for example, requiring two-factor).
    if (user.role !== "owner") throw new HTTPException(403, { message: "Only owners can apply a use-case preset." });
    const preset = presetFor(body.useCase);
    workspace = { useCase: body.useCase, features: presetFeatures(body.useCase) };
    const theme = sanitizeTheme({ ...settings.brand.theme, ...preset.theme }, settings.brand.theme);
    await saveSetting(c.env.DB, "brand", { ...settings.brand, theme }, user.id);
    if (Object.keys(preset.policy).length) await saveSetting(c.env.DB, "policy", { ...settings.policy, ...preset.policy }, user.id);
  }
  workspace = sanitizeWorkspace(
    { useCase: body.useCase ?? workspace.useCase, features: { ...workspace.features, ...body.features } },
    workspace,
  );
  await saveSetting(c.env.DB, "workspace", workspace, user.id);
  await audit(c, {
    action: "settings.workspace_updated",
    targetType: "settings",
    meta: { useCase: workspace.useCase, appliedPreset: !!body.applyPreset, features: body.features ?? null },
  });
  return c.json(workspace);
});
