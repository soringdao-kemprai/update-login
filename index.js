/**
 * Appwrite Cloud Function: update-login
 *
 * Runtime: Node 18 (module.exports = async (request, response) => { ... })
 *
 * Expected environment variables in the function settings:
 * - APPWRITE_ENDPOINT            (e.g. https://nyc.cloud.appwrite.io/v1)
 * - APPWRITE_PROJECT_ID         (or APPWRITE_PROJECT)
 * - APPWRITE_API_KEY            (a server API key or dynamic key with permission to manage users + databases)
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_USER_COLLECTION_ID
 *
 * Payload (JSON) - one of these forms the client may send:
 * {
 *   "profileId": "<document id in user collection>",
 *   "accountId": "<appwrite auth user id (account id)>",
 *   "currentPassword": "<user current password - optional>",
 *   "newPhone": "9876543210",     // digits-only or formatted
 *   "newEmail": "you@example.com",// optional
 *   "name": "Full Name",          // optional
 *   "newPassword": "..."          // optional: set a new password
 * }
 *
 * Response JSON:
 * { ok: true, account: {...} | null, profile: {...} | null }
 * or
 * { ok: false, message: "...", detail?: ... }
 */

const sdk = require("node-appwrite");

// helper to unify response shape
function finishRes(response, obj, status = 200) {
  try {
    response.json(obj, status);
  } catch (e) {
    // older runtimes may not support response.json(status) signature; try other forms
    if (typeof response.send === "function") {
      response.send(JSON.stringify(obj), status);
    } else {
      // fallback: write to stdout (shouldn't be needed in Appwrite runtime)
      console.log(JSON.stringify(obj));
    }
  }
}

function parseBodyFromRequest(request) {
  // Appwrite runtime exposes different fields depending on trigger type / SDK version.
  // Try several known properties:
  if (!request) return {};
  if (request.payload) return request.payload;
  if (request.bodyJson) return request.bodyJson;
  if (request.body) {
    // body may already be parsed object or URL-encoded string
    if (typeof request.body === "object") return request.body;
    try { return JSON.parse(request.body); } catch {}
    // try fallback to bodyText if available
  }
  if (request.bodyText) {
    try { return JSON.parse(request.bodyText); } catch {}
  }
  // Sometimes Appwrite provides raw text in request.payload or request.rawBody etc.
  if (request.rawBody) {
    try { return JSON.parse(request.rawBody); } catch {}
  }
  return {};
}

module.exports = async function (request, response) {
  try {
    // read envs (support both variants APPWRITE_PROJECT_ID or APPWRITE_PROJECT)
    const endpoint = process.env.APPWRITE_ENDPOINT;
    const projectId = process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT;
    const apiKey = process.env.APPWRITE_API_KEY;
    const databaseId = process.env.APPWRITE_DATABASE_ID;
    const userCollectionId = process.env.APPWRITE_USER_COLLECTION_ID;

    if (!endpoint || !projectId || !apiKey || !databaseId || !userCollectionId) {
      return finishRes(response, {
        ok: false,
        message:
          "Missing required environment variables. Make sure APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID (or APPWRITE_PROJECT), APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID are set.",
      }, 500);
    }

    // parse payload robustly
    const body = parseBodyFromRequest(request) || {};
    const {
      profileId,
      accountId,
      currentPassword,
      newPhone,
      newEmail,
      name,
      newPassword,
    } = body;

    if (!profileId || !accountId) {
      return finishRes(response, { ok: false, message: "profileId and accountId are required in payload", payload: body }, 400);
    }

    // instantiate SDK client
    const client = new sdk.Client()
      .setEndpoint(String(endpoint).replace(/\/$/, "")) // remove trailing slash
      .setProject(projectId)
      .setKey(apiKey);

    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Build new login identifier: phone -> digits + '@phone.local', else email
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    let updatedAccount = null;
    // Prepare update arguments for SDK users.update(userId, email, password, name, url)
    const emailForSdk = newIdentifier ?? null;
    const passwordForSdk = newPassword && String(newPassword).trim() ? String(newPassword).trim() : null;
    const nameForSdk = name && String(name).trim() ? String(name).trim() : null;

    if (emailForSdk !== null || passwordForSdk !== null || nameForSdk !== null) {
      try {
        // node-appwrite users.update signature: users.update(userId, email, password, name, url = null)
        updatedAccount = await users.update(accountId, emailForSdk, passwordForSdk, nameForSdk);
      } catch (uErr) {
        // return detailed error for debugging (but don't leak secrets)
        return finishRes(response, {
          ok: false,
          message: "Failed to update Auth user (users.update). Check provided accountId / API key permissions.",
          detail: (uErr && (uErr.message || uErr.toString())) || uErr,
        }, 500);
      }
    }

    // Update profile document in database collection
    let updatedProfile = null;
    const profilePatch = {};
    if (newPhone) profilePatch.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profilePatch.email = String(newEmail).trim();
    if (name && String(name).trim()) profilePatch.name = String(name).trim();

    if (Object.keys(profilePatch).length > 0) {
      try {
        // updateDocument(databaseId, collectionId, documentId, data, read=[], write=[])
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profilePatch);
      } catch (pErr) {
        // If auth update succeeded but profile update failed, return error and detail
        return finishRes(response, {
          ok: false,
          message: "Failed to update profile document (databases.updateDocument).",
          detail: (pErr && (pErr.message || pErr.toString())) || pErr,
        }, 500);
      }
    }

    // success
    return finishRes(response, { ok: true, account: updatedAccount ?? null, profile: updatedProfile ?? null });
  } catch (err) {
    // unexpected unhandled error
    return finishRes(response, { ok: false, message: "Unhandled function error", detail: (err && (err.message || err.toString())) || err }, 500);
  }
};
