// supabase/functions/send-push-notification/index.ts
//
// Triggered by Supabase Database Webhooks on INSERT for:
//   support_messages, quote_requests, gallery_images, admin_sessions
//
// Secrets required (set via `supabase secrets set` or the Dashboard):
//   FCM_SERVICE_ACCOUNT_JSON  -> the full JSON key file from Firebase console
//                                 (Project settings > Service accounts > Generate new private key)
//   SUPABASE_SERVICE_ROLE_KEY -> already available by default in edge functions
//   SUPABASE_URL              -> already available by default in edge functions

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------- Build a notification from the webhook payload ----------

function buildNotification(payload: any): { event_type: string; title: string; body: string; data: Record<string, unknown> } | null {
  const table = payload.table;
  const row = payload.record;

  switch (table) {
    case "support_messages":
      return {
        event_type: "support_message",
        title: "New support message",
        body: (row.message || "").slice(0, 140) || "New message from a visitor",
        data: { thread_id: row.thread_id ?? "" },
      };
    case "quote_requests":
      return {
        event_type: "quote_request",
        title: "New quote request",
        body: `${row.name || "Someone"} requested a quote${row.service ? " for " + row.service : ""}`,
        data: { quote_id: row.id ?? "" },
      };
    case "gallery_images":
      return {
        event_type: "gallery_upload",
        title: "Gallery updated",
        body: "A new image was added to the gallery",
        data: { image_id: row.id ?? "" },
      };
    case "admin_sessions":
      // Only notify on a genuinely new login, not every heartbeat upsert
      if (payload.type !== "INSERT") return null;
      return {
        event_type: "admin_login",
        title: "New admin login",
        body: `An admin signed in${row.device_label ? " on " + row.device_label : ""}`,
        data: { admin_id: row.admin_id ?? "" },
      };
    default:
      return null;
  }
}

// ---------- FCM HTTP v1 auth (service-account JWT -> OAuth token) ----------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<{ token: string; projectId: string }> {
  const sa = JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT_JSON")!);

  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return { token: cachedToken.token, projectId: sa.project_id };
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const unsigned = `${enc(header)}.${enc(claims)}`;

  const pemBody = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );

  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = `${unsigned}.${encodedSig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) throw new Error(`OAuth token exchange failed: ${await res.text()}`);
  const json = await res.json();
  cachedToken = { token: json.access_token, expiresAt: now * 1000 + json.expires_in * 1000 };
  return { token: cachedToken.token, projectId: sa.project_id };
}

async function sendToToken(token: string, projectId: string, accessToken: string, title: string, body: string, data: Record<string, unknown>) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: { priority: "high" },
      },
    }),
  });
  return { ok: res.ok, status: res.status, body: res.ok ? null : await res.text() };
}

// ---------- Main handler ----------

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const notif = buildNotification(payload);
    if (!notif) return new Response("ignored", { status: 200 });

    // Log it so the app's in-app notification center can show history too
    await supabase.from("admin_notifications").insert({
      event_type: notif.event_type,
      title: notif.title,
      body: notif.body,
      data: notif.data,
    });

    const { data: tokens, error } = await supabase.from("admin_push_tokens").select("fcm_token");
    if (error) throw error;
    if (!tokens || tokens.length === 0) return new Response("no devices registered", { status: 200 });

    const { token: accessToken, projectId } = await getAccessToken();

    const results = await Promise.all(
      tokens.map((t) => sendToToken(t.fcm_token, projectId, accessToken, notif.title, notif.body, notif.data)),
    );

    // Clean up dead tokens (app uninstalled / token rotated)
    const deadTokens = tokens
      .filter((_, i) => !results[i].ok && (results[i].body || "").includes("UNREGISTERED"))
      .map((t) => t.fcm_token);
    if (deadTokens.length > 0) {
      await supabase.from("admin_push_tokens").delete().in("fcm_token", deadTokens);
    }

    return new Response(JSON.stringify({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(String(err), { status: 500 });
  }
});
