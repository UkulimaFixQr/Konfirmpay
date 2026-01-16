const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

console.log("🔥 KONFIRMPAY BACKEND STARTING");

/* =========================
   STATIC FILES (CAPITAL P)
========================= */
app.use(express.static(path.join(__dirname, "Public")));

/* =========================
   SUPABASE
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.send("KonfirmPay backend running");
});

/* =========================
   🔐 ADMIN PIN VERIFY (FIXED)
========================= */
app.post("/admin/verify-pin", (req, res) => {
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ error: "PIN required" });
  }

  const expectedPin = process.env.ADMIN_PIN;

  if (!expectedPin) {
    console.error("❌ ADMIN_PIN missing in environment");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // strict string comparison (SAFE)
  if (pin.trim() === expectedPin.trim()) {
    return res.json({ success: true });
  }

  return res.status(401).json({ error: "Invalid PIN" });
});

/* =========================
   ADMIN: MERCHANTS
========================= */
app.get("/admin/merchants", async (req, res) => {
  const { data, error } = await supabase
    .from("merchants")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/admin/merchant", async (req, res) => {
  const { name, paybill, account_number } = req.body;

  const { data, error } = await supabase
    .from("merchants")
    .insert({ name, paybill, account_number })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/* =========================
   ADMIN: GENERATE QR
========================= */
app.post("/admin/merchant/:id/generate-qr", async (req, res) => {
  const { id } = req.params;
  const { store_name } = req.body;

  const payload = {
    merchant_id: id,
    store_name
  };

  // simple encoded QR payload
  const qrData = Buffer.from(JSON.stringify(payload)).toString("base64");

  res.json({
    merchant_id: id,
    store_name,
    qr_payload: qrData
  });
});

/* =========================
   ADMIN: TRANSACTIONS
========================= */
app.get("/admin/transactions", async (req, res) => {
  const { data, error } = await supabase
    .from("transactions")
    .select(`
      amount,
      status,
      created_at,
      merchants(name)
    `)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });

  const formatted = data.map(t => ({
    merchant_name: t.merchants?.name || "-",
    amount: t.amount,
    status: t.status,
    created_at: t.created_at
  }));

  res.json(formatted);
});

/* =========================
   DARAJA ACCESS TOKEN
========================= */
async function getAccessToken() {
  const auth = Buffer.from(
    process.env.DARAJA_CONSUMER_KEY +
    ":" +
    process.env.DARAJA_CONSUMER_SECRET
  ).toString("base64");

  const res = await axios.get(
    `${process.env.DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` }
    }
  );

  return res.data.access_token;
}

/* =========================
   STK PUSH (SAME PAYBILL)
========================= */
app.post("/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, amount, merchant_id } = req.body;

    if (!phone || !amount || !merchant_id) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      process.env.DARAJA_SHORTCODE +
      process.env.DARAJA_PASSKEY +
      timestamp
    ).toString("base64");

    const token = await getAccessToken();

    const stk = await axios.post(
      `${process.env.DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.DARAJA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: process.env.DARAJA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: "https://konfirmpay.onrender.com/mpesa/callback",
        AccountReference: merchant_id,
        TransactionDesc: "KonfirmPay Payment"
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    await supabase.from("stk_requests").insert({
      checkout_request_id: stk.data.CheckoutRequestID,
      merchant_id,
      amount,
      phone,
      status: "PENDING"
    });

    res.json(stk.data);
  } catch (err) {
    console.error("❌ STK ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "STK push failed" });
  }
});

/* =========================
   🔔 M-PESA CALLBACK (SAFE)
========================= */
app.post("/mpesa/callback", async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      return res.status(400).json({ message: "Invalid callback" });
    }

    const { CheckoutRequestID, CallbackMetadata } = callback;

    let meta = {};
    if (CallbackMetadata?.Item) {
      CallbackMetadata.Item.forEach(i => (meta[i.Name] = i.Value));
    }

    // interim callback
    if (!meta.MpesaReceiptNumber) {
      return res.json({ ResultCode: 0, ResultDesc: "Interim accepted" });
    }

    // dedupe
    const { data: exists } = await supabase
      .from("transactions")
      .select("id")
      .eq("checkout_request_id", CheckoutRequestID)
      .maybeSingle();

    if (exists) {
      return res.json({ ResultCode: 0, ResultDesc: "Duplicate ignored" });
    }

    const { data: stk } = await supabase
      .from("stk_requests")
      .select("merchant_id, amount")
      .eq("checkout_request_id", CheckoutRequestID)
      .single();

    if (!stk) {
      return res.status(400).json({ error: "Unknown transaction" });
    }

    await supabase.from("transactions").insert({
      merchant_id: stk.merchant_id,
      checkout_request_id: CheckoutRequestID,
      mpesa_receipt: meta.MpesaReceiptNumber,
      amount: stk.amount,
      status: "PAID"
    });

    await supabase
      .from("stk_requests")
      .update({ status: "PAID" })
      .eq("checkout_request_id", CheckoutRequestID);

    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("🔥 CALLBACK ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 KonfirmPay running on port ${PORT}`);
});
