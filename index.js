/**
 * Appwrite Cloud Function (Node 18)
 *
 * Exported function: userFunction(context)
 * - This function will be called by Appwrite's runtime.
 * - It returns via context.res.json(...) to satisfy the runtime requirement.
 *
 * Required function environment variables (set in Appwrite function environment):
 * - APPWRITE_ENDPOINT
 * - APPWRITE_PROJECT_ID (or APPWRITE_PROJECT)
 * - APPWRITE_API_KEY
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_USER_COLLECTION_ID
 *
 * Payload expected (JSON):
 * {
 *   "profileId": "<document id in user collection>",
 *   "accountId": "<appwrite auth user id>",
 *   "currentPassword": "<optional, for client validation>",
 *   "newPhone": "9876543210",    // optional
 *   "newEmail": "you@example.com", // optional
 *   "name": "Full Name",         // optional
 *   "newPassword": "..."         // optional
 * }
 */

const sdk = require("node-appwrite");
const { URLSearchParams } = require("url");

/** Helper to respond in both console and Appwrite context */
function respond(context, obj) {
  try {
    const json = JSON.stringify(obj);
    console.log(json);
    if (context && context.res && typeof context.res.json === "function") {
      return context.res.json(obj);
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, message: "Failed to stringify response", raw: String(obj) }));
    if (context && context.res && typeof context.res.json === "function") {
      return context.res.json({ ok: false, message: "Failed to stringify response" });
    }
  }
  // If context.res not available, just return object (some runtimes may ignore)
  return obj;
}

/** Robustly read payload from different sources: context.payload, request.body, env var, stdin, urlencoded wrappers */
async function readPayloadPossible(context) {
  // 1) context.payload (Appwrite higher-level property)
  if (context && context.payload && Object.keys(context.payload).length) {
    return context.payload;
  }

  // 2) context.request?.body (Appwrite wrapper includes request)
  if (context && context.request && context.request.body) {
    // If it's an object already, return it
    if (typeof context.request.body === "object") return context.request.body;
    // If string: try JSON parse
    try {
      return JSON.parse(context.request.body);
    } catch {}
  }

  // 3) APPWRITE_FUNCTION_DATA or APPWRITE_FUNCTION_PAYLOAD env (older runtimes)
  const rawEnv = process.env.APPWRITE_FUNCTION_DATA || process.env.APPWRITE_FUNCTION_PAYLOAD || null;
  if (rawEnv) {
    try {
      return JSON.parse(rawEnv);
    } catch (e) {
      try {
        return JSON.parse(JSON.parse(rawEnv));
      } catch {}
      // If rawEnv looks urlencoded body=..., try to extract
      if (rawEnv.includes("=") && rawEnv.includes("%7B")) {
        try {
          const params = new URLSearchParams(rawEnv);
          const maybe = params.get("body") || params.get("payload") || params.get("data");
          if (maybe) {
            try { return JSON.parse(decodeURIComponent(maybe)); } catch {}
            try { return JSON.parse(maybe); } catch {}
          }
        } catch (e) {}
      }
    }
  }

  // 4) try to read stdin (some runtimes provide payload via stdin)
  let stdin = "";
  if (!process.stdin.isTTY) {
    stdin = await new Promise((resolve) => {
      let data = "";
      try {
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => resolve(data));
        setTimeout(() => resolve(data || ""), 200);
      } catch (e) {
        resolve("");
      }
    });
  }
  if (stdin) {
    // try parse common patterns
    if (stdin.includes("=") && stdin.includes("%7B")) {
      try {
        const params = new URLSearchParams(stdin);
        const maybe = params.get("body") || params.get("payload") || params.get("data");
        if (maybe) {
          try { return JSON.parse(decodeURIComponent(maybe)); } catch {}
          try { return JSON.parse(maybe); } catch {}
        }
      } catch (e) {}
    }
    try { return JSON.parse(stdin); } catch (e) {
      try { return JSON.parse(JSON.parse(stdin)); } catch (e2) { /* ignore */ }
    }
  }

  // nothing found
  return {};
}

