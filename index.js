// update-login/index.js
// Node 18+ / serverless friendly (Express-style)
// Environment variables required:
// APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY,
// APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID, FUNCTION_SECRET

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "200kb" }));

const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID,
  FUNCTION_SECRET,
} = process.env;

if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !APPWRITE_DATABASE_ID || !APPWRITE_USER_COLLECTION_ID || !FUNCTION_SECRET) {
  console.error("Missing required env var(s). See README.");
}

function jsonRes(res, code, body) {
  res.status(code).json(body);
}

app.post("/update-login", async (req, res) => {
  try {
    // basic secret protection
    const providedSecret = req.headers["x-function-secret"] || req.headers["x-function-token"];
    if (!providedSecret || String(providedSecret) !== String(FUNCTION_SECRET)) {
      return jsonRes(res, 401, { ok: false, message: "Unauthorized (invalid function secret)" });
    }

    const {
      profileId,        // document id in users collection
      accountId,        // Appwrite account id stored on profile (preferred)
      currentPassword,  // user's current password (required to verify ownership)
      newPhone,         // digits-only string or undefined
      newEmail,         // string or undefined
      name,             // optional display name
    } = req.body || {};

    if (!profileId || !accountId || !currentPassword || (!newPhone && !newEmail && !name)) {
      return jsonRes(res, 400, { ok: false, message: "Missing required parameters. Need profileId, accountId, currentPassword and at least one of newPhone/newEmail/name" });
    }

    // Helper fetch wrapper to Appwrite (non-SDK): include Project header
    const AW_HEADERS = {
      "X-Appwrite-Project": APPWRITE_PROJECT_ID,
      "Content-Type": "application/json",
    };

    // Step 1: Fetch profile doc server-side to find current login identifier (fallback)
    const docUrl = `${APPWRITE_ENDPOINT.replace(/\/$/, "")}/v1/databases/${encodeURIComponent(APPWRITE_DATABASE_ID)}/collections/${encodeURIComponent(APPWRITE_USER_COLLECTION_ID)}/documents/${encodeURIComponent(profileId)}`;
    const docResp = await fetch(docUrl, {
      method: "GET",
      headers: AW_HEADERS,
    });
    if (!docResp.ok) {
      const txt = await docResp.text().catch(() => "");
      console.error("Failed to fetch profile doc:", docResp.status, txt);
      return jsonRes(res, 500, { ok: false, message: "Failed to load profile" });
    }
    const profileDoc = await docResp.json();

    // Determine current login identifier
    const currentEmail = (profileDoc.email && String(profileDoc.email).trim()) || null;
    const currentPhone = profileDoc.phone && String(profileDoc.phone).replace(/\D/g, "");
    const currentLoginId = currentEmail || (currentPhone ? `${currentPhone}@phone.local` : null);
    if (!currentLoginId) {
      return jsonRes(res, 400, { ok: false, message: "Profile has no usable login identifier" });
    }

    // Step 2: Verify current password by creating a session (REST login)
    const sessionUrl = `${APPWRITE_ENDPOINT.replace(/\/$/, "")}/v1/account/sessions/email`;
    let sessionResp;
    try {
      sessionResp = await fetch(sessionUrl, {
        method: "POST",
        headers: AW_HEADERS,
        // server->server call uses credentials include? Not necessary; we will just test response status/body
        body: JSON.stringify({ email: currentLoginId, password: currentPassword }),
      });
    } catch (err) {
      console.error("Network error creating session:", err);
      return jsonRes(res, 500, { ok: false, message: "Network error verifying password" });
    }

    if (!sessionResp.ok) {
      const body = await sessionResp.text().catch(() => "");
      console.warn("Password verify failed:", sessionResp.status, body);
      return jsonRes(res, 401, { ok: false, message: "Invalid password" });
    }
    // sessionResp ok -> password validated

    // Step 3: Build new account login identifier (if changing)
    let newIdentifier = null;
    if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    } else if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      newIdentifier = `${digits}@phone.local`;
    }

    // Step 4: Update Appwrite account using admin key (X-Appwrite-Key)
    if (newIdentifier || name) {
      const updateUrl = `${APPWRITE_ENDPOINT.replace(/\/$/, "")}/v1/users/${encodeURIComponent(accountId)}`;
      const adminHeaders = {
        "X-Appwrite-Project": APPWRITE_PROJECT_ID,
        "X-Appwrite-Key": APPWRITE_API_KEY,
        "Content-Type": "application/json",
      };

      const payload = {};
      if (newIdentifier) payload["email"] = newIdentifier;
      if (name) payload["name"] = name;

      const updateResp = await fetch(updateUrl, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify(payload),
      });

      if (!updateResp.ok) {
        const txt = await updateResp.text().catch(() => "");
        console.error("Failed to update account:", updateResp.status, txt);
        return jsonRes(res, 500, { ok: false, message: "Failed to update account identifier", details: txt });
      }
      // updated account OK
    }

    // Step 5: Update profile document in DB (phone/email/name)
    const updatePayload = {};
    if (newPhone) updatePayload["phone"] = String(newPhone).replace(/\D/g, "");
    if (newEmail) updatePayload["email"] = String(newEmail).trim();
    if (name) updatePayload["name"] = name;

    // Appwrite DB patch endpoint:
    const patchUrl = `${APPWRITE_ENDPOINT.replace(/\/$/, "")}/v1/databases/${encodeURIComponent(APPWRITE_DATABASE_ID)}/collections/${encodeURIComponent(APPWRITE_USER_COLLECTION_ID)}/documents/${encodeURIComponent(profileId)}`;
    const patchResp = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        "X-Appwrite-Project": APPWRITE_PROJECT_ID,
        "X-Appwrite-Key": APPWRITE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updatePayload),
    });

    if (!patchResp.ok) {
      const txt = await patchResp.text().catch(() => "");
      console.error("Failed to patch profile doc:", patchResp.status, txt);
      return jsonRes(res, 500, { ok: false, message: "Failed to update profile document", details: txt });
    }
    const updatedDoc = await patchResp.json();

    // Done — return updated profile doc
    return jsonRes(res, 200, { ok: true, user: updatedDoc });
  } catch (err) {
    console.error("Unhandled error in update-login:", err);
    return jsonRes(res, 500, { ok: false, message: "Server error", error: String(err) });
  }
});

// Export handler for serverless frameworks
export default app;
