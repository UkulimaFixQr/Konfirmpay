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

/* ============================
   STATIC FILES (CAPITAL P)
============================ */
app.use(express.static(path.join(__dirname, "Public")));

/* ============================
   SUPABASE
============================ */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("✅ Supabase connected:", !!process.env.SUPABASE_URL);

/* ============================
   HELPERS
============================ */
function verificationFee(amount) {
  if (amount <= 1000) return 1;
  if (amount <= 5000) return 5;
  if (amount <= 10000) return 10;
  if (amount <= 20000) return 15;
  if (amount <= 30000) return 20;
  if (amount <= 50000) return 30;
  return 50;
}

async function mpesaToken() {
  const auth = Buffer.from(
    process.env.DARAJA_CONSUMER_KEY + ":" + process.env.DARAJA_CONSUMER_SECRET
  ).toString("base64");

  const res = await axios.get(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );

  return res.data.access_token;
}

/* ============================
   HEALTH
============================ */
app.get("/", (_, res) => {
  res.send("KonfirmPay backend running");
});

/* ============================
   ADMIN AUTH
============================ */
app.post("/admin/verify-pin", (req, res) => {
  if (req.body.pin === process.env.ADMIN_PIN) return res.sendStatus(200);
  res.sendStatus(401);
});

/* ============================
   MERCHANTS
============================ */
app.post("/admin/merchant", async (req, res) => {
  const { data, error } = await supabase.from("merchants").insert(req.body).select();
  if (error) return res.status(500).json(error);
  res.json(data[0]);
});

app.get("/admin/merchants", async (_, res) => {
  const { data } = await supabase.from("merchants").select("*");
  res.json(data);
});

app.post("/admin/merchant/:id/generate-qr", async (req, res) => {
  const payload = Buffer.from(
    JSON.stringify({
      merchant_id: req.params.id,
      store_name: req.body.store_name
    })
  ).toString("base64");

  res.json({ qr_payload: payload });
});

/* ============================
   VERIFY START (FIRST PROMPT)
============================ */
app.post("/verify/start", async (req, res) => {
  console.log("🔔 VERIFY START:", req.body);

  const { merchant_id, phone, amount } = req.body;
  const fee = verificationFee(amount);
  const session_id = crypto.randomUUID();

  // 🔑 THIS WAS MISSING BEFORE — INSERT FIRST
  const { error } = await supabase.from("verifications").insert([{
    id: session_id,
    merchant_id,
    phone,
    amount,
    verification_fee: fee,
    status: "PENDING"
  }]);

  if (error) {
    console.error("❌ INSERT FAILED:", error);
    return res.status(500).json({ error: "DB insert failed" });
  }

  console.log("✅ Verification row created:", session_id);

  // STK PUSH FOR VERIFICATION FEE
  try {
    const token = await mpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const password = Buffer.from(
      process.env.DARAJA_SHORTCODE + process.env.DARAJA_PASSKEY + timestamp
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
        AccountReference: session_id,
        TransactionDesc: "KonfirmPay verification fee"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    console.error("❌ STK ERROR:", e.response?.data || e.message);
  }

  res.json({
    session_id,
    verification_fee: fee,
    message: `Verification fee KES ${fee} required`
  });
});

/* ============================
   VERIFY STATUS
============================ */
app.get("/verify/:id/status", async (req, res) => {
  const { data } = await supabase
    .from("verifications")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (!data || data.status !== "PAID") {
    return res.status(403).json({ error: "verification required" });
  }

  const { data: merchant } = await supabase
    .from("merchants")
    .select("name,paybill")
    .eq("id", data.merchant_id)
    .single();

  res.json({ merchant });
});

/* ============================
   MPESA CALLBACK
============================ */
app.post("/mpesa/callback", async (req, res) => {
  console.log("🔔 CALLBACK RECEIVED");

  const stk = req.body?.Body?.stkCallback;
  if (!stk || stk.ResultCode !== 0) return res.json({ ok: true });

  const meta = stk.CallbackMetadata.Item;
  const receipt = meta.find(i => i.Name === "MpesaReceiptNumber")?.Value;
  const account = stk.CheckoutRequestID;

  await supabase
    .from("verifications")
    .update({ status: "PAID", mpesa_receipt: receipt })
    .eq("id", stk.MerchantRequestID);

  console.log("✅ VERIFICATION PAID:", receipt);
  res.json({ ok: true });
});

/* ============================
   START
============================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 SERVER RUNNING ON PORT ${PORT}`);
});
