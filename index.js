const fs = require("fs");
const { login } = require("ws3-fca");
const express = require("express");

// ---------- CRASH PROTECTION ----------
process.on("uncaughtException", err => console.log("[UNCAUGHT]", err));
process.on("unhandledRejection", err => {
  const msg = err?.toString?.() || "";
  if (msg.includes("[object Object]")) return;
  console.log("[REJECTION]", msg);
});

// ---------- CONFIG ----------
let config;
try {
  config = JSON.parse(fs.readFileSync("config.json"));
} catch {
  process.exit(1);
}

// ---------- GLOBAL ----------
let api = null;
const OWNER_ID = config.adminID;

// ---------- AUTOREACT ----------
let autoReactEnabled = false;
const AUTO_REACT_EMOJI = "😆";

async function autoReact(threadID, messageID) {
  if (!autoReactEnabled || !api || !messageID) return;
  try {
    await api.setMessageReaction(AUTO_REACT_EMOJI, messageID, () => {}, true);
  } catch {}
}

// ---------- SEND + TYPING ----------
async function sendMessageCompat(text, threadID) {
  if (!api) return false;

  try {
    if (api.sendTypingIndicator) {
      api.sendTypingIndicator(threadID, true);
    }

    const info = await api.sendMessage(text, threadID);

    if (api.sendTypingIndicator) {
      api.sendTypingIndicator(threadID, false);
    }

    if (info?.messageID) {
      autoReact(threadID, info.messageID);
    }

    return true;

  } catch {
    console.log("[SEND BLOCKED]", threadID);

    try {
      api.sendTypingIndicator(threadID, false);
    } catch {}

    return false;
  }
}

// ---------- SPAM ----------
const stateFile = "./spam_state.json";

let persisted = {};
try {
  if (fs.existsSync(stateFile)) {
    persisted = JSON.parse(fs.readFileSync(stateFile));
  }
} catch {}

persisted.lists = persisted.lists || {};
persisted.active = persisted.active || {};

let spamIndexes = {};
let lastReplyTime = {};

function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(persisted, null, 2));
}

function getDelay() {
  return 8000 + Math.random() * 4000;
}

// ---------- COUNT ----------
let activeCounts = {};

// ---------- HELPERS ----------
function looksLikeThreadID(t) {
  return /^\d{6,}$/.test(t);
}

function startSpam(tid) {
  persisted.active[tid] = true;
  if (typeof spamIndexes[tid] !== "number") spamIndexes[tid] = 0;
  saveState();
}

function stopSpam(tid) {
  delete persisted.active[tid];
  saveState();
}

// ---------- LISTENER ----------
function startListener() {
  api.listenMqtt(async (err, event) => {

    if (err) {
      console.log("[MQTT ERROR]");
      setTimeout(startListener, 10000);
      return;
    }

    if (!event || event.type !== "message" || !event.body) return;

    const raw = event.body.trim();
    const lower = raw.toLowerCase();
    const args = raw.split(/\s+/);

    const threadID = event.threadID;
    const senderID = event.senderID;
    const isOwner = senderID == OWNER_ID;

    // ---------- AUTOREACT ----------
    if (lower === "autoreact on" && isOwner) {
      autoReactEnabled = true;
      return sendMessageCompat("autoreact enabled", threadID);
    }

    if (lower === "autoreact off" && isOwner) {
      autoReactEnabled = false;
      return sendMessageCompat("autoreact disabled", threadID);
    }

    // ---------- COUNT (ULTRA FAST) ----------
    if (lower.startsWith("count") && isOwner) {

      let target = threadID;
      let max;

      if (args.length === 2) {
        max = parseInt(args[1]);
      } else if (args.length === 3 && looksLikeThreadID(args[1])) {
        target = args[1];
        max = parseInt(args[2]);
      } else {
        return sendMessageCompat("usage: count 50 or count THREAD_ID 50", threadID);
      }

      if (!max || isNaN(max)) {
        return sendMessageCompat("invalid number", threadID);
      }

      if (activeCounts[target]) {
        return sendMessageCompat("already counting", threadID);
      }

      activeCounts[target] = true;

      (async () => {
        for (let i = 1; i <= max; i++) {

          if (!activeCounts[target]) break;

          const ok = await sendMessageCompat(String(i), target);
          if (!ok) break;

          // ⚡ SUPER FAST SAFE DELAY
          await new Promise(r => setTimeout(r, 15));
        }

        activeCounts[target] = false;
      })();

      return;
    }

    // ---------- STOP COUNT ----------
    if (lower.startsWith("stopcount") && isOwner) {
      const target = args[1] || threadID;
      activeCounts[target] = false;
      return sendMessageCompat("stopped", threadID);
    }

    // ---------- STOP SPAM ----------
    if (lower.startsWith("✓") && isOwner) {
      const target = args[1] || threadID;
      stopSpam(target);
      return sendMessageCompat("stopped", threadID);
    }

    // ---------- ANDAR ----------
    if (lower.startsWith("andar ") && isOwner) {

      const after = raw.substring(6).trim();
      const tokens = after.split(" ");

      let target = threadID;
      let rest = after;

      if (tokens.length > 1 && looksLikeThreadID(tokens[0])) {
        target = tokens[0];
        rest = after.substring(tokens[0].length).trim();
      }

      const list = rest.split(",").map(s => s.trim()).filter(Boolean);

      persisted.lists[target] = list;
      spamIndexes[target] = 0;

      startSpam(target);

      return sendMessageCompat(`started on ${target}`, threadID);
    }

    // ---------- AUTO REPLY ----------
    if (!persisted.active[threadID]) return;
    if (senderID == api.getCurrentUserID()) return;

    const now = Date.now();

    if (lastReplyTime[threadID] &&
        now - lastReplyTime[threadID] < getDelay()) return;

    lastReplyTime[threadID] = now;

    const msgs = persisted.lists[threadID] || ["😴", "ok"];
    const idx = spamIndexes[threadID] % msgs.length;

    setTimeout(async () => {
      await sendMessageCompat(msgs[idx], threadID);
    }, getDelay());

    spamIndexes[threadID]++;
  });
}

// ---------- START ----------
function startBot() {
  const loginData = fs.existsSync("appstate.json")
    ? { appState: JSON.parse(fs.readFileSync("appstate.json")) }
    : { email: config.email, password: config.password };

  login(loginData, (err, apiInstance) => {
    if (err) return console.log(err);

    api = apiInstance;

    fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState(), null, 2));

    startListener();
  });
}

// ---------- SERVER ----------
const app = express();
app.get("/", (_, res) => res.send("running"));

app.listen(3000, () => startBot());
