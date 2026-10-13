import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlay";

const NODE = `import crypto from "node:crypto";

// secret: the whsec_… value shown when you added the endpoint.
// rawBody: the request body exactly as received (a string, before JSON.parse).
export function verifyWebhook(secret, headers, rawBody) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"] ?? "";
  if (!id || !timestamp) return false;
  // Refuse requests older or newer than 5 minutes (replays).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(\`\${id}.\${timestamp}.\${rawBody}\`).digest("base64");
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    return version === "v1" && signature?.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  });
}

// Express: keep the raw body, verify, then parse.
// app.post("/webhooks/inboxos", express.text({ type: "application/json" }), (req, res) => {
//   if (!verifyWebhook(process.env.INBOXOS_WEBHOOK_SECRET, req.headers, req.body)) return res.sendStatus(401);
//   const event = JSON.parse(req.body); // { type, timestamp, data }
//   res.sendStatus(204);
// });`;

const PYTHON = `import base64, hashlib, hmac, time

def verify_webhook(secret: str, headers: dict, raw_body: bytes) -> bool:
    """secret: the whsec_... value shown when you added the endpoint."""
    msg_id = headers.get("webhook-id")
    timestamp = headers.get("webhook-timestamp")
    signatures = headers.get("webhook-signature", "")
    if not msg_id or not timestamp:
        return False
    # Refuse requests older or newer than 5 minutes (replays).
    if abs(time.time() - int(timestamp)) > 300:
        return False

    key = base64.b64decode(secret.removeprefix("whsec_"))
    signed = f"{msg_id}.{timestamp}.".encode() + raw_body
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    return any(
        version == "v1" and hmac.compare_digest(signature, expected)
        for version, _, signature in (entry.partition(",") for entry in signatures.split())
    )

# Flask:
# @app.post("/webhooks/inboxos")
# def inboxos():
#     if not verify_webhook(os.environ["INBOXOS_WEBHOOK_SECRET"], request.headers, request.get_data()):
#         abort(401)
#     event = request.get_json()  # {"type", "timestamp", "data"}
#     return "", 204`;

/** How to check the signature on the receiving side. */
export function VerifySamples() {
  const [lang, setLang] = useState<"node" | "python">("node");
  const code = lang === "node" ? NODE : PYTHON;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-fg-muted">
        Requests follow the <a className="text-accent-ink hover:underline" href="https://www.standardwebhooks.com" target="_blank" rel="noreferrer">Standard Webhooks</a> spec, so its
        libraries work too. Each request has <code className="font-mono text-xs">webhook-id</code>, <code className="font-mono text-xs">webhook-timestamp</code> and{" "}
        <code className="font-mono text-xs">webhook-signature</code> headers; the signature is an HMAC-SHA256 of <code className="font-mono text-xs">id.timestamp.body</code>.
        Answer with any 2xx within 10 seconds; anything else is retried after 1 minute, 5 minutes, 30 minutes, 2, 6 and 12 hours. Use <code className="font-mono text-xs">webhook-id</code> to ignore repeats.
      </p>
      <div className="flex items-center justify-between gap-2">
        <Tabs value={lang} onChange={setLang} tabs={[{ value: "node", label: "Node.js" }, { value: "python", label: "Python" }]} />
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => (navigator.clipboard.writeText(code), toast.success("Code copied"))}>
          Copy
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto rounded-ui bg-subtle p-3 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  );
}
