const fs = require("fs");
const path = require("path");

class RAGEngine {
  constructor(csvPath, options = {}) {
    this.csvPath = csvPath || path.join(__dirname, "../data/products.csv");
    this.topK = options.topK || Number(process.env.RAG_TOP_K || 15);
    this.products = [];
    this.loadData();
  }

  // Parser baris CSV yang aman terhadap tanda kutip ("...") dan koma di dalam teks
  parseCSVLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  detectCategory(productName) {
    const n = (productName || "").toLowerCase();
    if (n.includes("hemat") || n.includes("paket") || n.includes("pcs")) return "Paket Hemat";
    if (n.includes("lip") || n.includes("balm") || n.includes("tint") || n.includes("stain")) return "Lip Makeup";
    if (n.includes("serum")) return "Serum Wajah";
    if (n.includes("moisturizer") || n.includes("pelembab") || n.includes("night cream")) return "Moisturizer";
    if (n.includes("sunscreen")) return "Sunscreen";
    if (n.includes("cleanser") || n.includes("sabun")) return "Facial Wash";
    if (n.includes("powder") || n.includes("cushion") || n.includes("blur")) return "Face Makeup";
    return "Skincare & Kosmetik";
  }

  parsePriceNumber(priceStr) {
    if (!priceStr) return 0;
    const cleaned = String(priceStr).replace(/[^\d]/g, "");
    return cleaned ? Number(cleaned) : 0;
  }

