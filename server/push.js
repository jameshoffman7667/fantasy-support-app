// Web Push (VAPID) notifications — delivered through the browser/PWA's
// service worker, so an installed home-screen PWA can receive alerts
// without needing a separate native app. This is what actually powers
// pre-kickoff alerts; a true native Android wrapper with FCM push is a
// larger, separate undertaking (packaging, signing, Play Store review)
// not attempted here — see the functional spec's known-limitations note.
//
// Requires the `web-push` npm package (added to server/package.json) and
// a VAPID key pair (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars — see
// README for how to generate one with `npx web-push generate-vapid-keys`).
// Not independently verified end-to-end in this sandbox (no browser here
// to actually receive a push) — same limitation as other Docker/runtime
// changes in this project that can't be tested without a live deploy.
import webpush from "web-push";
import { addPushSubscription, getAllPushSubscriptions, deletePushSubscription } from "./db.js";

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let configured = false;

export function isPushConfigured() {
  return Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
}

function ensureConfigured() {
  if (configured || !isPushConfigured()) return;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
}

export function getPublicKey() {
  return VAPID_PUBLIC || null;
}

export function saveSubscription(subscription) {
  addPushSubscription(subscription.endpoint, JSON.stringify(subscription));
}

export function removeSubscription(endpoint) {
  deletePushSubscription(endpoint);
}

/** Sends one notification payload to every subscribed browser. Prunes
 * subscriptions the push service reports as gone (404/410) so a stale
 * entry doesn't fail on every future alert. */
export async function sendPushToAll(payload) {
  if (!isPushConfigured()) return { sent: 0, skipped: "VAPID keys not configured" };
  ensureConfigured();
  const subs = getAllPushSubscriptions();
  let sent = 0;
  await Promise.all(
    subs.map(async (row) => {
      try {
        await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify(payload));
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          deletePushSubscription(row.endpoint);
        } else {
          console.warn(`[push] Failed to deliver to one subscription: ${err.message}`);
        }
      }
    })
  );
  return { sent, total: subs.length };
}
