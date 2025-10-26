/**
 * Appwrite Cloud Function (Node 18)
 *
 * Usage:
 *  - Set function execute access to "any" if calling from client SDK.
 *  - Set environment variables in the function settings:
 *      APPWRITE_ENDPOINT
 *      APPWRITE_PROJECT_ID  (or APPWRITE_PROJECT)
 *      APPWRITE_API_KEY     (admin key ONLY if you plan to call Admin-only SDK endpoints. Otherwise not required.)
 *      APPWRITE_DATABASE_ID
 *      APPWRITE_USER_COLLECTION_ID
 *
 * Security:
 *  - This function expects the client to send authenticated requests which include
 *    the header: x-appwrite-user-jwt (Appwrite automatically includes this for authenticated SDK calls).
 *  - We validate the JWT by calling /account/jwt or by trusting the presence of x-appwrite-user-id header.
 *    If you set execute access = any, ALWAYS validate identity before making changes.
 */

const sdk = require("node-appwrite");
const fetch = globalThis.fetch || require("node-fetch");

function finish(obj) {
  try {
    console.log(JSON.stringify(obj));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, message: "Failed to stringify result", raw: String(obj) }));
  }
  // allow process to exit normally
}

/* Robust payload reader (env or stdin) */
async function readPayload() {
  let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;
  if (!raw) {
    raw = await new Promise((resolve) => {
      let data = "";
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => resolve(data));
      setTimeout(() => resolve(""), 300);
    });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) {
    try { return JSON.parse(JSON.parse(raw)); } catch { return {}; }
  }
}

/* helper to safely read header-like env fields Appwrite exposes in function context */
function readHeaderEnv(name) {
  // In the Appwrite execution environment you may receive headers in CONTEXT or env (e.g. APPWRITE_FUNCTION_HEADERS)
  // But Appwrite typically exposes x-appwrite-* headers in process.env for some runtimes. We'll try few things:
  if (process.env[name]) return process.env[name];
  // Some runtimes expose APPWRITE_FUNCTION_HEADERS as JSON string
  try {
    const all = process.env.APPWRITE_FUNCTION_HEADERS ? JSON.parse(process.env.APPWRITE_FUNCTION_HEADERS) : null;
    if (all && typeof all === "object" && all[name]) return all[name];
  } catch (e) {}
  return null;
}

(async function main() {
  try {
    const endpoint = (process.env.APPWRITE_ENDPOINT || "").replace(/\/+$/, "");
    const projectId = process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT;
    const apiKey = process.env.APPWRITE_API_KEY || null; // optional; needed for admin-level actions
    const databaseId = process.env.APPWRITE_DATABASE_ID;
    const userCollectionId = process.env.APPWRITE_USER_COLLECTION_ID;

    if (!endpoint || !projectId || !databaseId || !userCollectionId) {
      return finish({ ok: false, message: "Missing required environment variables. Ensure APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID (or APPWRITE_PROJECT), APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID are set." });
    }

    // Read payload
    const body = await readPayload();
    const { profileId, accountId, currentPassword, newPhone, newEmail, name, newPassword } = body || {};

    // Basic payload validation
    if (!profileId || !accountId) {
      return finish({ ok: false, message: "profileId and accountId are required in payload", payload: body ?? {} });
    }

    // Read headers: Appwrite often injects them into env variables like APPWRITE_FUNCTION_HEADERS or direct vars.
    const callerJwt = readHeaderEnv("x-appwrite-user-jwt") || readHeaderEnv("X-Appwrite-User-Jwt") || null;
    const callerUserId = readHeaderEnv("x-appwrite-user-id") || readHeaderEnv("X-Appwrite-User-Id") || null;

    // If the function Execute access is "any" (public), we MUST validate the caller identity.
    if (!callerJwt && !callerUserId) {
      return finish({ ok: false, message: "Missing authentication headers. Caller must be authenticated (x-appwrite-user-jwt or x-appwrite-user-id)" });
    }

    // OPTIONAL: further validate jwt server-side by calling /account/jwt or by verifying signature if you have keys.
    // We'll do a soft check: ensure callerUserId matches the accountId (or else reject).
    if (callerUserId && callerUserId !== accountId) {
      // caller is not the same as the account being changed
      return finish({ ok: false, message: "Authenticated user does not match accountId in payload" });
    }

    // Setup Appwrite SDK client. Use API key only if available (for admin actions).
    const client = new sdk.Client()
      .setEndpoint(endpoint)
      .setProject(projectId);

    if (apiKey) client.setKey(apiKey);

    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Build identifier
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // Update auth user if needed
    let updatedAccount = null;
    const accountUpdate = {};
    if (newIdentifier) accountUpdate.email = newIdentifier;
    if (newPassword && String(newPassword).trim()) accountUpdate.password = String(newPassword).trim();
    if (name && String(name).trim()) accountUpdate.name = String(name).trim();

    if (Object.keys(accountUpdate).length > 0) {
      try {
        // node-appwrite Users.update signature: users.update(userId, email, password, name, url=null)
        const emailForSdk = accountUpdate.email ?? null;
        const passwordForSdk = accountUpdate.password ?? null;
        const nameForSdk = accountUpdate.name ?? null;

        // When running without API key, the SDK may still allow updating own user (if caller has permission).
        updatedAccount = await users.update(accountId, emailForSdk, passwordForSdk, nameForSdk);
        console.log("Account updated result:", updatedAccount);
      } catch (uErr) {
        console.error("Account update failed:", uErr);
        return finish({ ok: false, message: "Failed to update account", detail: (uErr && uErr.message) || uErr });
      }
    } else {
      console.log("No auth update required.");
    }

    // Update profile document
    let updatedProfile = null;
    const profileData = {};
    if (newPhone) profileData.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileData.email = String(newEmail).trim();
    if (name && String(name).trim()) profileData.name = String(name).trim();

    if (Object.keys(profileData).length > 0) {
      try {
        // databases.updateDocument(databaseId, collectionId, documentId, data, read=[], write=[])
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profileData);
        console.log("Profile updated:", updatedProfile);
      } catch (pErr) {
        console.error("Profile update failed:", pErr);
        return finish({ ok: false, message: "Failed to update profile document", detail: (pErr && pErr.message) || pErr });
      }
    } else {
      console.log("No profile update required.");
    }

    // Success
    return finish({ ok: true, account: updatedAccount ?? null, profile: updatedProfile ?? null });
  } catch (err) {
    console.error("Unhandled function error:", err);
    return finish({ ok: false, message: "Unhandled function error", detail: (err && err.message) || String(err) });
  }
})();
