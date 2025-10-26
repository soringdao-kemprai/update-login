// index.js
// Node 18 runtime
const sdk = require("node-appwrite");
const fetch = globalThis.fetch || require("node-fetch");

function finish(obj) {
  // Always emit exactly one JSON object (client expects this)
  try {
    console.log(JSON.stringify(obj));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, message: "Failed to stringify result", raw: String(obj) }));
  }
  // don't call process.exit(); platform handles lifecycle
}

function parseEnvOrStdinRaw() {
  return new Promise((resolve) => {
    let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;
    if (raw) return resolve(raw);
    // collect stdin if present (Appwrite often sends via stdin for HTTP trigger)
    let data = "";
    let got = false;
    if (process.stdin) {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => { got = true; resolve(data); });
      // small timeout fallback
      setTimeout(() => {
        if (!got) resolve(data || "");
      }, 300);
    } else {
      resolve("");
    }
  });
}

function safeParse(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) {
    try { return JSON.parse(JSON.parse(raw)); } catch (e2) { return {}; }
  }
}

(async function main() {
  try {
    const endpoint = (process.env.APPWRITE_ENDPOINT || "").replace(/\/+$/, "");
    const projectId = process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT;
    const apiKey = process.env.APPWRITE_API_KEY;
    const databaseId = process.env.APPWRITE_DATABASE_ID;
    const userCollectionId = process.env.APPWRITE_USER_COLLECTION_ID;

    if (!endpoint || !projectId || !apiKey || !databaseId || !userCollectionId) {
      return finish({
        ok: false,
        message: "Missing required environment variables. Ensure APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID are set.",
      });
    }

    const raw = await parseEnvOrStdinRaw();
    const body = safeParse(raw);

    const {
      profileId, accountId, currentPassword = null,
      newPhone = null, newEmail = null, name = null, newPassword = null,
      verifyCurrentPassword = undefined
    } = body || {};

    if (!profileId || !accountId) {
      return finish({ ok: false, message: "profileId and accountId are required in payload", payload: body || {} });
    }

    // Build login identifier: app convention: email OR digits@phone.local
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // If payload contains no identifier change but there's newPassword/name that's fine.
    // Optionally verify current password by attempting to create a session (useful if you want users to prove they know current password).
    const shouldVerify = (verifyCurrentPassword !== undefined) ? Boolean(verifyCurrentPassword) : (currentPassword ? true : false);
    if (shouldVerify && currentPassword) {
      // build a best-effort login identifier for verification:
      // - prefer existing profile email if present and newEmail missing
      // - otherwise try accountId? but typically we need an email-like id
      // We'll attempt: use body.verifyIdentifier or newEmail else try to read profile? (we don't have profile object)
      // Simpler: if newEmail provided use that, else attempt to fetch profile doc to find existing identifier.
      let identifierToTry = null;
      if (newEmail && String(newEmail).trim()) identifierToTry = String(newEmail).trim();

      if (!identifierToTry) {
        // fetch profile document to read current stored email/phone
        const clientForFetch = new sdk.Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
        const databases = new sdk.Databases(clientForFetch);
        try {
          const doc = await databases.getDocument(databaseId, userCollectionId, profileId);
          const existingEmail = doc.email ?? null;
          const existingPhone = doc.phone ?? null;
          if (existingEmail && String(existingEmail).trim()) identifierToTry = String(existingEmail).trim();
          else if (existingPhone) identifierToTry = `${String(existingPhone).replace(/\D/g, "")}@phone.local`;
        } catch (e) {
          // fallback to null
        }
      }

      if (!identifierToTry) {
        return finish({ ok: false, message: "Unable to determine login identifier for password verification. Provide current credentials or verify differently." });
      }

      // Try create session via REST (deterministic). This verifies the provided currentPassword is valid for the identifier.
      try {
        const url = `${endpoint.endsWith("/v1") ? endpoint : endpoint + "/v1"}/account/sessions/email`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Appwrite-Project": projectId
          },
          body: JSON.stringify({ email: identifierToTry, password: currentPassword }),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          let bodyResp = null;
          try { bodyResp = JSON.parse(text); } catch { bodyResp = text; }
          return finish({ ok: false, message: "Current password verification failed", detail: bodyResp });
        }
        // verification OK (we don't use the session)
      } catch (e) {
        return finish({ ok: false, message: "Failed to verify current password", detail: String(e) });
      }
    }

    // Setup admin SDK client with API key
    const client = new sdk.Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Prepare auth update values
    const emailForSdk = newIdentifier ?? null; // either new email or phone-as-email identifier
    const passwordForSdk = newPassword && String(newPassword).trim() ? String(newPassword).trim() : null;
    const nameForSdk = name && String(name).trim() ? String(name).trim() : null;

    // Update Auth user (only if we have something to update)
    let updatedAccount = null;
    if (emailForSdk || passwordForSdk || nameForSdk) {
      try {
        // node-appwrite Users.update signature: users.update(userId, email, password, name, url)
        updatedAccount = await users.update(accountId, emailForSdk, passwordForSdk, nameForSdk);
      } catch (uErr) {
        // If update fails, return helpful message
        return finish({ ok: false, message: "Failed to update auth user", detail: uErr && uErr.message ? uErr.message : String(uErr) });
      }
    }

    // Patch profile document
    const profilePatch = {};
    if (newPhone) profilePatch.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profilePatch.email = String(newEmail).trim();
    if (nameForSdk) profilePatch.name = nameForSdk;

    let updatedProfile = null;
    if (Object.keys(profilePatch).length > 0) {
      try {
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profilePatch);
      } catch (pErr) {
        // If profile update fails after account update, return error but include account result
        return finish({
          ok: false,
          message: "Failed to update profile document after updating account",
          account: updatedAccount ?? null,
          detail: pErr && pErr.message ? pErr.message : String(pErr),
        });
      }
    }

    // Success
    return finish({
      ok: true,
      account: updatedAccount ?? null,
      profile: updatedProfile ?? null,
    });
  } catch (err) {
    console.error("Unhandled function error:", err);
    return finish({ ok: false, message: "Unhandled function error", detail: err && err.message ? err.message : String(err) });
  }
})();
