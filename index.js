// index.js - Appwrite function (Node.js)
// Deploy this as the function entry file. Ensure environment variables (APPWRITE_*) are set.

const fetch = require("node-fetch");
const { Client, Databases, Users } = require("node-appwrite");

/**
 * Input (JSON) expected:
 * {
 *   profileId: string,       // document id in your users collection
 *   accountId: string,       // appwrite account id (profile.accountId)
 *   currentPassword: string, // user's current password (required to verify)
 *   newPhone?: string,       // optional new phone (digits)
 *   newEmail?: string,       // optional new email
 *   newPassword?: string,    // optional new password (if user also wants to change password)
 *   name?: string            // optional new display name
 * }
 *
 * Output (stdout): JSON { ok: true, user: <profileDoc> }  OR  { ok: false, message: "..." }
 */

async function handler() {
  try {
    const raw = (process.env.APPWRITE_FUNCTION_EVENT || process.env.__OW_BODY || "");
    const bodyStr = raw && typeof raw === "string" ? raw : process.env.APPWRITE_FUNCTION_PAYLOAD || "{}";
    const input = JSON.parse(bodyStr || "{}");

    const { profileId, accountId, currentPassword, newPhone, newEmail, newPassword, name } = input;

    if (!profileId) throw new Error("profileId is required");
    if (!accountId) throw new Error("accountId is required");
    if (!currentPassword) throw new Error("currentPassword is required for verification");

    // envs
    const endpoint = process.env.APPWRITE_ENDPOINT;
    const project = process.env.APPWRITE_PROJECT_ID;
    const apiKey = process.env.APPWRITE_API_KEY;
    const databaseId = process.env.DATABASE_ID;
    const userCollectionId = process.env.USER_COLLECTION_ID;

    if (!endpoint || !project || !apiKey || !databaseId || !userCollectionId) {
      throw new Error("Missing required environment variables");
    }

    // Setup admin client (uses admin API key)
    const adminClient = new Client()
      .setEndpoint(endpoint)
      .setProject(project)
      .setKey(apiKey);

    const databases = new Databases(adminClient);

    // 1) read profile doc to find current email/phone
    const profileDoc = await databases.getDocument(databaseId, userCollectionId, profileId);
    if (!profileDoc) throw new Error("Profile document not found");

    const curEmail = profileDoc.email ?? null;
    const curPhone = profileDoc.phone ?? null;

    // build login identifier (Appwrite "email login" uses email or phone@phone.local)
    function buildLoginIdentifier(email, phone) {
      if (email && String(email).trim()) return String(email).trim();
      if (phone) return `${String(phone).replace(/\D/g, "")}@phone.local`;
      return null;
    }
    const loginId = buildLoginIdentifier(curEmail, curPhone);
    if (!loginId) throw new Error("No login identifier available to verify current password");

    // 2) verify currentPassword by creating session via REST (server->Appwrite)
    const sessionUrl = `${endpoint.replace(/\/$/, "")}/account/sessions/email`;
    const verifyResp = await fetch(sessionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Appwrite-Project": project,
      },
      body: JSON.stringify({ email: loginId, password: currentPassword }),
    });

    const verifyText = await verifyResp.text();
    let verifyJson;
    try { verifyJson = JSON.parse(verifyText); } catch { verifyJson = verifyText; }

    if (!verifyResp.ok) {
      throw new Error(`Password verification failed: ${verifyJson?.message ?? verifyResp.statusText}`);
    }

    // 3) Update Appwrite account (admin) - use SDK Users or REST fallback
    let updatedAccount = null;
    try {
      const users = new Users(adminClient);
      const updatePayload = {};
      if (newEmail && String(newEmail).trim()) updatePayload.email = String(newEmail).trim();
      if (newPhone && String(newPhone).trim()) updatePayload.phone = String(newPhone).replace(/\D/g, "");
      if (name && String(name).trim()) updatePayload.name = String(name).trim();

      // Some Appwrite SDK versions expose users.update or users.patch - try both
      if (Object.keys(updatePayload).length) {
        if (typeof users.update === "function") {
          updatedAccount = await users.update(accountId, updatePayload);
        } else if (typeof users.patch === "function") {
          updatedAccount = await users.patch(accountId, updatePayload);
        } else {
          throw new Error("Users update method not available on SDK - fallback to REST");
        }
      }

      // if user wants to change password too, call admin REST endpoint to set new password
      if (newPassword && String(newPassword).length >= 8) {
        // REST: PATCH /users/{userId}/password
        const pwUrl = `${endpoint.replace(/\/$/, "")}/users/${accountId}/password`;
        const pwResp = await fetch(pwUrl, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Appwrite-Project": project,
            "X-Appwrite-Key": apiKey, // admin key
          },
          body: JSON.stringify({ password: newPassword }),
        });
        if (!pwResp.ok) {
          const t = await pwResp.text();
          throw new Error(`Password update failed: ${t}`);
        }
      }

    } catch (sdkErr) {
      // REST fallback for updating user fields
      const restUserUrl = `${endpoint.replace(/\/$/, "")}/users/${accountId}`;
      const restBody = {};
      if (newEmail && String(newEmail).trim()) restBody.email = String(newEmail).trim();
      if (newPhone && String(newPhone).trim()) restBody.phone = String(newPhone).replace(/\D/g, "");
      if (name && String(name).trim()) restBody.name = String(name).trim();

      if (Object.keys(restBody).length) {
        const restResp = await fetch(restUserUrl, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Appwrite-Project": project,
            "X-Appwrite-Key": apiKey,
          },
          body: JSON.stringify(restBody),
        });
        const rt = await restResp.text();
        if (!restResp.ok) throw new Error(`Admin REST update failed: ${rt}`);
        try { updatedAccount = JSON.parse(rt); } catch { updatedAccount = rt; }
      }

      if (newPassword && String(newPassword).length >= 8) {
        const pwUrl = `${endpoint.replace(/\/$/, "")}/users/${accountId}/password`;
        const pwResp = await fetch(pwUrl, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Appwrite-Project": project,
            "X-Appwrite-Key": apiKey,
          },
          body: JSON.stringify({ password: newPassword }),
        });
        if (!pwResp.ok) {
          const t = await pwResp.text();
          throw new Error(`Password update failed (REST): ${t}`);
        }
      }
    }

    // 4) Update profile document in DB
    const profileUpdate = {};
    if (newEmail && String(newEmail).trim()) profileUpdate.email = String(newEmail).trim();
    if (newPhone && String(newPhone).trim()) profileUpdate.phone = String(newPhone).replace(/\D/g, "");
    if (name && String(name).trim()) profileUpdate.name = String(name).trim();

    let updatedProfileDoc = profileDoc;
    if (Object.keys(profileUpdate).length) {
      updatedProfileDoc = await databases.updateDocument(databaseId, userCollectionId, profileId, profileUpdate);
    }

    // return success result
    return { ok: true, user: updatedProfileDoc };
  } catch (err) {
    console.error("Function error:", err);
    return { ok: false, message: String(err?.message ?? err) };
  }
}

// Appwrite expects the function's stdout to contain the result
handler().then((res) => {
  console.log(JSON.stringify(res));
  // exit 0
  process.exit(0);
}).catch((e) => {
  console.error(e);
  console.log(JSON.stringify({ ok: false, message: e?.message ?? String(e) }));
  process.exit(1);
});
