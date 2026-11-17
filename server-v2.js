require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const RAGEngine = require("./lib/rag");

const app = express();
const PORT = process.env.PORT || 3001;
const IS_VERCEL = Boolean(process.env.VERCEL);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Inisialisasi Groq SDK
let groq = null;
if (process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.includes("isi_api_key")) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
}

// Inisialisasi RAG Engine untuk data Shopee Hanasui
const ragEngine = new RAGEngine(path.join(__dirname, "data/products.csv"));

// Load Knowledge Base FAQ
const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.json");
let knowledge = { keywords: {}, responses: {} };
function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_PATH)) {
      knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("Gagal membaca knowledge.json:", err);
  }
}
loadKnowledge();

// State WhatsApp Bot (Hanya aktif di lingkungan lokal)
let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let isCleaning = false;

// Riwayat percakapan multi-turn
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 6;
const SESSION_TTL_MS = 20 * 60 * 1000;

function getUserHistory(senderId) {
  if (!senderId) return [];
  const session = conversationHistory.get(senderId);
  if (!session) return [];
  if (Date.now() - session.lastActive > SESSION_TTL_MS) {
    conversationHistory.delete(senderId);
    return [];
  }
  return session.messages || [];
}

function appendUserHistory(senderId, userMsg, botReply) {
  if (!senderId) return;
  const now = Date.now();
  let session = conversationHistory.get(senderId);
  if (!session || now - session.lastActive > SESSION_TTL_MS) {
    session = { messages: [], lastActive: now };
  }
  session.messages.push({ role: "user", content: userMsg });
  session.messages.push({ role: "assistant", content: botReply });
  if (session.messages.length > MAX_HISTORY_MESSAGES) {
    session.messages = session.messages.slice(-MAX_HISTORY_MESSAGES);
  }
  session.lastActive = now;
  conversationHistory.set(senderId, session);
}

// Deteksi otomatis lokasi Chrome di Windows agar tidak gagal launch
function getChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function initializeClient() {
  if (IS_VERCEL) return null;
  if (client) return client;

  const { Client, LocalAuth } = require("whatsapp-web.js");
  const qrcode = require("qrcode-terminal");

  const chromePath = getChromePath();
  const puppeteerConfig = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
  };
  if (chromePath) {
    puppeteerConfig.executablePath = chromePath;
  }

  client = new Client({
    authStrategy: new LocalAuth({ clientId: "chatbot-shopee" }),
    puppeteer: puppeteerConfig
  });

  client.on("qr", qr => {
    qrCodeData = qr;
    isInitializing = false;
    console.log("\n================ KODE QR WHATSAPP ================");
    qrcode.generate(qr, { small: true });
    console.log("Pindai QR code di atas atau melalui web dashboard.");
    console.log("==================================================\n");
  });

  client.on("authenticated", () => {
    console.log("Autentikasi WhatsApp berhasil.");
  });

  client.on("auth_failure", msg => {
    console.error("Autentikasi WhatsApp gagal:", msg);
    isInitializing = false;
  });

  client.on("ready", () => {
    isReady = true;
    isInitializing = false;
    qrCodeData = null;
    console.log("Bot WhatsApp Hanasui siap digunakan!");
  });

  client.on("disconnected", reason => {
    console.log("WhatsApp terputus:", reason);
    isReady = false;
    qrCodeData = null;
    client = null;
  });

  client.on("message", async msg => {
    try {
      if (msg.fromMe || !msg.body) return;
      const isPersonalChat = msg.from.endsWith("@c.us") || msg.from.endsWith("@lid");
      const isNotStatus = !msg.from.endsWith("@status");
      if (!isPersonalChat || !isNotStatus) return;

      const message = msg.body.trim();
      console.log(`[WA Masuk dari ${msg.from}]: ${message}`);

      const reply = await getAIResponse(msg.from, message, "whatsapp");
      await msg.reply(reply);
    } catch (err) {
      console.error("Error memproses pesan WA:", err);
      try {
        await msg.reply("Mohon maaf, sistem sedang sibuk. Silakan coba beberapa saat lagi.");
      } catch (e) {}
    }
  });

  return client;
}

function formatMessage(text, channel = "whatsapp") {
  if (!text) return "";
  let formatted = text.replace(/\n{3,}/g, "\n\n").trim();
  if (channel === "whatsapp") {
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, "*$1*");
  }
  return formatted;
}