/** The exported function Appwrite expects */
module.exports = async function userFunction(context) {
  try {
    // Use env from context if present, else fallback to process.env
    const env = (context && context.env) ? { ...process.env, ...context.env } : process.env;

    const endpoint = env.APPWRITE_ENDPOINT;
    const projectId = env.APPWRITE_PROJECT_ID || env.APPWRITE_PROJECT;
    const apiKey = env.APPWRITE_API_KEY;
    const databaseId = env.APPWRITE_DATABASE_ID;
    const userCollectionId = env.APPWRITE_USER_COLLECTION_ID;

    if (!endpoint || !projectId || !apiKey || !databaseId || !userCollectionId) {
      return respond(context, {
        ok: false,
        message:
          "Missing required environment variables. Ensure APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID (or APPWRITE_PROJECT), APPWRITE_API_KEY, APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID are set."
      });
    }

    // Read payload from the most likely places
    const body = await readPayloadPossible(context);
    const {
      profileId,
      accountId,
      currentPassword,
      newPhone,
      newEmail,
      name,
      newPassword
    } = body || {};

    if (!profileId || !accountId) {
      return respond(context, { ok: false, message: "profileId and accountId are required in payload", payload: body });
    }

    // Init Appwrite SDK client
    const client = new sdk.Client()
      .setEndpoint(String(endpoint).replace(/\/$/, "")) // trim trailing slash
      .setProject(projectId)
      .setKey(apiKey);

    const users = new sdk.Users(client);
    const databases = new sdk.Databases(client);

    // Build new login identifier if phone/email changed
    let newIdentifier = null;
    if (newPhone && String(newPhone).trim()) {
      const digits = String(newPhone).replace(/\D/g, "");
      if (digits) newIdentifier = `${digits}@phone.local`;
    } else if (newEmail && String(newEmail).trim()) {
      newIdentifier = String(newEmail).trim();
    }

    // 1) Update Auth user (users.update)
    let updatedAccount = null;
    const updateArgs = {};
    if (newIdentifier) updateArgs.email = newIdentifier;
    if (newPassword && String(newPassword).trim()) updateArgs.password = String(newPassword).trim();
    if (name && String(name).trim()) updateArgs.name = String(name).trim();

    if (Object.keys(updateArgs).length > 0) {
      try {
        // users.update(userId, email=null, password=null, name=null, url=null)
        const emailForSdk = updateArgs.email ?? null;
        const passwordForSdk = updateArgs.password ?? null;
        const nameForSdk = updateArgs.name ?? null;

        updatedAccount = await users.update(accountId, emailForSdk, passwordForSdk, nameForSdk);
        console.log("Updated Auth user:", { accountId, updatedAccountId: updatedAccount.$id ?? updatedAccount.$id ?? null });
      } catch (uErr) {
        console.error("Failed to update Auth user:", uErr);
        return respond(context, { ok: false, message: "Failed to update Auth user", detail: uErr?.message ?? String(uErr) });
      }
    } else {
      console.log("No Auth update required.");
    }

    // 2) Update profile document in DB
    let updatedProfile = null;
    const profileData = {};
    if (newPhone) profileData.phone = String(newPhone).replace(/\D/g, "");
    if (newEmail && String(newEmail).trim()) profileData.email = String(newEmail).trim();
    if (name && String(name).trim()) profileData.name = String(name).trim();

    if (Object.keys(profileData).length > 0) {
      try {
        updatedProfile = await databases.updateDocument(databaseId, userCollectionId, profileId, profileData);
        console.log("Updated profile document:", { profileId, updatedDocId: updatedProfile.$id });
      } catch (pErr) {
        console.error("Failed to update profile document:", pErr);
        // If auth update already happened, you may want to rollback — here we fail and report.
        return respond(context, { ok: false, message: "Failed to update profile document", detail: pErr?.message ?? String(pErr) });
      }
    } else {
      console.log("No profile update required.");
    }

    // Success
    return respond(context, { ok: true, account: updatedAccount ?? null, profile: updatedProfile ?? null });
  } catch (err) {
    console.error("Unhandled function error:", err);
    return respond(context, { ok: false, message: "Unhandled function error", detail: err?.message ?? String(err) });
  }
};
