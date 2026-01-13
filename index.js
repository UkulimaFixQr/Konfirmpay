const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

/**
 * ====================================================
 * STARTUP LOG
 * ====================================================
 */
console.log("🚀 KonfirmPay server starting");

/**
 * ====================================================
 * REQUEST LOGGING (VISIBLE ON RENDER)
 * ====================================================
 */
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
  next();
});

/**
 * ====================================================
 * BODY PARSERS
 * ====================================================
 */
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/**
 * ====================================================
 * STATIC FILES (ADMIN DASHBOARD)
 * NOTE: FOLDER IS 'Public' WITH CAPITAL P
 * ====================================================
 */
const publicPath = path.join(__dirname, "Public");
console.log("📁 Serving static files from:", publicPath);
app.use(express.static(publicPath));

/**
 * Explicit fallback (guarantees /admin.html works)
 */
app.get("/admin.html", (req, res) => {
  console.log("🛠 Explicit admin.html route hit");
  res.sendFile(path.join(publicPath, "admin.html"));
});

/**
 * ====================================================
 * SUPABASE REST CLIENT
 * ====================================================
 */
const { SUPABASE_URL, SUPABASE_KEY } = process.env;

async function supabase(pathname, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ Supabase error:", text);
    throw new Error(text);
  }

  return res.json();
}

/**
 * ====================================================
 * HEALTH CHECK
 * ====================================================
 */
app.get("/", (req, res) => {
  res.send("KonfirmPay backend is running");
});

/**
 * ====================================================
 * ADMIN – REGISTER MERCHANT
 * ====================================================
 */
app.post("/admin/merchant", async (req, res) => {
  try {
    console.log("🧑‍💼 Register merchant:", req.body);

    const merchant = await supabase("merchants", {
      method: "POST",
      body: {
        name: req.body.name,
        paybill: req.body.paybill,
        account: req.body.account,
        is_chain: false,
        status: "ACTIVE"
      }
    });

    res.json(merchant[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ====================================================
 * ADMIN – LIST MERCHANTS (FOR DROPDOWN)
 * ====================================================
 */
app.get("/admin/merchants", async (req, res) => {
  try {
    const merchants = await supabase(
      "merchants?status=eq.ACTIVE&order=created_at.desc"
    );
    res.json(merchants);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ====================================================
 * ADMIN – GENERATE IMMUTABLE QR
 * ====================================================
 */
app.post("/admin/merchant/:id/generate-qr", async (req, res) => {
  try {
    console.log("📦 Generate QR for merchant:", req.params.id);

    const qrToken =
      "KPQR_" + crypto.randomBytes(4).toString("hex").toUpperCase();

    const qr = await supabase("merchant_qrs", {
      method: "POST",
      body: {
        merchant_id: req.params.id,
        qr_token: qrToken,
        store_name: req.body.store_name,
        status: "ACTIVE"
      }
    });

    res.json({
      qr_token: qr[0].qr_token,
      ussd_code: `*384*${qr[0].qr_token}#`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ====================================================
 * ADMIN – LIST TRANSACTIONS
 * ====================================================
 */
app.get("/admin/transactions", async (req, res) => {
  try {
    const tx = await supabase(
      "transactions?order=created_at.desc&limit=50"
    );
    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ====================================================
 * GLOBAL ERROR HANDLER
 * ====================================================
 */
app.use((err, req, res, next) => {
  console.error("🔥 UNHANDLED ERROR:", err);
  res.status(500).send("Internal Server Error");
});

/**
 * ====================================================
 * START SERVER
 * ====================================================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🟢 KonfirmPay running on port ${PORT}`);
});
