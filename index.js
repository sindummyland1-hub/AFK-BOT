const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");

// ---------- LOAD CONFIG ----------
const config = JSON.parse(fs.readFileSync("config.json"));

// ---------- GLOBAL ----------
let api = null;
let running = false;

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

  while (running) {
    const file = files[fileIndex];
    const messages = loadMessages(file);

    console.log(`\n[Cycle] Using file: ${file}`);

    for (let msg of messages) {
      if (!running) return;

      try {
        await api.sendMessage(msg, threadID);
        console.log("[Send] ✅", msg);
      } catch (e) {
        console.log("[Send] ❌", e.error || e);
      }

      await sleep(randomDelay());
    }

    console.log("[Cooldown] Waiting...");
    await sleep(config.cycle_cooldown);

    fileIndex = (fileIndex + 1) % files.length;
  }
}

// ---------- COMMAND LISTENER ----------
function startListener() {
  api.listenMqtt((err, event) => {
    if (err) return console.error(err);

    if (event.type !== "message") return;
    if (!event.body) return;

    const msg = event.body.toLowerCase().trim();

    // DEBUG (remove later if you want)
    console.log(`[MSG] ${event.senderID}: ${msg}`);

    // ONLY ADMIN CAN CONTROL
    if (event.senderID !== config.adminID) return;

    if (msg === "start") {
      if (!running) {
        running = true;
        sendingLoop(config.threadID);
        api.sendMessage("✅ bot started", event.threadID);
      } else {
        api.sendMessage("⚠️ already running", event.threadID);
      }
    }

    if (msg === "stop") {
      running = false;
      api.sendMessage("🛑 bot stopped", event.threadID);
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
      console.log("[Login Error]", err);
      return;
    }

    api = apiInstance;

    console.log("[Login] ✅ Success");

    // SAVE SESSION
    fs.writeFileSync(
      "appstate.json",
      JSON.stringify(api.getAppState(), null, 2)
    );

    // START LISTENER
    startListener();
  });
}

// ---------- START ----------
console.log("=== FCA RENDER BOT STARTING ===");
startBot();
