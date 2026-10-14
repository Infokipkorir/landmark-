// supabase/functions/passkey-auth/index.ts
//
// Passkey (WebAuthn) sign-in and management for the Landmark admin console.
//
// Actions (POST JSON { action, ... }):
//   login-options    public   -> WebAuthn request options (discoverable passkey, no email needed)
//   login-verify     public   -> verifies the assertion, returns a one-time token_hash that the
//                                console exchanges for a normal Supabase session (verifyOtp)
//   register-options admin    -> needs the admin's password; { replaceExisting? }
//   register-verify  admin    -> saves the new passkey; if replaceExisting, removes the admin's
//                                other passkeys, push tokens and sessions (the "new phone" reset)
//   remove           admin    -> needs the admin's password; { passkeyId }
//
// Secrets (supabase secrets set ...):
//   PASSKEY_RP_ID      default "landmarklandscaping.co.ke"  (the site's domain, no https://)
//   PASSKEY_RP_NAME    default "Landmark Landscaping Admin"
//   PASSKEY_ORIGINS    comma list of allowed origins. Web: https://landmarklandscaping.co.ke
//                      Android app (native passkeys): android:apk-key-hash:<base64url SHA-256 of signing cert>
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "npm:@simplewebauthn/server@^13";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const RP_ID = Deno.env.get("PASSKEY_RP_ID") ?? "landmarklandscaping.co.ke";
const RP_NAME = Deno.env.get("PASSKEY_RP_NAME") ?? "Landmark Landscaping Admin";
const ORIGINS = (Deno.env.get("PASSKEY_ORIGINS") ??
  `https://${RP_ID},https://www.${RP_ID}`)
  .split(",").map((s) => s.trim()).filter(Boolean);

const MAX_PASSKEYS = 5;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- helpers ----------

function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToB64u(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function currentAdmin(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in first.");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Your session has expired. Sign in again.");
  const { data: profile } = await db
    .from("admin_profiles")
    .select("id, email, full_name")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!profile) throw new HttpError(403, "This account is not an admin.");
  return { token, admin: profile };
}

async function checkPassword(email: string, password: unknown) {
  if (typeof password !== "string" || !password) throw new HttpError(400, "Enter your password to continue.");
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new HttpError(401, "That password is not correct.");
}

async function saveChallenge(challenge: string, purpose: "register" | "login", adminId: string | null, replace = false) {
  await db.from("passkey_challenges").delete().lt("expires_at", new Date().toISOString());
  const { data, error } = await db
    .from("passkey_challenges")
    .insert({ challenge, purpose, admin_id: adminId, replace_existing: replace })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

// One-time use: the row is deleted as it is read.
async function takeChallenge(id: unknown, purpose: "register" | "login") {
  if (typeof id !== "string") throw new HttpError(400, "Missing challenge.");
  const { data } = await db
    .from("passkey_challenges")
    .delete()
    .eq("id", id)
    .eq("purpose", purpose)
    .gt("expires_at", new Date().toISOString())
    .select("challenge, admin_id, replace_existing")
    .maybeSingle();
  if (!data) throw new HttpError(400, "That request expired. Try again.");
  return data;
}

async function logEvent(event_type: string, title: string, body: string) {
  await db.from("admin_notifications").insert({ event_type, title, body, data: {} });
}

const cleanLabel = (v: unknown) =>
  (typeof v === "string" ? v.trim().slice(0, 60) : "") || "Passkey";

// ---------- actions ----------

async function loginOptions() {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
  });
  const challengeId = await saveChallenge(options.challenge, "login", null);
  return { options, challengeId };
}

async function loginVerify(body: any) {
  const ch = await takeChallenge(body.challengeId, "login");
  const cred = body.credential;
  if (!cred?.id) throw new HttpError(400, "Missing passkey response.");

  const { data: pk } = await db.from("admin_passkeys").select("*").eq("credential_id", cred.id).maybeSingle();
  if (!pk) throw new HttpError(401, "This passkey isn't registered. Sign in with your password and add it again.");

  const result = await verifyAuthenticationResponse({
    response: cred,
    expectedChallenge: ch.challenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    credential: {
      id: pk.credential_id,
      publicKey: b64uToBytes(pk.public_key),
      counter: Number(pk.counter),
      transports: pk.transports ?? undefined,
    },
  });
  if (!result.verified) throw new HttpError(401, "Passkey could not be verified.");

  await db.from("admin_passkeys").update({
    counter: result.authenticationInfo.newCounter,
    last_used_at: new Date().toISOString(),
  }).eq("id", pk.id);

  const { data: profile } = await db.from("admin_profiles").select("email").eq("id", pk.admin_id).maybeSingle();
  if (!profile?.email) throw new HttpError(403, "This account is not an admin.");

  // generateLink does not send an email; it only returns a one-time token the console verifies.
  const { data: link, error } = await db.auth.admin.generateLink({ type: "magiclink", email: profile.email });
  if (error || !link?.properties?.hashed_token) throw new HttpError(500, "Could not start your session.");
  return { token_hash: link.properties.hashed_token };
}

