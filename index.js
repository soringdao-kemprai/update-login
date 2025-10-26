/**
 * Appwrite Cloud Function (Node 18)
 *
 * Behavior:
 * - Reads payload from APPWRITE_FUNCTION_DATA or APPWRITE_FUNCTION_PAYLOAD env var, or stdin fallback.
 * - Expects: { profileId, accountId, currentPassword?, newPhone?, newEmail?, name?, newPassword? }
 * - Updates Appwrite Auth user (Users.update) when needed.
 * - Updates profile document in your DB collection when needed.
 * - Always prints a JSON object to stdout (so client SDK can read function output).
 *
 * Make sure these env vars are configured in the function settings:
 * APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID (or APPWRITE_PROJECT), APPWRITE_API_KEY,
 * APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID
 */

const sdk = require("node-appwrite");

function finish(obj) {
  // Always output JSON to stdout so clients / SDKs can parse function result.
  try {
    console.log(JSON.stringify(obj));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, message: "Failed to stringify result", raw: String(obj) }));
  }
  // Do not call process.exit() — let platform handle lifecycle.
}

function safeParseJSON(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    try { return JSON.parse(JSON.parse(raw)); } catch (e2) { return null; }
  }
}

async function readPayload() {
  // Appwrite may provide payload in APPWRITE_FUNCTION_DATA or APPWRITE_FUNCTION_PAYLOAD
  let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;

  if (!raw) {
    // fallback to reading stdin (function invoked with body)
    raw = await new Promise((resolve) => {
      let data = "";
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      // small timeout so we don't block forever in case platform doesn't send stdin
      setTimeout(() => resolve(""), 300);
    });
  }

  if (!raw) return {};
  const parsed = safeParseJSON(raw);
  return parsed || {};
}

(async function main() {
  try {
    const endpoint = process.env.APPWRITE_ENDPOINT;
    const projectId = process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT;
    const apiKey = process.env.APPWRITE_API_KEY;
    const databaseId = process.env.APPWRITE_DATABASE_ID;
    const userCollectionId = process.env.APPWRITE_USER_COLLECTION_ID;

    if (!endpoint || !projectId || !apiKey || !databaseId || !userCollectionId) {
      return finish({
        ok: false,
        message:
          "Missing required environment variables. Ensure APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID (or APPWRITE_PROJECT), APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID are set."
      });
    }

    const body = await readPayload();
    const { profileId, accountId, currentPassword, newPhone, newEmail, name, newPassword } = body || {};

    if (!profileId || !accountId) {
      return finish({ ok: false, message: "profileId and accountId are required in payload", payload: body || {} });
    }

    // Setup SDK client
    const client = new sdk.Client()
      .setEndpoint(endpoint.replace(/\/$/, "")) // strip trailing slash
      .setProject(projectId)
      .setKey(apiKey);

    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Build login identifier if phone provided (Appwrite requires an email-like identifier)
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // 1) Update auth user (if any change)
    let updatedAccount = null;
    const accountUpdateArgs = {};
    if (newIdentifier) accountUpdateArgs.email = newIdentifier;
    if (newPassword && String(newPassword).trim()) accountUpdateArgs.password = String(newPassword).trim();
    if (name && String(name).trim()) accountUpdateArgs.name = String(name).trim();

    if (Object.keys(accountUpdateArgs).length > 0) {
      try {
        // node-appwrite Users.update signature: update(userId, email, password, name, url=null)
        const emailForSdk = accountUpdateArgs.email ?? null;
        const passwordForSdk = accountUpdateArgs.password ?? null;
        const nameForSdk = accountUpdateArgs.name ?? null;

        updatedAccount = await users.update(accountId, emailForSdk, passwordForSdk, nameForSdk);
        console.log("Auth user updated:", { accountId, updatedAccountId: updatedAccount?.$id ?? updatedAccount?.id ?? null });
      } catch (uErr) {
        console.error("Failed to update Auth user:", uErr && uErr.message ? uErr.message : uErr);
        return finish({ ok: false, message: "Failed to update Auth user", detail: (uErr && uErr.message) || uErr });
      }
    } else {
      console.log("No auth update required.");
    }

    // 2) Update profile document in DB collection (PATCH-like)
    let updatedProfile = null;
    const profileData = {};
    if (newPhone) profileData.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileData.email = String(newEmail).trim();
    if (name && String(name).trim()) profileData.name = String(name).trim();

    if (Object.keys(profileData).length > 0) {
      try {
        // databases.updateDocument(databaseId, collectionId, documentId, data, read, write)
        // NOTE: node-appwrite updateDocument signature may vary by SDK version — supply only required args.
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profileData);
        console.log("Profile document updated:", { profileId, updatedProfileId: updatedProfile?.$id ?? updatedProfile?.id ?? null });
      } catch (pErr) {
        console.error("Failed to update profile document:", pErr && pErr.message ? pErr.message : pErr);
        return finish({ ok: false, message: "Failed to update profile document", detail: (pErr && pErr.message) || pErr });
      }
    } else {
      console.log("No profile update required.");
    }

    // Success: return merged result (account/profile)
    return finish({ ok: true, account: updatedAccount ?? null, profile: updatedProfile ?? null });
  } catch (err) {
    console.error("Unhandled function error:", err && err.message ? err.message : err);
    return finish({ ok: false, message: "Unhandled function error", detail: (err && err.message) || String(err) });
  }
})();
