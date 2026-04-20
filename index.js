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

// ---------- TARGET USERS ----------
const targetUsers = {};

// ---------- SPAM TRACKER ----------
const spamTracker = {};

// ---------- AUTOREACT ----------
let autoReactEnabled = false;
const AUTO_REACT_EMOJI = "😆";

const REACT_LIMIT = 10;
const reactTracker = {};

async function autoReact(threadID, messageID) {
  if (!autoReactEnabled || !api || !messageID) return;

  if (!reactTracker[threadID]) {
    reactTracker[threadID] = { count: 0, resetTime: Date.now() + 60000 };
  }

  const tracker = reactTracker[threadID];

  if (Date.now() > tracker.resetTime) {
    tracker.count = 0;
    tracker.resetTime = Date.now() + 60000;
  }

  if (tracker.count >= REACT_LIMIT) return;

  tracker.count++;

  const delay = 1000 + Math.random() * 1500;

  setTimeout(async () => {
    try {
      await api.setMessageReaction(AUTO_REACT_EMOJI, messageID, () => {}, true);
    } catch {
      setTimeout(() => {
        try {
          api.setMessageReaction(AUTO_REACT_EMOJI, messageID, () => {}, true);
        } catch {}
      }, 1500);
    }
  }, delay);
}

// ---------- SEND ----------
async function sendMessageCompat(text, threadID) {
  if (!api) return false;

  try {
    if (api.sendTypingIndicator) api.sendTypingIndicator(threadID, true);

    const info = await api.sendMessage(text, threadID);

    if (api.sendTypingIndicator) api.sendTypingIndicator(threadID, false);

    if (info?.messageID) autoReact(threadID, info.messageID);

    return true;
  } catch {
    console.log("[SEND BLOCKED]", threadID);
    try { api.sendTypingIndicator(threadID, false); } catch {}
    return false;
  }
}

// ---------- SMART DELAY ----------
function humanDelay(base = 9000, variance = 4000) {
  return base + Math.random() * variance;
}

function typingSim(threadID, duration = 1000) {
  try {
    if (api.sendTypingIndicator) {
      api.sendTypingIndicator(threadID, true);
      setTimeout(() => {
        try { api.sendTypingIndicator(threadID, false); } catch {}
      }, duration);
    }
  } catch {}
}

// ---------- STATE ----------
const stateFile = "./spam_state.json";

let persisted = {};
try {
  if (fs.existsSync(stateFile)) persisted = JSON.parse(fs.readFileSync(stateFile));
} catch {}

persisted.lists = persisted.lists || {};
persisted.active = persisted.active || {};

let spamIndexes = {};
const idleTimers = {};

function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(persisted, null, 2));
}

// ---------- ANDAR LOOP ----------
function scheduleNextMessage(threadID) {
  if (!persisted.active[threadID]) return;

  clearTimeout(idleTimers[threadID]);

  const spam = spamTracker[threadID]?.count || 0;

  let delay;
  if (spam >= 5) {
    delay = 800 + Math.random() * 400;
  } else {
    delay = humanDelay();
  }

  idleTimers[threadID] = setTimeout(async () => {
    if (!persisted.active[threadID]) return;

    const msgs = persisted.lists[threadID] || ["😴", "ok"];
    const idx = spamIndexes[threadID] % msgs.length;

    typingSim(threadID);

    const typingDelay = spam >= 5
      ? 200 + Math.random() * 200
      : 800 + Math.random() * 1200;

    await new Promise(r => setTimeout(r, typingDelay));

    await sendMessageCompat(msgs[idx], threadID);

    spamIndexes[threadID]++;
    scheduleNextMessage(threadID);

  }, delay);
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
  clearTimeout(idleTimers[tid]);
  saveState();
}

