// index.js
// Appwrite Cloud Function: update-login
// Expected JSON payload:
// {
//   "profileId": "<document id in user collection>",
//   "accountId": "<appwrite auth user id (account id)>",
//   "currentPassword": "<optional, not used by this sample but recommended for extra checks>",
//   "newPhone": "9876543210",     // digits-only or null
//   "newEmail": "you@example.com",// optional
//   "name": "Full Name",          // optional
//   "newPassword": "..."          // optional: if user wants to change password too
// }
//
// Required environment variables (set in Appwrite Function UI):
// APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY,
// APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID
//
// NOTE: The function uses admin REST endpoints with X-Appwrite-Key (server API key).
// Make sure the API key has write access to users & databases.

const endpoint = process.env.APPWRITE_ENDPOINT;
const projectId = process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT;
const apiKey = process.env.APPWRITE_API_KEY;
const databaseId = process.env.APPWRITE_DATABASE_ID;
const userCollectionId = process.env.APPWRITE_USER_COLLECTION_ID;

function okJson(obj) {
  console.log(JSON.stringify({ ok: true, ...obj }));
}

function failJson(message, detail) {
  console.log(JSON.stringify({ ok: false, message: String(message || "Error"), detail: detail || null }));
}

if (!endpoint || !projectId || !apiKey || !databaseId || !userCollectionId) {
  console.error("Missing required environment variables.");
  failJson("Missing required environment variables for function");
  process.exit(1);
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    // fallback timeout
    setTimeout(() => resolve(data), 200);
  });
}

async function run() {
  try {
    let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;
    if (!raw) {
      raw = await readStdin();
    }
    const body = raw ? JSON.parse(raw) : {};

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
      failJson("profileId and accountId required");
      return;
    }

    // Build new login identifier (Appwrite login via email field):
    // If newPhone present -> phone login is normalized to digits + '@phone.local'
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (!digits) {
        failJson("newPhone invalid");
        return;
      }
      newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // 1) Update Appwrite Auth user (admin): PUT /v1/users/{userId}
    const accountUpdateBody = {};
    if (newIdentifier) accountUpdateBody.email = newIdentifier;
    if (newPassword && String(newPassword).trim()) accountUpdateBody.password = String(newPassword).trim();
    if (name && String(name).trim()) accountUpdateBody.name = String(name).trim();

    let updatedAccount = null;
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
        console.error("Account update failed:", resp.status, json);
        failJson("Failed to update account", { status: resp.status, body: json });
        return;
      }
      updatedAccount = json;
    }

    // 2) Update profile document in database collection (so profile fields match)
    const profileUpdateBody = {};
    if (newPhone) profileUpdateBody.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && newEmail.trim()) profileUpdateBody.email = String(newEmail).trim();
    if (name && name.trim()) profileUpdateBody.name = name.trim();

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
        console.error("Profile update failed:", resp2.status, json2);
        failJson("Failed to update profile document", { status: resp2.status, body: json2 });
        return;
      }
      updatedProfile = json2;
    }

    // Combined successful response
    okJson({ account: updatedAccount, profile: updatedProfile });
  } catch (err) {
    console.error("Unhandled error in function:", err && err.stack ? err.stack : err);
    failJson(err && err.message ? err.message : String(err), { stack: err && err.stack ? err.stack : null });
  }
}

run();
