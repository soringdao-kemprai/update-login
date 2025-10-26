// index.js
// Appwrite Cloud Function "update-login"
// Expects JSON payload in function execution data:
// {
//   "profileId": "<document id in user collection>",
//   "accountId": "<appwrite auth user id (account id)>",
//   "currentPassword": "<user's current password - optional, sent for verification if you want>",
//   "newPhone": "9876543210",     // digits-only or null
//   "newEmail": "you@example.com",// optional
//   "name": "Full Name",          // optional
//   "newPassword": "..."          // optional: change password too
// }

const endpoint = process.env.APPWRITE_ENDPOINT;
const projectId = process.env.APPWRITE_PROJECT_ID;
const apiKey = process.env.APPWRITE_API_KEY;
const databaseId = process.env.APPWRITE_DATABASE_ID;
const userCollectionId = process.env.APPWRITE_USER_COLLECTION_ID;

if (!endpoint || !projectId || !apiKey || !databaseId || !userCollectionId) {
  console.error("Missing required environment variables.");
  console.log(JSON.stringify({ ok: false, message: "Missing environment variables" }));
  process.exit(1);
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function run() {
  try {
    // APPWRITE_FUNCTION_DATA or APPWRITE_FUNCTION_PAYLOAD (depending on runtime)
    let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;

    if (!raw) {
      // fallback to stdin (some runtimes)
      raw = await new Promise((resolve) => {
        let data = "";
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => resolve(data));
        setTimeout(() => resolve(""), 300);
      });
    }

    const body = raw ? safeJsonParse(raw) || {} : {};
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
      return console.log(JSON.stringify({ ok: false, message: "profileId and accountId required" }));
    }

    // Build new login identifier
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // 1) Update the Appwrite Auth user (admin endpoint)
    // PUT /v1/users/{userId}
    let updatedAccount = null;
    const accountUpdateBody = {};
    if (newIdentifier) accountUpdateBody.email = newIdentifier;
    if (newPassword && String(newPassword).trim()) accountUpdateBody.password = String(newPassword).trim();
    if (name && String(name).trim()) accountUpdateBody.name = String(name).trim();

    if (Object.keys(accountUpdateBody).length > 0) {
      const userUrl = `${endpoint.replace(/\/$/, "")}/v1/users/${encodeURIComponent(accountId)}`;
      const resp = await fetch(userUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": projectId,
          "X-Appwrite-Key": apiKey,
        },
        body: JSON.stringify(accountUpdateBody),
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        console.error("Account update failed", resp.status, json);
        return console.log(JSON.stringify({ ok: false, message: "Failed to update account", detail: json || resp.status }));
      }
      updatedAccount = json;
    }

    // 2) Update profile document in database so profile fields match
    const profileUpdateBody = {};
    if (newPhone) profileUpdateBody.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileUpdateBody.email = String(newEmail).trim();
    if (name && String(name).trim()) profileUpdateBody.name = String(name).trim();

    let updatedProfile = null;
    if (Object.keys(profileUpdateBody).length > 0) {
      const profileUrl = `${endpoint.replace(/\/$/, "")}/v1/databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(userCollectionId)}/documents/${encodeURIComponent(profileId)}`;
      const resp2 = await fetch(profileUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": projectId,
          "X-Appwrite-Key": apiKey,
        },
        body: JSON.stringify({ data: profileUpdateBody }),
      });
      const json2 = await resp2.json().catch(() => null);
      if (!resp2.ok) {
        console.error("Profile update failed", resp2.status, json2);
        return console.log(JSON.stringify({ ok: false, message: "Failed to update profile document", detail: json2 || resp2.status }));
      }
      updatedProfile = json2;
    }

    // Success
    console.log(JSON.stringify({ ok: true, account: updatedAccount, profile: updatedProfile }));
  } catch (err) {
    console.error("Unhandled error in function:", err);
    console.log(JSON.stringify({ ok: false, message: String(err) }));
  }
}

run();
