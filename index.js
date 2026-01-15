const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

/* ====================================================
   CONFIG
==================================================== */
const { SUPABASE_URL, SUPABASE_KEY, ADMIN_PIN } = process.env;

/* ====================================================
   LOGGING
==================================================== */
console.log("🚀 KonfirmPay server starting");
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
  next();
});

/* ====================================================
   MIDDLEWARE
==================================================== */
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ====================================================
   STATIC FILES (Public folder – capital P)
==================================================== */
const publicPath = path.join(__dirname, "Public");
app.use(express.static(publicPath));

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(publicPath, "admin.html"));
});

/* ====================================================
   SIMPLE PIN HASH
==================================================== */
function hashPin(pin) {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

const ADMIN_PIN_HASH = hashPin(ADMIN_PIN);

/* ====================================================
   ADMIN PIN VERIFY ENDPOINT
==================================================== */
app.post("/admin/verify-pin", (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: "PIN required" });

  if (hashPin(pin) === ADMIN_PIN_HASH) {
    return res.json({ success: true });
  }

  res.status(401).json({ error: "Invalid PIN" });
});

/* ====================================================
   SUPABASE CLIENT
==================================================== */
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
    throw new Error(text);
  }
  return res.json();
}

/* ====================================================
   HEALTH
==================================================== */
app.get("/", (_, res) => {
  res.send("KonfirmPay backend is running");
});

/* ====================================================
   ADMIN – REGISTER MERCHANT
==================================================== */
app.post("/admin/merchant", async (req, res) => {
  try {
    const { name, paybill, account_number } = req.body;
    if (!name || !paybill || !account_number) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const existing = await supabase(
      `merchants?paybill=eq.${paybill}`
    );
    if (existing.length) {
      return res.status(400).json({ error: "Merchant already exists" });
    }

    const merchant = await supabase("merchants", {
      method: "POST",
      body: {
        name,
        paybill,
        account_number,
        is_chain: false,
        status: "ACTIVE"
      }
    });

    res.json(merchant[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ====================================================
   ADMIN – LIST MERCHANTS
==================================================== */
app.get("/admin/merchants", async (_, res) => {
  try {
    const merchants = await supabase(
      "merchants?status=eq.ACTIVE&order=created_at.desc"
    );
    res.json(merchants);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ====================================================
   ADMIN – GENERATE QR
==================================================== */
app.post("/admin/merchant/:id/generate-qr", async (req, res) => {
  try {
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ====================================================
   ADMIN – TRANSACTIONS
==================================================== */
app.get("/admin/transactions", async (_, res) => {
  try {
    const tx = await supabase(
      "transactions?order=created_at.desc&limit=50"
    );
    res.json(tx);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ====================================================
   START SERVER
==================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🟢 KonfirmPay running on port ${PORT}`);
});
