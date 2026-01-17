/*************************************************
 * KONFIRMPAY — FINAL VERIFIED BACKEND
 *************************************************/

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

/* ===========================
   BOOT LOG
=========================== */
console.log("🔥 KonfirmPay backend starting");

/* ===========================
   STATIC FILES (CAPITAL P)
=========================== */
app.use(express.static(path.join(__dirname, "Public")));

/* ===========================
   SUPABASE
=========================== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ===========================
   HEALTH
=========================== */
app.get("/", (_, res) => {
  res.send("KonfirmPay backend running");
});

/* ===========================
   HELPERS
=========================== */
function verificationFee(amount) {
  if (amount <= 1000) return 1;
  if (amount <= 5000) return 5;
  if (amount <= 10000) return 10;
  if (amount <= 20000) return 15;
  if (amount <= 30000) return 20;
  if (amount <= 50000) return 30;
  return 50;
}

async function darajaToken() {
  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString("base64");

  const res = await axios.get(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );

  return res.data.access_token;
}

/* ===========================
   VERIFY START (STK #1)
=========================== */
app.post("/verify/start", async (req, res) => {
  try {
    console.log("➡️ /verify/start", req.body);

    const { merchant_id, phone, amount } = req.body;
    if (!merchant_id || !phone || !amount) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // THIS UUID IS THE SESSION ID
    const verificationId = crypto.randomUUID();
    const fee = verificationFee(amount);

    const { error } = await supabase
      .from("verifications")
      .insert([{
        id: verificationId,
        merchant_id,
        phone,
        amount,
        verification_fee: fee,
        status: "PENDING"
      }]);

    if (error) {
      console.error("❌ VERIFICATION INSERT FAILED:", error);
      return res.status(500).json({ error: "DB insert failed" });
    }

    console.log("✅ VERIFICATION CREATED:", verificationId);

    // STK PUSH — VERIFICATION FEE
    const token = await darajaToken();
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      process.env.DARAJA_SHORTCODE +
      process.env.DARAJA_PASSKEY +
      timestamp
    ).toString("base64");

    await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: process.env.DARAJA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: fee,
        PartyA: phone,
        PartyB: process.env.DARAJA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: process.env.DARAJA_CALLBACK_URL,
        AccountReference: verificationId,
        TransactionDesc: "KonfirmPay Verification Fee"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({
      session_id: verificationId,
      verification_fee: fee,
      message: `Verification fee KES ${fee} required`
    });

  } catch (err) {
    console.error("❌ /verify/start ERROR", err.response?.data || err);
    res.status(500).json({ error: "Verification start failed" });
  }
});

/* ===========================
   CHECK STATUS
=========================== */
app.get("/verify/:id/status", async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("verifications")
    .select("status, merchant_id, amount")
    .eq("id", id)
    .single();

  if (error || !data || data.status !== "PAID") {
    return res.status(403).json({ error: "verification required" });
  }

  const { data: merchant } = await supabase
    .from("merchants")
    .select("name, paybill")
    .eq("id", data.merchant_id)
    .single();

  res.json({
    merchant,
    amount: data.amount
  });
});

/* ===========================
   M-PESA CALLBACK
=========================== */
app.post("/mpesa/callback", async (req, res) => {
  console.log("📥 CALLBACK RECEIVED");
  console.log(JSON.stringify(req.body, null, 2));

  const stk = req.body?.Body?.stkCallback;
  if (!stk) return res.json({ ResultCode: 0 });

  if (stk.ResultCode !== 0) return res.json({ ResultCode: 0 });

  const receipt = stk.CallbackMetadata.Item
    .find(i => i.Name === "MpesaReceiptNumber")?.Value;

  // 🔑 THIS MUST MATCH verifications.id
  const verificationId = stk.CheckoutRequestID;

  const { error } = await supabase
    .from("verifications")
    .update({
      status: "PAID",
      mpesa_receipt: receipt
    })
    .eq("id", verificationId);

  if (error) {
    console.error("❌ CALLBACK UPDATE FAILED:", error);
  } else {
    console.log("✅ VERIFICATION MARKED PAID:", verificationId);
  }

  res.json({ ResultCode: 0 });
});

/* ===========================
   START SERVER (RENDER)
=========================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