async function registerOptions(req: Request, body: any) {
  const { admin } = await currentAdmin(req);
  await checkPassword(admin.email, body.password);

  const { data: existing } = await db
    .from("admin_passkeys")
    .select("credential_id, transports")
    .eq("admin_id", admin.id);
  const replace = body.replaceExisting === true;
  if (!replace && (existing?.length ?? 0) >= MAX_PASSKEYS) {
    throw new HttpError(400, `You can keep up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: admin.email,
    userDisplayName: admin.full_name || admin.email,
    userID: new TextEncoder().encode(admin.id),
    attestationType: "none",
    excludeCredentials: replace
      ? []
      : (existing ?? []).map((p) => ({ id: p.credential_id, transports: p.transports ?? undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
  });
  const challengeId = await saveChallenge(options.challenge, "register", admin.id, replace);
  return { options, challengeId };
}

async function registerVerify(req: Request, body: any) {
  const { token, admin } = await currentAdmin(req);
  const ch = await takeChallenge(body.challengeId, "register");
  if (ch.admin_id !== admin.id) throw new HttpError(403, "That request belongs to another account.");

  const result = await verifyRegistrationResponse({
    response: body.credential,
    expectedChallenge: ch.challenge,
    expectedOrigin: ORIGINS,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });
  if (!result.verified || !result.registrationInfo) throw new HttpError(400, "Passkey could not be verified.");

  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  const label = cleanLabel(body.label);

  const { data: saved, error } = await db.from("admin_passkeys").insert({
    admin_id: admin.id,
    credential_id: credential.id,
    public_key: bytesToB64u(credential.publicKey),
    counter: credential.counter,
    transports: body.credential?.response?.transports ?? credential.transports ?? null,
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp,
    device_label: label,
  }).select("id").single();
  if (error) {
    if (String(error.message).includes("duplicate")) throw new HttpError(409, "This passkey is already saved.");
    throw error;
  }

  if (ch.replace_existing) {
    // New phone: drop every other passkey, push token and session for this admin.
    await db.from("admin_passkeys").delete().eq("admin_id", admin.id).neq("id", saved.id);
    await db.from("admin_push_tokens").delete().eq("admin_id", admin.id);
    const keep = typeof body.keepSessionToken === "string" ? body.keepSessionToken : "";
    await db.from("admin_sessions").delete().eq("admin_id", admin.id).neq("session_token", keep);
    await db.auth.admin.signOut(token, "others");
    await logEvent("passkey_reset", "Passkeys replaced", `${admin.full_name || admin.email} replaced their passkeys with "${label}".`);
  } else {
    await logEvent("passkey_added", "Passkey added", `${admin.full_name || admin.email} added the passkey "${label}".`);
  }
  return { ok: true };
}

async function removePasskey(req: Request, body: any) {
  const { admin } = await currentAdmin(req);
  await checkPassword(admin.email, body.password);
  if (typeof body.passkeyId !== "string") throw new HttpError(400, "Missing passkey.");
  const { data, error } = await db.from("admin_passkeys").delete()
    .eq("id", body.passkeyId).eq("admin_id", admin.id).select("device_label");
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, "Passkey not found.");
  await logEvent("passkey_removed", "Passkey removed", `${admin.full_name || admin.email} removed the passkey "${data[0].device_label ?? "Passkey"}".`);
  return { ok: true };
}

// ---------- entry ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    switch (body?.action) {
      case "login-options": return json(await loginOptions());
      case "login-verify": return json(await loginVerify(body));
      case "register-options": return json(await registerOptions(req, body));
      case "register-verify": return json(await registerVerify(req, body));
      case "remove": return json(await removePasskey(req, body));
      default: throw new HttpError(400, "Unknown action.");
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    // Logged in full (origin mismatches show up here); the client only sees a generic message.
    console.error("passkey-auth failed:", err);
    return json({ error: "Passkey request failed. Check the function logs." }, 500);
  }
});
