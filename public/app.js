// GANTI DENGAN NOMOR WHATSAPP BOT ANDA (awali dengan 62)
const WA_BOT_NUMBER = "6283830604733";

const productsGrid = document.getElementById("productsGrid");
const searchInput = document.getElementById("searchInput");
const categoryFilter = document.getElementById("categoryFilter");
const waCategorySelect = document.getElementById("waCategorySelect");
const waDirectLink = document.getElementById("waDirectLink");

const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const sendBtn = document.getElementById("sendBtn");

// Gateway WA elements
const toggleGatewayBtn = document.getElementById("toggleGatewayBtn");
const gatewayPanel = document.getElementById("gatewayPanel");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const qrBox = document.getElementById("qrBox");

let allProducts = [];
let currentQRCode = null;
const webSessionId = "web-" + Math.random().toString(36).substring(2, 10);

// 1. Update Link Tombol WhatsApp menggunakan encodeURIComponent()
function updateWhatsAppLink() {
  const kategori = waCategorySelect.value;
  const pesan = `Halo Hanasui Official Store, saya tertarik melihat katalog dan menanyakan rekomendasi produk kategori *${kategori}*.`;
  waDirectLink.href = `https://wa.me/${WA_BOT_NUMBER}?text=${encodeURIComponent(pesan)}`;
}
waCategorySelect.addEventListener("change", updateWhatsAppLink);
updateWhatsAppLink();

// 2. Muat dan Filter Katalog Produk
async function loadProducts() {
  try {
    const res = await fetch("/api/products");
    const data = await res.json();
    allProducts = data.products || [];

    const categories = [...new Set(allProducts.map(p => p.kategori))];
    categories.forEach(cat => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      categoryFilter.appendChild(opt);
    });

    renderProducts(allProducts);
  } catch (err) {
    productsGrid.innerHTML = "<p>Gagal memuat katalog produk.</p>";
  }
}

function renderProducts(list) {
  if (list.length === 0) {
    productsGrid.innerHTML = "<p>Tidak ada produk yang cocok dengan pencarian.</p>";
    return;
  }

  productsGrid.innerHTML = list.map(p => `
    <article class="product-card">
      <img class="product-img" src="${p.gambar || 'https://via.placeholder.com/300x300?text=Hanasui'}" alt="${p.nama}" loading="lazy">
      <div class="product-body">
        <span class="product-cat">${p.kategori}</span>
        <h3 class="product-title" title="${p.nama}">${p.nama}</h3>
        <div class="product-price">${p.hargaFormatted} ${p.diskon ? `<small style="color:#16a34a;">(${p.diskon})</small>` : ""}</div>
        <div class="product-meta">⭐ ${p.rating || "4.9"} • ${p.terjual || "Terlaris"}</div>
        <a href="${p.link}" target="_blank" class="btn-buy">Lihat di Shopee ↗</a>
      </div>
    </article>
  `).join("");
}

function filterProducts() {
  const kw = searchInput.value.toLowerCase().trim();
  const cat = categoryFilter.value;
  const filtered = allProducts.filter(p => {
    const matchKw = p.nama.toLowerCase().includes(kw);
    const matchCat = cat === "ALL" || p.kategori === cat;
    return matchKw && matchCat;
  });
  renderProducts(filtered);
}

searchInput.addEventListener("input", filterProducts);
categoryFilter.addEventListener("change", filterProducts);

// 3. Logika Chatbot Web RAG
function formatChatHTML(text) {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<strong>$1</strong>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">Buka Produk Shopee ↗</a>')
    .replace(/\n/g, "<br>");
  return html;
}

function appendMessage(text, sender) {
  const div = document.createElement("div");
  div.className = `msg ${sender}`;
  div.innerHTML = sender === "bot" ? formatChatHTML(text) : text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatForm.addEventListener("submit", async e => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;

  appendMessage(message, "user");
  chatInput.value = "";
  sendBtn.disabled = true;
  sendBtn.textContent = "...";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId: webSessionId })
    });
    const data = await res.json();
    appendMessage(data.reply || "Maaf, terjadi kendala saat membalas.", "bot");
  } catch (err) {
    appendMessage("Gagal terhubung ke server chatbot.", "bot");
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Kirim";
  }
});

// 4. Kontrol Gateway WhatsApp (Hanya aktif di server lokal)
toggleGatewayBtn.onclick = () => gatewayPanel.classList.toggle("hidden");

async function checkBotStatus() {
  try {
    const res = await fetch("/api/bot/status");
    const data = await res.json();

    if (data.isVercel) {
      toggleGatewayBtn.classList.add("hidden");
      gatewayPanel.classList.add("hidden");
      return;
    }

    if (data.isReady) {
      statusText.textContent = `Bot Terhubung (${data.botNumber || "Aktif"})`;
      statusDot.className = "dot ready";
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      qrBox.classList.add("hidden");
    } else if (data.hasQRCode) {
      statusText.textContent = "Menunggu Scan QR";
      statusDot.className = "dot waiting";
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      qrBox.classList.remove("hidden");
      const qrRes = await fetch("/api/bot/qr");
      const qrData = await qrRes.json();
      if (qrData.qr && qrData.qr !== currentQRCode) {
        currentQRCode = qrData.qr;
        document.getElementById("qrcode").innerHTML = `<img width="240" height="240" src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(qrData.qr)}">`;
      }
    } else if (data.isInitializing) {
      statusText.textContent = "Menginisialisasi WhatsApp...";
      statusDot.className = "dot waiting";
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      qrBox.classList.remove("hidden");
    } else {
      statusText.textContent = "Bot Offline";
      statusDot.className = "dot";
      startBtn.classList.remove("hidden");
      stopBtn.classList.add("hidden");
      qrBox.classList.add("hidden");
    }
  } catch (e) {}
}

startBtn.onclick = async () => {
  startBtn.disabled = true;
  await fetch("/api/bot/start", { method: "POST" });
  startBtn.disabled = false;
  checkBotStatus();
};

stopBtn.onclick = async () => {
  stopBtn.disabled = true;
  await fetch("/api/bot/stop", { method: "POST" });
  stopBtn.disabled = false;
  checkBotStatus();
};

resetBtn.onclick = async () => {
  if (!confirm("Reset sesi WhatsApp dan scan ulang QR?")) return;
  await fetch("/api/bot/reset", { method: "POST" });
  checkBotStatus();
};

loadProducts();
checkBotStatus();
setInterval(checkBotStatus, 5000);