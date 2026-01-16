const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

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
   HEALTH
========================= */
app.get("/", (_, res) => {
  res.send("KonfirmPay backend running");
});

/* =========================
   ADMIN PIN
========================= */
app.post("/admin/verify-pin", (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: "PIN required" });

  if (pin.trim() === process.env.ADMIN_PIN?.trim()) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Invalid PIN" });
});

/* =========================
   ADMIN MERCHANTS
========================= */
app.get("/admin/merchants", async (_, res) => {
  const { data } = await supabase
    .from("merchants")
    .select("*")
    .order("created_at", { ascending: false });
  res.json(data || []);
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
   VERIFICATION FEE LOGIC
========================= */
function calculateVerificationFee(amount) {
  const amt = Number(amount);
  if (amt >= 5 && amt <= 1000) return 1;
  if (amt <= 5000) return 5;
  if (amt <= 10000) return 10;
  if (amt <= 20000) return 15;
  if (amt <= 30000) return 20;
  if (amt <= 50000) return 30;
  return 50;
}

/* =========================
   DARAJA TOKEN
========================= */
async function getAccessToken() {
  const auth = Buffer.from(
    process.env.DARAJA_CONSUMER_KEY + ":" + process.env.DARAJA_CONSUMER_SECRET
  ).toString("base64");

  const res = await axios.get(
    `${process.env.DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

/* =========================
   START VERIFICATION (STK #1)
========================= */
app.post("/verify/start", async (req, res) => {
  const { merchant_id, phone, amount } = req.body;
  if (!merchant_id || !phone || !amount) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const session_id = crypto.randomUUID();
  const verificationFee = calculateVerificationFee(amount);

  await supabase.from("verifications").insert({
    session_id,
    merchant_id,
    phone,
    intended_amount: amount,
    verification_fee: verificationFee
  });

  await axios.post("https://konfirmpay.onrender.com/mpesa/stkpush", {
    phone,
    amount: verificationFee,
    merchant_id: "KONFIRMPAY_VERIFY",
    account_reference: `VERIFY_${session_id}`,
    type: "VERIFICATION"
  });

  res.json({
    session_id,
    verification_fee: verificationFee,
    message: `Verification fee KES ${verificationFee} required`
  });
});

/* =========================
   REVEAL MERCHANT
========================= */
app.get("/verify/:session/status", async (req, res) => {
  const { session } = req.params;

  const { data: v } = await supabase
    .from("verifications")
    .select("status, merchant_id, intended_amount")
    .eq("session_id", session)
    .single();

  if (!v || v.status !== "PAID") {
    return res.status(403).json({ error: "Verification required" });
  }

  const { data: m } = await supabase
    .from("merchants")
    .select("name")
    .eq("id", v.merchant_id)
    .single();

  res.json({ merchant_name: m.name, amount: v.intended_amount });
});

/* =========================
   PAY MERCHANT (STK #2)
========================= */
app.post("/verify/:session/pay", async (req, res) => {
  const { session } = req.params;
  const { phone } = req.body;

  const { data: v } = await supabase
    .from("verifications")
    .select("status, merchant_id, intended_amount")
    .eq("session_id", session)
    .single();

  if (!v || v.status !== "PAID") {
    return res.status(403).json({ error: "Verification not complete" });
  }

  await axios.post("https://konfirmpay.onrender.com/mpesa/stkpush", {
    phone,
    amount: v.intended_amount,
    merchant_id: v.merchant_id,
    type: "PAYMENT"
  });

  res.json({ message: "Payment request sent" });
});

/* =========================
   STK PUSH
========================= */
app.post("/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, amount, merchant_id, account_reference, type } = req.body;

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const password = Buffer.from(
      process.env.DARAJA_SHORTCODE +
      process.env.DARAJA_PASSKEY +
      timestamp
    ).toString("base64");

    const token = await getAccessToken();

    const response = await axios.post(
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
        AccountReference: account_reference || merchant_id,
        TransactionDesc: type || "KonfirmPay"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    await supabase.from("stk_requests").insert({
      checkout_request_id: response.data.CheckoutRequestID,
      merchant_id,
      amount,
      phone,
      type,
      status: "PENDING"
    });

    res.json(response.data);
  } catch (e) {
    console.error("❌ STK ERROR", e.response?.data || e.message);
    res.status(500).json({ error: "STK push failed" });
  }
});

/* =========================
   CALLBACK
========================= */
app.post("/mpesa/callback", async (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (!cb) return res.json({});

  const meta = {};
  cb.CallbackMetadata?.Item?.forEach(i => (meta[i.Name] = i.Value));

  const receipt = meta.MpesaReceiptNumber;
  const ref = cb.AccountReference;

  // VERIFICATION
  if (ref?.startsWith("VERIFY_") && receipt) {
    const session = ref.replace("VERIFY_", "");
    await supabase
      .from("verifications")
      .update({ status: "PAID", mpesa_receipt: receipt })
      .eq("session_id", session);
    return res.json({ ResultCode: 0 });
  }

  // MERCHANT PAYMENT
  if (receipt) {
    const { data: exists } = await supabase
      .from("transactions")
      .select("id")
      .eq("mpesa_receipt", receipt)
      .maybeSingle();

    if (!exists) {
      const { data: stk } = await supabase
        .from("stk_requests")
        .select("merchant_id, amount")
        .eq("checkout_request_id", cb.CheckoutRequestID)
        .single();

      if (stk) {
        await supabase.from("transactions").insert({
          merchant_id: stk.merchant_id,
          amount: stk.amount,
          mpesa_receipt: receipt,
          status: "PAID"
        });
      }
    }
  }

  res.json({ ResultCode: 0 });
});

/* =========================
   ADMIN REVENUE APIs
========================= */
app.get("/admin/revenue/summary", async (_, res) => {
  const { data } = await supabase
    .from("verifications")
    .select("verification_fee, created_at")
    .eq("status", "PAID");

  let total = 0;
  let today = 0;
  const todayDate = new Date().toISOString().slice(0, 10);

  data.forEach(v => {
    total += Number(v.verification_fee);
    if (v.created_at.startsWith(todayDate)) {
      today += Number(v.verification_fee);
    }
  });

  res.json({
    total_revenue: total,
    today_revenue: today,
    paid_verifications: data.length
  });
});

app.get("/admin/revenue/logs", async (_, res) => {
  const { data } = await supabase
    .from("verifications")
    .select("phone, intended_amount, verification_fee, status, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  res.json(data || []);
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 KonfirmPay running on port ${PORT}`);
});
