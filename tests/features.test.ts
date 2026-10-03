import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it } from "vitest";
import { presetFeatures, type FeatureKey } from "../shared/workspace";
import type { AppEnv } from "../worker/env";
import { assertFeature, featureEnabled, featureOffMessage, requireFeature, requireWebhooks, WRITES } from "../worker/lib/features";
import { invalidateSettings } from "../worker/lib/settings";

/** A D1 stand-in that only answers the settings query. */
function fakeDb(features: Partial<Record<FeatureKey, boolean>>): D1Database {
  const workspace = JSON.stringify({ useCase: "team", features: { ...presetFeatures("enterprise"), ...features } });
  return {
    prepare: () => ({ all: async () => ({ results: [{ key: "workspace", value: workspace }] }) }),
  } as unknown as D1Database;
}

function appWith(features: Partial<Record<FeatureKey, boolean>>, mount: (app: Hono<AppEnv>) => void) {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: "boom" }, 500)));
  mount(app);
  const env = { DB: fakeDb(features) } as unknown as AppEnv["Bindings"];
  return (path: string, method = "GET") => app.request(path, { method }, env);
}

beforeEach(() => invalidateSettings());

describe("requireFeature", () => {
  it("lets requests through while the feature is on", async () => {
    const req = appWith({ templates: true }, (app) => {
      app.use("/t/*", requireFeature("templates"));
      app.get("/t", (c) => c.text("ok"));
    });
    const res = await req("/t");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("refuses with a clear 403 while it is off", async () => {
    const req = appWith({ templates: false }, (app) => {
      app.use("/t/*", requireFeature("templates"));
      app.get("/t", (c) => c.text("ok"));
    });
    const res = await req("/t");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Templates is turned off for this workspace." });
  });

  it("can guard only some methods, so reading and deleting keep working", async () => {
    const req = appWith({ push: false }, (app) => {
      app.use("/p/*", requireFeature("push", { methods: ["post"] }));
      app.get("/p", (c) => c.text("key"));
      app.post("/p", (c) => c.text("subscribed"));
      app.delete("/p", (c) => c.text("removed"));
    });
    expect((await req("/p")).status).toBe(200);
    expect((await req("/p", "DELETE")).status).toBe(200);
    expect((await req("/p", "POST")).status).toBe(403);
  });

  it("WRITES covers creating and changing but not deleting", () => {
    expect(WRITES).toEqual(["POST", "PUT", "PATCH"]);
  });

  it("exposes a webhooks guard for the webhooks routes", async () => {
    const off = appWith({ webhooks: false }, (app) => {
      app.use("/w/*", requireWebhooks);
      app.get("/w", (c) => c.text("ok"));
    });
    expect((await off("/w")).status).toBe(403);
    invalidateSettings();
    const on = appWith({ webhooks: true }, (app) => {
      app.use("/w/*", requireWebhooks);
      app.get("/w", (c) => c.text("ok"));
    });
    expect((await on("/w")).status).toBe(200);
  });

  it("assertFeature works inside a handler", async () => {
    const req = appWith({ snooze: false }, (app) => {
      app.post("/bulk", async (c) => {
        await assertFeature(c, "snooze");
        return c.text("ok");
      });
    });
    const res = await req("/bulk", "POST");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(featureOffMessage("snooze"));
  });
});

describe("featureEnabled", () => {
  it("reads the workspace switches", async () => {
    expect(await featureEnabled(fakeDb({ api: false }), "api")).toBe(false);
    invalidateSettings();
    expect(await featureEnabled(fakeDb({ api: true }), "api")).toBe(true);
  });

  it("treats a workspace that was never saved as all defaults", async () => {
    const empty = { prepare: () => ({ all: async () => ({ results: [] }) }) } as unknown as D1Database;
    expect(await featureEnabled(empty, "templates")).toBe(true);
  });

  it("names the feature in the message", () => {
    expect(featureOffMessage("api")).toBe("API & MCP is turned off for this workspace.");
  });
});
