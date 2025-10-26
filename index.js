/**
 * Appwrite Cloud Function - update-login
 *
 * Exports a single async function so Appwrite runtime can call it.
 * The function accepts an optional `payload` argument (Appwrite sometimes forwards the test payload),
 * and also falls back to reading process.env.APPWRITE_FUNCTION_DATA or stdin.
 *
 * Environment variables required in the Function settings:
 * - APPWRITE_ENDPOINT
 * - APPWRITE_PROJECT_ID  (or APPWRITE_PROJECT)
 * - APPWRITE_API_KEY
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_USER_COLLECTION_ID
 *
 * Expected payload:
 * {
 *   "profileId": "<document id in user collection>",
 *   "accountId": "<appwrite auth user id>",
 *   "currentPassword": "...",     // optional
 *   "newPhone": "9876543210",     // optional
 *   "newEmail": "you@example.com",// optional
 *   "name": "Full Name",          // optional
 *   "newPassword": "..."          // optional
 * }
 */

const sdk = require("node-appwrite");

function finish(obj) {
  try { console.log(JSON.stringify(obj)); }
  catch (e) { console.log(JSON.stringify({ ok: false, message: "Failed to stringify result", raw: String(obj) })); }
  // do not forcibly exit; allow Appwrite to collect logs
}

async function readPayloadFromEnvOrStdin() {
  // Appwrite various runtime fields: APPWRITE_FUNCTION_DATA, APPWRITE_FUNCTION_PAYLOAD, APPWRITE_FUNCTION_INPUT
  let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || process.env.APPWRITE_FUNCTION_INPUT || null;
  if (!raw) {
    // try stdin (some runtimes send payload on stdin)
    raw = await new Promise((resolve) => {
      try {
        let data = "";
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
        setTimeout(() => resolve(""), 300);
      } catch (e) {
        resolve("");
      }
    });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (e1) {
    try { return JSON.parse(JSON.parse(raw)); } catch (e2) { return {}; }
  }
}

// The exported function that Appwrite runtime expects to call
module.exports = async function userFunction(payloadArg) {
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

    // Determine payload: prefer payloadArg (if runtime provided), else read env/stdin
    let body = {};
    if (payloadArg && Object.keys(payloadArg).length > 0) {
      body = payloadArg;
    } else {
      body = await readPayloadFromEnvOrStdin();
    }

    const { profileId, accountId, currentPassword, newPhone, newEmail, name, newPassword } = body || {};

    if (!profileId || !accountId) {
      return finish({ ok: false, message: "profileId and accountId are required in payload", payload: body });
    }

    // Setup Appwrite SDK client
    const client = new sdk.Client()
      .setEndpoint(endpoint.replace(/\/$/, "")) // remove trailing slash
      .setProject(projectId)
      .setKey(apiKey);

    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Build identifier if phone/email changed (phone -> digits@phone.local)
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // 1) Update Auth user (only if changes present)
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
        return finish({ ok: false, message: "Failed to update Auth user", detail: (uErr && (uErr.message || uErr)) || String(uErr) });
      }
    }

    // 2) Update profile document (patch)
    let updatedProfile = null;
    const profileData = {};
    if (newPhone) profileData.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileData.email = String(newEmail).trim();
    if (name && String(name).trim()) profileData.name = String(name).trim();

    if (Object.keys(profileData).length > 0) {
      try {
        // databases.updateDocument(databaseId, collectionId, documentId, data)
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profileData);
      } catch (pErr) {
        return finish({ ok: false, message: "Failed to update profile document", detail: (pErr && (pErr.message || pErr)) || String(pErr) });
      }
    }

    // Return success object (always JSON)
    return finish({ ok: true, account: updatedAccount ?? null, profile: updatedProfile ?? null });
  } catch (err) {
    return finish({ ok: false, message: "Unhandled function error", detail: (err && (err.message || err)) || String(err) });
  }
};
