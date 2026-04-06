const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const express = require("express");

// ---------- LOAD CONFIG ----------
let config;
try {
  config = JSON.parse(fs.readFileSync("config.json"));
} catch (e) {
  console.error("[Config Error] Failed to read config.json", e);
  process.exit(1);
}

// ---------- GLOBAL ----------
let api = null;
let runningThreads = {}; // stores active thread loops

// ---------- UTIL ----------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = () => Math.random() * (config.max_delay - config.min_delay) + config.min_delay;
const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

// ---------- MESSAGES ----------
const MESSAGE_DIR = "./messages";
const getMessageFiles = () => {
  if (!fs.existsSync(MESSAGE_DIR)) {
    console.log("[Files] messages folder missing!");
    return [];
  }
  return fs.readdirSync(MESSAGE_DIR).filter(f => f.endsWith(".txt"));
};
const loadMessages = (file) => shuffle(fs.readFileSync(path.join(MESSAGE_DIR, file), "utf-8")
  .split("\n").map(x => x.trim()).filter(Boolean));

// ---------- SEND WITH TYPING ----------
async function sendWithTyping(threadID, message) {
  try {
    api.sendTypingIndicator(threadID, true);
    const typingTime = Math.min(5000, message.length * (30 + Math.random() * 40));
    await sleep(typingTime);
    await api.sendMessage(message, threadID);
    api.sendTypingIndicator(threadID, false);
    console.log(`[Send][${threadID}] ✅ ${message}`);
  } catch (e) {
    console.log(`[Send][${threadID}] ❌`, e.error || e);
  }
}

// ---------- SENDING LOOP ----------
async function sendingLoop(threadID) {
  const files = getMessageFiles();
  if (!files.length) return;

  let fileIndex = 0;
  console.log(`[Loop][${threadID}] Started sending messages.`);

  while (runningThreads[threadID]) {
    const file = files[fileIndex];
    const messages = loadMessages(file);
    console.log(`[Cycle][${threadID}] Using file: ${file}`);

    for (const msg of messages) {
      if (!runningThreads[threadID]) return;
      await sendWithTyping(threadID, msg);
      await sleep(randomDelay());
    }

    console.log(`[Cooldown][${threadID}] Waiting before next cycle...`);
    await sleep(config.cycle_cooldown);

    fileIndex = (fileIndex + 1) % files.length;
  }

  console.log(`[Loop][${threadID}] Stopped.`);
}

// ---------- COMMAND LISTENER ----------
function startListener() {
  api.listenMqtt((err, event) => {
    if (err) return console.error("[MQTT Error]", err);
    if (event.type !== "message" || !event.body) return;

    const msg = event.body.toLowerCase().trim();
    if (event.senderID !== config.adminID) return;

    const currentThread = event.threadID;

    if (msg.startsWith("start")) {
      const parts = msg.split(" ");
      const targetThread = parts[1] ? parts[1].trim() : currentThread || config.threadID;
      if (!targetThread) return api.sendMessage("❌ No thread ID provided!", currentThread);

      if (runningThreads[targetThread]) return api.sendMessage(`⚠️ Bot already running on thread: ${targetThread}`, currentThread);

      runningThreads[targetThread] = true;
      sendingLoop(targetThread);
      api.sendMessage(`✅ Bot started on thread: ${targetThread}`, currentThread);
    }

    if (msg.startsWith("stop")) {
      const parts = msg.split(" ");
      const targetThread = parts[1] ? parts[1].trim() : currentThread;

      if (targetThread) {
        if (!runningThreads[targetThread]) return api.sendMessage(`⚠️ Bot is not running on thread: ${targetThread}`, currentThread);
        runningThreads[targetThread] = false;
        api.sendMessage(`🛑 Bot stopped on thread: ${targetThread}`, currentThread);
      } else {
        for (let t in runningThreads) runningThreads[t] = false;
        api.sendMessage("🛑 Bot stopped on all threads.", currentThread);
      }
    }

    if (msg === "stopall") {
      for (let t in runningThreads) runningThreads[t] = false;
      api.sendMessage("🛑 Bot stopped on all threads.", currentThread);
    }
  });
}

// ---------- LOGIN ----------
function startBot() {
  const loginData = config.useAppState
    ? { appState: JSON.parse(fs.readFileSync("appstate.json")) }
    : { email: config.email, password: config.password };

  console.log("[Login] Attempting login...");

  login(loginData, (err, apiInstance) => {
    if (err) return console.error("[Login Error]", err);

    api = apiInstance;
    console.log("[Login] ✅ Success");

    fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState(), null, 2));
    startListener();
  });

  // timeout to prevent indefinite hang
  setTimeout(() => {
    if (!api) console.warn("[Login Warning] Login may be stuck, check credentials or appState.");
  }, 30000);
}

// ---------- EXPRESS SERVER ----------
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("<h1 style='text-align:center;margin-top:50px;'>BOT IS RUNNING!</h1>");
});

app.listen(PORT, () => {
  console.log(`✅ Render server started on port ${PORT}`);
  startBot(); // start bot AFTER server is listening
});
