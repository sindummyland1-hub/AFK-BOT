const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");

// ---------- LOAD CONFIG ----------
const config = JSON.parse(fs.readFileSync("config.json"));

// ---------- GLOBAL ----------
let api = null;
let runningThreads = {}; // stores active thread loops

// ---------- UTIL ----------
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function randomDelay() {
  return Math.random() * (config.max_delay - config.min_delay) + config.min_delay;
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// ✅ NEW: typing + send
async function sendWithTyping(threadID, message) {
  try {
    api.sendTypingIndicator(threadID, true);
    const typingTime = Math.min(
      5000,
      message.length * (30 + Math.random() * 40)
    );
    await sleep(typingTime);
    await api.sendMessage(message, threadID);
    api.sendTypingIndicator(threadID, false);
    console.log(`[Send][${threadID}] ✅`, message);
  } catch (e) {
    console.log(`[Send][${threadID}] ❌`, e.error || e);
  }
}

// ---------- FILE SYSTEM ----------
const MESSAGE_DIR = "./messages";

function getMessageFiles() {
  if (!fs.existsSync(MESSAGE_DIR)) {
    console.log("[Files] messages folder missing!");
    return [];
  }

  const files = fs.readdirSync(MESSAGE_DIR)
    .filter(f => f.endsWith(".txt"));

  console.log("[Files] Found:", files);
  return files;
}

function loadMessages(file) {
  const fullPath = path.join(MESSAGE_DIR, file);
  const msgs = fs.readFileSync(fullPath, "utf-8")
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  return shuffle(msgs);
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

    for (let msg of messages) {
      if (!runningThreads[threadID]) return; // stop if thread is stopped
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
    if (err) return console.error(err);
    if (event.type !== "message" || !event.body) return;

    const msg = event.body.toLowerCase().trim();
    if (event.senderID !== config.adminID) return;

    const currentThread = event.threadID;

    // start [optional threadID]
    if (msg.startsWith("start")) {
      const parts = msg.split(" ");
      const targetThread = parts[1] ? parts[1].trim() : currentThread || config.threadID;

      if (!targetThread) {
        return api.sendMessage("❌ No thread ID provided and config.threadID is missing!", currentThread);
      }

      if (runningThreads[targetThread]) {
        return api.sendMessage(`⚠️ Bot already running on thread: ${targetThread}`, currentThread);
      }

      runningThreads[targetThread] = true;
      sendingLoop(targetThread); // start independent loop
      api.sendMessage(`✅ Bot started on thread: ${targetThread}`, currentThread);
    }

    // stop [optional threadID]
    if (msg.startsWith("stop")) {
      const parts = msg.split(" ");
      const targetThread = parts[1] ? parts[1].trim() : currentThread;

      if (targetThread) {
        if (!runningThreads[targetThread]) {
          return api.sendMessage(`⚠️ Bot is not running on thread: ${targetThread}`, currentThread);
        }
        runningThreads[targetThread] = false;
        api.sendMessage(`🛑 Bot stopped on thread: ${targetThread}`, currentThread);
      } else {
        // if no threadID, stop all
        for (let t in runningThreads) runningThreads[t] = false;
        api.sendMessage("🛑 Bot stopped on all threads.", currentThread);
      }
    }

    // stop all
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

  login(loginData, (err, apiInstance) => {
    if (err) {
      console.error("[Login Error]", err);
      return;
    }

    api = apiInstance;
    console.log("[Login] ✅ Success");

    // save session
    fs.writeFileSync(
      "appstate.json",
      JSON.stringify(api.getAppState(), null, 2)
    );

    startListener();
  });
}

// ---------- START ----------
console.log("=== FCA RENDER BOT STARTING ===");
startBot();