// ---------- LISTENER ----------
function startListener() {
  api.listenMqtt(async (err, event) => {

    if (err) {
      console.log("[MQTT ERROR RECONNECTING]");
      setTimeout(() => {
        try { startListener(); } catch {}
      }, 10000);
      return;
    }

    if (!event || !event.body) return;
    if (event.type !== "message" && event.type !== "message_reply") return;

    const raw = event.body.trim();
    const lower = raw.toLowerCase();
    const args = raw.split(/\s+/);

    const threadID = event.threadID;
    const senderID = event.senderID;
    const isOwner = senderID == OWNER_ID;

    // ---------- SPAM TRACK ----------
    if (!spamTracker[threadID]) {
      spamTracker[threadID] = { count: 0, last: Date.now() };
    }

    const now = Date.now();
    const tracker = spamTracker[threadID];

    if (now - tracker.last > 3000) {
      tracker.count = 0;
    }

    tracker.count++;
    tracker.last = now;

    // ---------- TARGET FILTER ----------
    if (!isOwner) {
      const targets = targetUsers[threadID];
      if (targets && targets.length > 0 && !targets.includes(senderID)) {
        return;
      }
    }

    // reset delay
    if (persisted.active[threadID]) {
      scheduleNextMessage(threadID);
    }

    // ---------- TARGET COMMANDS ----------
    if (lower.startsWith("target ") && isOwner) {
      const id = args[1];
      if (!id) return sendMessageCompat("provide user id", threadID);

      if (!targetUsers[threadID]) targetUsers[threadID] = [];
      if (!targetUsers[threadID].includes(id)) {
        targetUsers[threadID].push(id);
      }

      return sendMessageCompat(`target added: ${id}`, threadID);
    }

    if (lower.startsWith("untarget ") && isOwner) {
      const id = args[1];
      if (!targetUsers[threadID]) return;

      targetUsers[threadID] = targetUsers[threadID].filter(u => u !== id);
      return sendMessageCompat(`target removed: ${id}`, threadID);
    }

    if (lower === "cleartarget" && isOwner) {
      delete targetUsers[threadID];
      return sendMessageCompat("targets cleared", threadID);
    }

    if (lower === "targets" && isOwner) {
      const list = targetUsers[threadID] || [];
      if (list.length === 0) return sendMessageCompat("no targets set", threadID);

      return sendMessageCompat(
        "targets:\n" + list.map(id => "- " + id).join("\n"),
        threadID
      );
    }

    // ---------- AUTOREACT ----------
    if (lower === "autoreact on" && isOwner) {
      autoReactEnabled = true;
      return sendMessageCompat("autoreact enabled", threadID);
    }

    if (lower === "autoreact off" && isOwner) {
      autoReactEnabled = false;
      return sendMessageCompat("autoreact disabled", threadID);
    }

    // ---------- THREADLIST ----------
    if (lower === "threadlist" && isOwner) {
      try {
        const list = await api.getThreadList(50, null, ["INBOX"]);

        const groups = list.filter(t => t.isGroup);
        const inbox = list.filter(t => !t.isGroup);

        let msg = "📋 THREAD LIST\n\n";

        msg += "👥 GROUPS:\n";
        groups.forEach(t => {
          msg += `- ${t.name || "no name"}\n  ID: ${t.threadID}\n\n`;
        });

        msg += "💬 INBOX:\n";
        inbox.forEach(t => {
          msg += `- ${t.threadID}\n`;
        });

        return sendMessageCompat(msg, threadID);

      } catch {
        return sendMessageCompat("failed to fetch threads", threadID);
      }
    }

    // ---------- COUNT ----------
    if (lower.startsWith("count") && isOwner) {

      let target = threadID;
      let max;

      if (args.length === 2) {
        max = parseInt(args[1]);
      } else if (args.length === 3 && looksLikeThreadID(args[1])) {
        target = args[1];
        max = parseInt(args[2]);
      } else {
        return sendMessageCompat("usage: count 50", threadID);
      }

      if (!max || isNaN(max)) return sendMessageCompat("invalid number", threadID);
      if (activeCounts[target]) return sendMessageCompat("already counting", threadID);

      activeCounts[target] = true;

      (async () => {
        for (let i = 1; i <= max; i++) {
          if (!activeCounts[target]) break;
          const ok = await sendMessageCompat(String(i), target);
          if (!ok) break;
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
      scheduleNextMessage(target);

      return sendMessageCompat(`started on ${target}`, threadID);
    }

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
