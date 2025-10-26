/**
 * Appwrite Cloud Function: update-login
 *
 * Requirements (Function environment variables):
 *  - APPWRITE_ENDPOINT
 *  - APPWRITE_PROJECT_ID (or APPWRITE_PROJECT)
 *  - APPWRITE_API_KEY
 *  - APPWRITE_DATABASE_ID
 *  - APPWRITE_USER_COLLECTION_ID
 *
 * This function expects JSON payload with:
 * {
 *   "profileId": "<document id in user collection>",
 *   "accountId": "<appwrite auth user id (account id)>",
 *   "currentPassword": "<user current password - optional>",
 *   "newPhone": "9876543210",     // digits-only or null
 *   "newEmail": "you@example.com",// optional
 *   "name": "Full Name",          // optional
 *   "newPassword": "..."          // optional: if user wants to change password too
 * }
 *
 * It updates:
 *  - Appwrite Auth user (Users.update)
 *  - Profile document in database collection (Databases.updateDocument)
 *
 * It ALWAYS prints a JSON object to stdout:
 *  { ok: true, account: ..., profile: ... }
 * or
 *  { ok: false, message: "...", detail: ... }
 */

const sdk = require("node-appwrite");

function finish(obj) {
  try {
    console.log(JSON.stringify(obj));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, message: "Failed to stringify result", raw: String(obj) }));
  }
  // do not process.exit abruptly — allow runtime to flush logs
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

    // Read payload robustly from env or stdin
    let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || process.env.APPWRITE_FUNCTION_INPUT || null;
    if (!raw) {
      raw = await new Promise((resolve) => {
        let data = "";
        try {
          process.stdin.on("data", (c) => (data += c));
          process.stdin.on("end", () => resolve(data));
        } catch (e) {
          resolve("");
        }
        // fallback resolve after a short time if nothing is sent via stdin
        setTimeout(() => resolve(""), 300);
      });
    }

    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); }
      catch (e1) {
        try { body = JSON.parse(JSON.parse(raw)); } catch (e2) { body = {}; }
      }
    }

    const { profileId, accountId, currentPassword, newPhone, newEmail, name, newPassword } = body || {};

    if (!profileId || !accountId) {
      return finish({ ok: false, message: "profileId and accountId are required in payload", payload: body });
    }

    // Initialize Appwrite client
    const client = new sdk.Client()
      .setEndpoint(endpoint.replace(/\/$/, "")) // strip trailing slash
      .setProject(projectId)
      .setKey(apiKey);

    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Build new identifier if phone/email changed (phone -> "digits@phone.local")
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // 1) Update Auth user if necessary
    let updatedAccount = null;
    const updateArgs = {};
    if (newIdentifier) updateArgs.email = newIdentifier;
    if (newPassword && String(newPassword).trim()) updateArgs.password = String(newPassword).trim();
    if (name && String(name).trim()) updateArgs.name = String(name).trim();

    if (Object.keys(updateArgs).length > 0) {
      try {
        // node-appwrite Users.update(userId, email=null, password=null, name=null, url=null)
        const emailForSdk = updateArgs.email ?? null;
        const passwordForSdk = updateArgs.password ?? null;
        const nameForSdk = updateArgs.name ?? null;

        updatedAccount = await users.update(accountId, emailForSdk, passwordForSdk, nameForSdk);
      } catch (uErr) {
        // Return failure JSON with details
        return finish({ ok: false, message: "Failed to update Auth user", detail: (uErr && (uErr.message || uErr)) || String(uErr) });
      }
    }

    // 2) Update profile document in database (patch)
    let updatedProfile = null;
    const profileData = {};
    if (newPhone) profileData.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileData.email = String(newEmail).trim();
    if (name && String(name).trim()) profileData.name = String(name).trim();

    if (Object.keys(profileData).length > 0) {
      try {
        // updateDocument(databaseId, collectionId, documentId, data)
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profileData);
      } catch (pErr) {
        // If auth updated but profile update failed, return error (you could attempt rollback here)
        return finish({ ok: false, message: "Failed to update profile document", detail: (pErr && (pErr.message || pErr)) || String(pErr) });
      }
    }

    // Success
    return finish({ ok: true, account: updatedAccount ?? null, profile: updatedProfile ?? null });

  } catch (err) {
    return finish({ ok: false, message: "Unhandled function error", detail: (err && (err.message || err)) || String(err) });
  }
})();
