/**
 * Appwrite Cloud Function: update-login
 *
 * Required environment variables (set in the Appwrite function UI):
 *  - APPWRITE_ENDPOINT          (e.g. https://nyc.cloud.appwrite.io/v1)
 *  - APPWRITE_PROJECT_ID       (project id)
 *  - APPWRITE_API_KEY          (server key / dynamic key with necessary perms)
 *  - APPWRITE_DATABASE_ID
 *  - APPWRITE_USER_COLLECTION_ID
 *
 * Payload expected (JSON) - passed when calling Functions.createExecution:
 * {
 *   "profileId": "<document id in user collection>",
 *   "accountId": "<appwrite auth user id (account id)>",
 *   "currentPassword": "<user's current password - optional>",
 *   "newPhone": "9876543210",       // digits-only or any string
 *   "newEmail": "you@example.com",  // optional
 *   "name": "Full Name",            // optional
 *   "newPassword": "..."            // optional
 * }
 *
 * ALWAYS returns JSON to stdout:
 *   { ok: true, account: <account-response-or-null>, profile: <profile-response-or-null> }
 * or { ok: false, message: "...", detail: ... }
 */

const sdk = require("node-appwrite");

// helper to ensure we always output JSON to stdout for Appwrite
function finish(obj) {
  try {
    console.log(JSON.stringify(obj));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, message: "Failed to stringify result", raw: String(obj) }));
  }
  // do NOT call process.exit() immediately; runtime handles closure
}

/**
 * Read payload robustly:
 *  - APPWRITE_FUNCTION_DATA (recommended)
 *  - APPWRITE_FUNCTION_PAYLOAD (older)
 *  - stdin (some runtimes)
 *  - Also support Appwrite HTTP wrapper where req.body may be stringified
 */
async function readPayload() {
  let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;

  if (!raw) {
    raw = await new Promise((resolve) => {
      let data = "";
      if (typeof process.stdin === "undefined") return resolve("");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => resolve(data));
      // small timeout fallback
      setTimeout(() => resolve(data), 300);
    });
  }

  if (!raw) return {};

  // If Appwrite passed an object-like wrapper (as in function simulator logs), try to pluck body
  try {
    // raw might already be an object (when local dev)
    if (typeof raw === "object") {
      return raw;
    }
    let parsed = JSON.parse(raw);

    // some Appwrite dashboards pass structure { req: { body: "..." } }
    if (parsed && parsed.req && parsed.req.body) {
      try {
        return JSON.parse(parsed.req.body);
      } catch (_) {
        // maybe already JSON object
        try { return parsed.req.body; } catch (__) { /* fallback */ }
      }
    }

    // when payload is nested stringified JSON
    if (typeof parsed === "string") {
      try { return JSON.parse(parsed); } catch (_) { return parsed; }
    }

    return parsed || {};
  } catch (e) {
    // If parse fails, return empty
    return {};
  }
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
          "Missing required environment variables. Ensure APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID are set."
      });
    }

    const body = await readPayload();

    // if function invoked via HTTP wrapper in console, the payload may be under bodyJson or body
    const payload = body.bodyJson ?? body.body ?? body;

    const {
      profileId,
      accountId,
      currentPassword,
      newPhone,
      newEmail,
      name,
      newPassword
    } = payload || {};

    if (!profileId || !accountId) {
      return finish({ ok: false, message: "profileId and accountId are required in payload", payload });
    }

    // Create Appwrite client for server-side admin operations (use API key)
    const client = new sdk.Client();
    client
      .setEndpoint(endpoint.replace(/\/$/, "")) // remove trailing slash
      .setProject(projectId)
      .setKey(apiKey);

    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Build new login identifier: for phone we store `<digits>@phone.local` as the Appwrite login identifier
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // 1) Update auth user (users.update) if we have anything to change
    let updatedAccount = null;
    const updateArgs = {};
    if (newIdentifier) updateArgs.email = newIdentifier;
    if (newPassword && String(newPassword).trim()) updateArgs.password = String(newPassword).trim();
    if (name && String(name).trim()) updateArgs.name = String(name).trim();

    if (Object.keys(updateArgs).length > 0) {
      try {
        // node-appwrite users.update signature: users.update(userId, email, password, name, url=null)
        const emailForSdk = updateArgs.email ?? null;
        const passwordForSdk = updateArgs.password ?? null;
        const nameForSdk = updateArgs.name ?? null;

        updatedAccount = await users.update(accountId, emailForSdk, passwordForSdk, nameForSdk);
        // continue if succeeded
      } catch (uErr) {
        return finish({ ok: false, message: "Failed to update Auth user", detail: (uErr && uErr.message) || uErr });
      }
    }

    // 2) Update profile document in DB
    let updatedProfile = null;
    const profileData = {};
    if (newPhone) profileData.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileData.email = String(newEmail).trim();
    if (name && String(name).trim()) profileData.name = String(name).trim();

    if (Object.keys(profileData).length > 0) {
      try {
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profileData);
      } catch (pErr) {
        // If account updated but profile failed, return error. Optionally implement rollback here.
        return finish({ ok: false, message: "Failed to update profile document", detail: (pErr && pErr.message) || pErr });
      }
    }

    // Success
    return finish({ ok: true, account: updatedAccount ?? null, profile: updatedProfile ?? null });
  } catch (err) {
    return finish({ ok: false, message: "Unhandled function error", detail: (err && err.message) || String(err) });
  }
})();
