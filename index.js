// update-login/index.js
import fetch from "node-fetch"; // available in Appwrite Node runtime (v18+)

// Environment variables set in Appwrite Console -> Function -> Settings
const {
  APPWRITE_ENDPOINT,
  APPWRITE_PROJECT_ID,
  APPWRITE_API_KEY,
  APPWRITE_DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID
} = process.env;

// Helper to log JSON back to client
function respond(obj) {
  console.log(JSON.stringify(obj));
}

async function main() {
  try {
    // Read input payload
    const raw = process.env.APPWRITE_FUNCTION_DATA || "{}";
    const input = JSON.parse(raw);

    const {
      profileId,
      accountId,
      currentPassword,
      newPhone,
      newEmail,
      name
    } = input;

    if (!profileId || !accountId || !currentPassword) {
      return respond({ ok: false, message: "Missing required fields." });
    }

    // 1️⃣ Fetch profile document
    const docUrl = `${APPWRITE_ENDPOINT}/databases/${APPWRITE_DATABASE_ID}/collections/${APPWRITE_USER_COLLECTION_ID}/documents/${profileId}`;
    const docRes = await fetch(docUrl, {
      headers: { "X-Appwrite-Project": APPWRITE_PROJECT_ID }
    });
    if (!docRes.ok) {
      const err = await docRes.text();
      return respond({ ok: false, message: "Profile not found", err });
    }
    const profile = await docRes.json();

    const currentEmail =
      (profile.email && String(profile.email).trim()) || null;
    const currentPhone = profile.phone
      ? String(profile.phone).replace(/\D/g, "")
      : null;
    const currentLogin = currentEmail || (currentPhone ? `${currentPhone}@phone.local` : null);
    if (!currentLogin) return respond({ ok: false, message: "No login identifier found" });

    // 2️⃣ Verify password by creating session
    const sessionRes = await fetch(`${APPWRITE_ENDPOINT}/account/sessions/email`, {
      method: "POST",
      headers: {
        "X-Appwrite-Project": APPWRITE_PROJECT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email: currentLogin, password: currentPassword })
    });

    if (!sessionRes.ok) {
      return respond({ ok: false, message: "Invalid password" });
    }

    // 3️⃣ Prepare update payload
    let newIdentifier = null;
    if (newEmail && newEmail.trim()) newIdentifier = newEmail.trim();
    else if (newPhone && newPhone.trim())
      newIdentifier = `${newPhone.replace(/\D/g, "")}@phone.local`;

    const accountUpdate = {};
    if (newIdentifier) accountUpdate.email = newIdentifier;
    if (name && name.trim()) accountUpdate.name = name.trim();

    if (Object.keys(accountUpdate).length > 0) {
      const accRes = await fetch(`${APPWRITE_ENDPOINT}/users/${accountId}`, {
        method: "PUT",
        headers: {
          "X-Appwrite-Project": APPWRITE_PROJECT_ID,
          "X-Appwrite-Key": APPWRITE_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(accountUpdate)
      });
      if (!accRes.ok) {
        const txt = await accRes.text();
        return respond({ ok: false, message: "Failed updating account", txt });
      }
    }

    // 4️⃣ Patch user document
    const patch = {};
    if (newPhone) patch.phone = newPhone.replace(/\D/g, "");
    if (newEmail) patch.email = newEmail.trim();
    if (name) patch.name = name.trim();

    const patchRes = await fetch(docUrl, {
      method: "PATCH",
      headers: {
        "X-Appwrite-Project": APPWRITE_PROJECT_ID,
        "X-Appwrite-Key": APPWRITE_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(patch)
    });

    if (!patchRes.ok) {
      const txt = await patchRes.text();
      return respond({ ok: false, message: "Failed updating profile", txt });
    }

    const updated = await patchRes.json();
    return respond({ ok: true, user: updated });
  } catch (err) {
    respond({ ok: false, message: "Server error", error: String(err) });
  }
}

main();
