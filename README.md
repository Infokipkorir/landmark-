# Landmark Admin — Android App with Push Notifications

This turns your `admin-console.html` into an installable Android app, with push
notifications for new support messages, quote requests, gallery uploads, and
admin logins.

## What's in here

- `www/index.html` — your admin console, with push-registration code added
  (only activates inside the native app; no effect on the regular website)
- `android/` — the native Android project (Capacitor wrapper), ready to open
  in Android Studio
- `supabase-migration/001_push_tokens.sql` — new tables: `admin_push_tokens`
  (which admin owns which device) and `admin_notifications` (event log)
- `supabase-edge-function/index.ts` — sends the actual push via Firebase
  Cloud Messaging whenever a Database Webhook fires

## 1. Run the Supabase migration

Apply `supabase-migration/001_push_tokens.sql` to project `bwcsuxvcqmykhckxqgjh`
(SQL editor, or `apply_migration` via the Supabase MCP tool).

## 2. Create a Firebase project (5 min, your Google account)

1. Go to https://console.firebase.google.com → **Add project** → name it
   anything (e.g. "Landmark Admin").
2. Inside the project: **Add app → Android**.
   - Package name: `co.ke.landmarklandscaping.admin` (must match exactly)
3. Download the generated **`google-services.json`**.
4. Copy it into `android/app/google-services.json` in this project.
5. In Firebase console → **Project settings → Service accounts → Generate
   new private key**. This downloads a second JSON file — this is different
   from `google-services.json`, keep it safe, don't commit it anywhere public.

## 3. Deploy the edge function

```bash
supabase functions deploy send-push-notification --project-ref bwcsuxvcqmykhckxqgjh
supabase secrets set FCM_SERVICE_ACCOUNT_JSON="$(cat path/to/the-service-account-file.json)" --project-ref bwcsuxvcqmykhckxqgjh
```

(Or paste the function code into the Dashboard's Edge Functions editor, and
set the `FCM_SERVICE_ACCOUNT_JSON` secret under Project Settings → Edge
Functions.)

## 4. Wire up Database Webhooks

In Supabase Dashboard → **Database → Webhooks**, create one webhook per
table, all pointing at the deployed `send-push-notification` function URL:

| Table              | Events | 
|--------------------|--------|
| `support_messages` | INSERT |
| `quote_requests`   | INSERT |
| `gallery_images`   | INSERT |
| `admin_sessions`   | INSERT |

(You already have a webhook → `notify-support-email` on `support_messages`;
this is a second, separate webhook on the same table — Supabase allows
multiple webhooks per table.)

## 5. Build the APK

Requires [Android Studio](https://developer.android.com/studio) (free)
installed on your machine — this step can't be done in this sandbox since it
needs the Android SDK.

```bash
cd landmark-app
npx cap sync android      # pulls www/index.html into the native project
npx cap open android      # opens Android Studio
```

In Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK(s)**.
The debug APK lands in `android/app/build/outputs/apk/debug/app-debug.apk` —
copy it to each admin's phone and install (they'll need to allow "install
from unknown sources" once, since it's not on the Play Store).

For a signed release build (recommended if this will live on people's phones
long-term rather than just for testing), Android Studio's **Build → Generate
Signed Bundle/APK** wizard will walk you through creating a keystore —
keep that keystore file safe, you'll need the same one for every future
update.

## 6. Every time you update admin-console.html

```bash
cp admin-console.html www/index.html
npx cap sync android
# rebuild the APK in Android Studio, redistribute to admin phones
```

## Notes

- Each admin who logs in on their phone gets their own row in
  `admin_push_tokens` — multiple devices per admin are fine, and multiple
  admins are fine (RLS ties each token to `auth.uid()`).
- Signing out doesn't currently delete the token row — add a
  `sb.from('admin_push_tokens').delete().eq('fcm_token', ...)` call in your
  sign-out handler if you want stale devices cleaned up immediately (dead
  tokens still get pruned automatically when FCM reports them uninstalled).
- The regular public website is completely unaffected — the push code only
  runs when `Capacitor.isNativePlatform()` is true.