function isGreetingMessage(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();
  const greetings = [
    "halo", "hai", "hi", "hey", "hello", "p", "ping", "test",
    "pagi", "selamat pagi", "siang", "selamat siang", "sore", "selamat sore",
    "malam", "selamat malam", "assalamualaikum", "assalamu'alaikum", "permisi"
  ];
  if (greetings.includes(q)) return true;

  if (/^(halo|hai|hi|hey|hello|selamat\s+(pagi|siang|sore|malam)|assalamu\s*alaikum|permisi)\b/i.test(q)) {
    const productKeywords = ["produk", "harga", "katalog", "jual", "beli", "serum", "lip", "sunscreen", "moisturizer", "paket", "promo"];
    return !productKeywords.some(pk => q.includes(pk));
  }
  return false;
}

function isGratitudeMessage(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();
  return /^(terima\s*kasih|makasih|makasi|thanks|thank\s*you|thx|matur\s*nuwun|nuhun|syukron)\b/i.test(q);
}

async function getAIResponse(senderId, message, channel = "whatsapp") {
  const normalized = message.toLowerCase().trim();

  // 1. Sapaan
  if (isGreetingMessage(normalized)) {
    const reply = formatMessage(
      "Halo! Selamat datang di *Hanasui Official Store*. ✨\n\nAda yang bisa kami bantu seputar rekomendasi skincare, lip cream, atau promo produk Hanasui hari ini? 😊",
      channel
    );
    if (senderId) appendUserHistory(senderId, message, reply);
    return reply;
  }

  // 2. Ucapan Terima Kasih
  if (isGratitudeMessage(normalized)) {
    const reply = formatMessage(
      "Sama-sama! Senang bisa membantu Anda di *Hanasui Official Store*. ✨\n\nJika ingin menanyakan produk lain atau langsung checkout di Shopee, silakan hubungi kami kembali ya! 😊",
      channel
    );
    if (senderId) appendUserHistory(senderId, message, reply);
    return reply;
  }

  // 3. Cek FAQ Manual (knowledge.json)
  if (knowledge.responses && knowledge.responses[normalized]) {
    const reply = formatMessage(knowledge.responses[normalized], channel);
    if (senderId) appendUserHistory(senderId, message, reply);
    return reply;
  }

  if (knowledge.keywords) {
    for (const [kw, targetKey] of Object.entries(knowledge.keywords)) {
      if (normalized.includes(kw.toLowerCase()) && knowledge.responses[targetKey]) {
        const reply = formatMessage(knowledge.responses[targetKey], channel);
        if (senderId) appendUserHistory(senderId, message, reply);
        return reply;
      }
    }
  }

  // 4. Ambil Riwayat & Konteks RAG dari CSV Shopee
  const history = senderId ? getUserHistory(senderId) : [];
  let ragContext = ragEngine.buildContext(message);

  if (!ragContext && history.length > 0) {
    const prevQueries = history
      .filter(h => h.role === "user")
      .slice(-2)
      .map(h => h.content)
      .join(" ");
    ragContext = ragEngine.buildContext(`${prevQueries} ${message}`);
  }

  // 5. Panggil Groq LLM
  try {
    if (!groq) {
      if (process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.includes("isi_api_key")) {
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      } else {
        return "API Key Groq belum dikonfigurasi pada Environment Variables (.env).";
      }
    }

    const systemPrompt = `Anda adalah Beauty Advisor resmi dari "Hanasui Official Store" di Shopee. Jawab dalam Bahasa Indonesia yang ramah, hangat, persuasif, informatif, dan rapi.

ATURAN UTAMA:
1. Jawab HANYA berdasarkan data produk resmi pada Konteks Katalog Shopee di bawah ini. Jangan mengarang harga atau produk yang tidak ada di katalog.
2. Setiap kali merekomendasikan produk, sertakan *Nama Produk*, *Harga*, dan *Link Shopee* produk tersebut agar pelanggan bisa langsung membukanya.
3. Jangan pernah menyebut istilah teknis internal seperti "file CSV", "database", atau "hasil scraping".
4. Jika pelanggan menanyakan produk di luar daftar katalog, sampaikan dengan sopan dan arahkan untuk mengecek etalase lengkap Shopee kami di https://shopee.co.id/hanasuiofficialstore.
5. Gunakan format poin-poin yang rapi dan mudah dibaca di HP maupun web.

${ragContext ? ragContext : "Konteks Katalog: (Tidak ada produk spesifik yang ditemukan, jawab secara ramah dan tawarkan bantuan seputar skincare/makeup Hanasui)."}`;

    const messagesPayload = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message }
    ];

    const candidateModels = [
      process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-20b"
    ];

    let lastError = null;
    for (const modelName of candidateModels) {
      try {
        const completion = await groq.chat.completions.create({
          model: modelName,
          messages: messagesPayload,
          max_tokens: Number(process.env.GROQ_MAX_TOKENS || 1500)
        });

        if (completion.choices && completion.choices[0]?.message?.content) {
          const reply = formatMessage(completion.choices[0].message.content, channel);
          if (senderId) appendUserHistory(senderId, message, reply);
          return reply;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Groq Model ${modelName}] Gagal: ${err.message}`);
      }
    }
    throw lastError || new Error("Semua model Groq gagal.");
  } catch (error) {
    console.error("Error Groq API:", error.message);
    if (ragContext) {
      return formatMessage(`Berikut produk Hanasui yang relevan dari katalog kami:\n\n${ragContext}`, channel);
    }
    return "Mohon maaf, asisten AI sedang mengalami gangguan sementara. Silakan coba tanyakan kembali sebentar lagi.";
  }
}

function maskPhoneNumber(rawNumber) {
  if (!rawNumber) return null;
  let formatted = String(rawNumber).replace(/^62/, "08");
  if (formatted.length >= 8) {
    return `${formatted.slice(0, 2)}${"x".repeat(formatted.length - 6)}${formatted.slice(-4)}`;
  }
  return formatted;
}

// ================= API ENDPOINTS =================

app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Pesan tidak boleh kosong." });
    }
    const reply = await getAIResponse(sessionId || "web-visitor", message.trim(), "web");
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: "Gagal memproses pesan chatbot." });
  }
});

app.get("/api/products", (req, res) => {
  if (ragEngine.products.length === 0) {
    ragEngine.loadData();
  }
  res.json({ products: ragEngine.products });
});

app.get("/api/knowledge", (req, res) => {
  loadKnowledge();
  res.json(knowledge);
});

app.get("/api/bot/status", (req, res) => {
  if (IS_VERCEL) {
    return res.json({ isVercel: true, isReady: false, isInitializing: false, hasQRCode: false });
  }
  let botNumber = null;
  if (isReady && client?.info?.wid) {
    botNumber = maskPhoneNumber(client.info.wid.user);
  }
  res.json({
    isVercel: false,
    isReady,
    isInitializing,
    isCleaning,
    hasQRCode: Boolean(qrCodeData),
    botNumber
  });
});

app.get("/api/bot/qr", (req, res) => {
  res.json({ qr: qrCodeData });
});

app.post("/api/bot/start", async (req, res) => {
  if (IS_VERCEL) return res.status(400).json({ error: "Bot WA hanya berjalan di server lokal." });
  try {
    if (isReady) return res.json({ success: true, message: "Bot sudah berjalan." });
    if (isInitializing) return res.json({ success: true, message: "Sedang inisialisasi..." });
    isInitializing = true;
    const waClient = initializeClient();
    await waClient.initialize();
    res.json({ success: true });
  } catch (err) {
    isInitializing = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/bot/stop", async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    qrCodeData = null;
    if (client) await client.destroy();
    client = null;
    isCleaning = false;
    res.json({ success: true });
  } catch (err) {
    isCleaning = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/bot/reset", async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    isInitializing = false;
    qrCodeData = null;
    if (client) {
      try { await client.destroy(); } catch (e) {}
      client = null;
    }
    const authDir = path.join(__dirname, ".wwebjs_auth");
    const cacheDir = path.join(__dirname, ".wwebjs_cache");
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
    conversationHistory.clear();
    isCleaning = false;
    res.json({ success: true, message: "Sesi WhatsApp berhasil direset." });
  } catch (err) {
    isCleaning = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server Hanasui Katalog & Bot WA berjalan di http://localhost:${PORT}`);
  });
}

module.exports = app;