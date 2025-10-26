/**
 * Appwrite Cloud Function: update-login
 * Node 18 runtime
 *
 * Required env variables (set in Appwrite function environment):
 * - APPWRITE_ENDPOINT
 * - APPWRITE_PROJECT_ID (or APPWRITE_PROJECT)
 * - APPWRITE_API_KEY (must be an API key with permissions to update users & databases)
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_USER_COLLECTION_ID
 *
 * Payload (JSON) expected when calling the function:
 * {
 *   "profileId": "<document id in user collection>",
 *   "accountId": "<appwrite auth user id>",
 *   "currentPassword": "<optional, for client validation>",
 *   "newPhone": "9876543210",    // optional, digits-only or with symbols
 *   "newEmail": "you@example.com", // optional
 *   "name": "Full Name",         // optional
 *   "newPassword": "..."         // optional: change password too
 * }
 *
 * IMPORTANT: The function prints exactly one JSON object to stdout (console.log(JSON.stringify(...)))
 * so the SDK/HTTP exec will receive it. Do not call process.exit() early.
 */

const sdk = require("node-appwrite");

function finish(obj) {
  // Always output a JSON result (SDK expects stdout)
  try {
    console.log(JSON.stringify(obj));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, message: "Failed to stringify result", raw: String(obj) }));
  }
}

/** Robust payload reader:
 * - first check process.env.APPWRITE_FUNCTION_DATA or APPWRITE_FUNCTION_PAYLOAD
 * - else read stdin
 * - handle application/x-www-form-urlencoded wrappers (body=... or payload=...)
 */
async function readPayload() {
  // 1) env glue
  let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;

  // 2) fallback to stdin (common in cloud runtime)
  if (!raw) {
    raw = await new Promise((resolve) => {
      let data = "";
      try {
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => resolve(data));
        // small timeout in case runtime doesn't send stdin
        setTimeout(() => resolve(data || ""), 250);
      } catch (e) {
        resolve("");
      }
    });
  }

  if (!raw) return {};

  // If raw looks like urlencoded (Appwrite sometimes sends as application/x-www-form-urlencoded with a 'body' field)
  // e.g. body=%7B%22profileId%22%3A%22..%22%7D
  if (typeof raw === "string" && raw.includes("=") && raw.includes("%7B")) {
    try {
      const params = new URLSearchParams(raw);
      // check common keys
      const maybe = params.get("body") || params.get("payload") || params.get("data");
      if (maybe) {
        try {
          return JSON.parse(decodeURIComponent(maybe));
        } catch (e) {
          try {
            // maybe it's already decoded
            return JSON.parse(maybe);
          } catch {
            // fallthrough
          }
        }
      }
    } catch (e) {
      // ignore and continue to JSON parse below
    }
  }

  // Try parse raw JSON
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Sometimes payload is a JSON-string inside a string: try double-parse
    try {
      return JSON.parse(JSON.parse(raw));
    } catch {
      // Give up -> return empty
      return {};
    }
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
          "Missing required environment variables. Ensure APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID (or APPWRITE_PROJECT), APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID are set."
      });
    }

    const body = await readPayload();
    const {
      profileId,
      accountId,
      currentPassword, // not used server-side here but left for possible checks
      newPhone,
      newEmail,
      name,
      newPassword
    } = body || {};

    if (!profileId || !accountId) {
      return finish({ ok: false, message: "profileId and accountId are required in payload", payload: body });
    }

    // Initialize Appwrite SDK client
    const client = new sdk.Client()
      .setEndpoint(endpoint.replace(/\/$/, "")) // trim trailing slash
      .setProject(projectId)
      .setKey(apiKey);

    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Build a login identifier (Appwrite uses email-like identifier for login)
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
        // log internal account response for debugging (will appear in function logs)
        console.log("Updated Auth user:", { userId: accountId, updatedAccountId: updatedAccount.$id || updatedAccount.$id });
      } catch (uErr) {
        console.error("Failed to update Auth user:", uErr);
        return finish({ ok: false, message: "Failed to update Auth user", detail: uErr?.message ?? String(uErr) });
      }
    } else {
      console.log("No Auth update required.");
    }

    // 2) Update profile document in database
    let updatedProfile = null;
    const profileData = {};
    if (newPhone) profileData.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileData.email = String(newEmail).trim();
    if (name && String(name).trim()) profileData.name = String(name).trim();

    if (Object.keys(profileData).length > 0) {
      try {
        // databases.updateDocument(databaseId, collectionId, documentId, data)
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profileData);
        console.log("Updated profile document:", { profileId, updatedDocId: updatedProfile.$id });
      } catch (pErr) {
        console.error("Failed to update profile document:", pErr);
        // If auth update happened and profile update fails, you might want to rollback or report.
        return finish({ ok: false, message: "Failed to update profile document", detail: pErr?.message ?? String(pErr) });
      }
    } else {
      console.log("No profile update required.");
    }

    // Success: print final JSON (SDK will surface this as function result)
    return finish({ ok: true, account: updatedAccount ?? null, profile: updatedProfile ?? null });
  } catch (err) {
    console.error("Unhandled function error:", err);
    return finish({ ok: false, message: "Unhandled function error", detail: err?.message ?? String(err) });
  }
})();
