// index.js  (Appwrite Cloud Function)
const fetch = globalThis.fetch || require("node-fetch");

const endpoint = process.env.APPWRITE_ENDPOINT;
const projectId = process.env.APPWRITE_PROJECT_ID;
const apiKey = process.env.APPWRITE_API_KEY;
const databaseId = process.env.APPWRITE_DATABASE_ID;
const userCollectionId = process.env.APPWRITE_USER_COLLECTION_ID;

function bad(msg) {
  console.error(msg);
  console.log(JSON.stringify({ ok: false, message: msg }));
  process.exit(1);
}

if (!endpoint || !projectId || !apiKey || !databaseId || !userCollectionId) {
  bad("Missing required environment variables. Make sure APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID are set.");
}

async function readPayload() {
  let raw = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;
  if (!raw) {
    raw = await new Promise((resolve) => {
      let data = "";
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => resolve(data));
      setTimeout(() => resolve(""), 250);
    });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch(e) {
    try { return JSON.parse(JSON.parse(raw)); } catch { return {}; }
  }
}

async function run() {
  try {
    const body = await readPayload();
    const { profileId, accountId, currentPassword, newPhone, newEmail, name, newPassword } = body || {};

    if (!profileId || !accountId) {
      return console.log(JSON.stringify({ ok: false, message: "profileId and accountId required" }));
    }

    // Normalize phone -> digits only
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // 1) Update auth user (PUT /v1/users/{accountId})
    let updatedAccount = null;
    const accountUpdate = {};
    if (newIdentifier) accountUpdate.email = newIdentifier;
    if (newPassword && String(newPassword).trim()) accountUpdate.password = String(newPassword).trim();
    if (name && String(name).trim()) accountUpdate.name = String(name).trim();

    if (Object.keys(accountUpdate).length > 0) {
      const userUrl = `${endpoint.replace(/\/$/, "")}/v1/users/${encodeURIComponent(accountId)}`;
      const resp = await fetch(userUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": projectId,
          "X-Appwrite-Key": apiKey,
        },
        body: JSON.stringify(accountUpdate),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        console.error("Account update failed:", resp.status, json);
        return console.log(JSON.stringify({ ok: false, message: "Failed to update account", detail: json || resp.status }));
      }
      updatedAccount = json;
    }

    // 2) Update profile document (PATCH)
    let updatedProfile = null;
    const profileData = {};
    if (newPhone) profileData.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileData.email = String(newEmail).trim();
    if (name && String(name).trim()) profileData.name = String(name).trim();

    if (Object.keys(profileData).length > 0) {
      const profileUrl = `${endpoint.replace(/\/$/, "")}/v1/databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(userCollectionId)}/documents/${encodeURIComponent(profileId)}`;
      const resp2 = await fetch(profileUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": projectId,
          "X-Appwrite-Key": apiKey,
        },
        body: JSON.stringify({ data: profileData }),
      });
      const json2 = await resp2.json().catch(() => null);
      if (!resp2.ok) {
        console.error("Profile update failed:", resp2.status, json2);
        return console.log(JSON.stringify({ ok: false, message: "Failed to update profile document", detail: json2 || resp2.status }));
      }
      updatedProfile = json2;
    }

    // success - always emit JSON (client will parse)
    console.log(JSON.stringify({ ok: true, account: updatedAccount, profile: updatedProfile }));
  } catch (err) {
    console.error("Unhandled function error:", err);
    console.log(JSON.stringify({ ok: false, message: String(err) }));
  }
}

run();