  formatCurrency(num) {
    if (!num || isNaN(num)) return "Harga cek di Shopee";
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0
    }).format(num);
  }

  loadData() {
    try {
      if (!fs.existsSync(this.csvPath)) {
        console.warn(`[RAG] File CSV tidak ditemukan di: ${this.csvPath}`);
        this.products = [];
        return;
      }

      const content = fs.readFileSync(this.csvPath, "utf-8");
      const lines = content.trim().split(/\r?\n/);
      if (lines.length < 2) {
        this.products = [];
        return;
      }

      const headers = this.parseCSVLine(lines[0]).map(h => h.toLowerCase());

      this.products = lines
        .slice(1)
        .map(line => {
          const cols = this.parseCSVLine(line);
          const raw = {};
          headers.forEach((h, idx) => {
            raw[h] = cols[idx] || "";
          });

          // Pemetaan otomatis kolom hasil Instant Data Scraper Shopee
          const link = raw["contents href"] || cols[0] || "";
          const gambar = raw["_image_yazkc_11 src"] || cols[1] || "";
          const nama = raw["whitespace-normal"] || cols[2] || "";
          const rawHarga = raw["font-medium 2"] || raw["font-medium"] || cols[3] || "";
          const diskon = raw["h-4"] || "";
          const rating = raw["inline-block"] || "";
          const terjual = raw["truncate 2"] || (raw["truncate"] && raw["truncate"].includes("terjual") ? raw["truncate"] : "");

          const hargaAngka = this.parsePriceNumber(rawHarga);
          const kategori = this.detectCategory(nama);

          return {
            nama,
            kategori,
            harga: hargaAngka,
            hargaFormatted: this.formatCurrency(hargaAngka),
            diskon,
            rating,
            terjual,
            link,
            gambar
          };
        })
        .filter(p => p.nama && p.nama.length > 2);

      console.log(`[RAG] Berhasil memuat ${this.products.length} produk Shopee dari CSV`);
    } catch (err) {
      console.error("[RAG] Gagal memuat data CSV:", err);
      this.products = [];
    }
  }

  isGreetingQuery(query) {
    if (!query) return false;
    const q = query.toLowerCase().trim();
    const greetings = [
      "halo", "hai", "hi", "hey", "hello", "p", "ping", "test",
      "pagi", "selamat pagi", "siang", "selamat siang", "sore", "selamat sore",
      "malam", "selamat malam", "assalamualaikum", "assalamu'alaikum",
      "assalamu alaikum", "permisi"
    ];
    if (greetings.includes(q)) return true;

    if (/^(halo|hai|hi|hey|hello|selamat\s+(pagi|siang|sore|malam)|assalamu\s*alaikum)\b/i.test(q)) {
      const productKeywords = ["produk", "harga", "katalog", "jual", "beli", "serum", "lip", "sunscreen", "moisturizer", "paket", "promo"];
      return !productKeywords.some(pk => q.includes(pk));
    }
    return false;
  }

  isAllProductsQuery(query) {
    if (!query) return false;
    const q = query.toLowerCase().trim();

    const specificTerms = ["serum", "lip", "balm", "tint", "sunscreen", "moisturizer", "cleanser", "acne", "jerawat", "ceramide", "vitamin", "retinol", "termurah", "termahal"];
    if (specificTerms.some(term => q.includes(term))) {
      return false;
    }

    const allPatterns = [
      /semua(\s+produk(nya)?)?/,
      /(apa|ada)\s+(aja|saja)(\s+produk(nya)?)?/,
      /produk\s+(apa|ada)\s+(aja|saja)/,
      /katalog(\s+produk)?/,
      /daftar\s+(produk|harga)/,
      /list\s+produk/,
      /koleksi(\s+lengkap)?/,
      /rekomendasi\s+produk/
    ];
    return allPatterns.some(pattern => pattern.test(q));
  }

  search(query, k = this.topK) {
    if (!query || this.products.length === 0) return [];
    const normalized = query.toLowerCase().trim();

    if (this.isGreetingQuery(normalized)) return [];

    // Jika menanyakan produk termurah
    if (normalized.includes("termurah") || normalized.includes("paling murah")) {
      return [...this.products]
        .filter(p => p.harga > 0)
        .sort((a, b) => a.harga - b.harga)
        .slice(0, 5);
    }

    // Jika menanyakan produk termahal
    if (normalized.includes("termahal") || normalized.includes("paling mahal")) {
      return [...this.products]
        .filter(p => p.harga > 0)
        .sort((a, b) => b.harga - a.harga)
        .slice(0, 5);
    }

    if (this.isAllProductsQuery(normalized)) {
      return this.products.slice(0, k);
    }

    const stopWords = ["yang", "ada", "apa", "aja", "saja", "berapa", "harga", "harganya", "untuk", "dan", "atau", "kak", "min", "tolong", "carikan", "rekomendasi", "produk", "hanasui"];
    const queryTokens = normalized
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 2 && !stopWords.includes(t));

    if (queryTokens.length === 0) {
      return this.products.slice(0, k);
    }

    const scored = this.products
      .map(p => {
        let score = 0;
        const namaLower = p.nama.toLowerCase();
        const katLower = p.kategori.toLowerCase();

        for (const token of queryTokens) {
          if (namaLower.includes(token)) score += 8;
          if (katLower.includes(token)) score += 5;
        }
        return { product: p, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      return scored.slice(0, k).map(item => item.product);
    }

    // Fallback: kembalikan sebagian katalog agar LLM tetap punya referensi produk toko
    return this.products.slice(0, Math.min(8, k));
  }

  buildContext(query) {
    const relevantProducts = this.search(query);
    if (!relevantProducts || relevantProducts.length === 0) return "";

    let output = "Daftar Katalog Produk Hanasui Official Store (Data Resmi Shopee):\n\n";
    relevantProducts.forEach((p, idx) => {
      output += `${idx + 1}. *${p.nama}*\n`;
      output += `   • Kategori: ${p.kategori}\n`;
      output += `   • Harga: ${p.hargaFormatted}${p.diskon ? ` (Diskon ${p.diskon})` : ""}\n`;
      if (p.rating) output += `   • Rating: ⭐ ${p.rating}${p.terjual ? ` | ${p.terjual}` : ""}\n`;
      if (p.link) output += `   • Link Shopee: ${p.link}\n`;
    });

    return output.trim();
  }
}

module.exports = RAGEngine;