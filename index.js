const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

dotenv.config();

console.log("🔥 KONFIRMPAY INDEX LOADED");

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   STATIC FILES (CAPITAL P)
========================= */
app.use(express.static(path.join(__dirname, "Public")));

/* =========================
   SUPABASE (NO CRASH GUARDS)
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
   DARAJA ACCESS TOKEN
========================= */
async function getAccessToken() {
  const auth = Buffer.from(
    process.env.DARAJA_CONSUMER_KEY +
      ":" +
      process.env.DARAJA_CONSUMER_SECRET
  ).toString("base64");

  const response = await axios.get(
    `${process.env.DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    }
  );

  return response.data.access_token;
}

/* =========================
   STK PUSH
========================= */
app.post("/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

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
        AccountReference: "KonfirmPay",
        TransactionDesc: "KonfirmPay Payment",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log("📤 STK PUSH SENT:", response.data);
    res.json(response.data);
  } catch (err) {
    console.error("❌ STK ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "STK push failed" });
  }
});

/* =========================
   🔔 M-PESA CALLBACK
   (DUPLICATE-SAFE)
========================= */
app.post("/mpesa/callback", async (req, res) => {
  try {
    console.log("🔔 CALLBACK RECEIVED");

    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      return res.status(400).json({ message: "Invalid callback" });
    }

    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = callback;

    let meta = {};
    if (CallbackMetadata?.Item) {
      CallbackMetadata.Item.forEach((i) => {
        meta[i.Name] = i.Value;
      });
    }

    // ⏳ Ignore interim callbacks (no receipt yet)
    if (!meta.MpesaReceiptNumber) {
      console.log("⏳ Interim callback ignored:", CheckoutRequestID);
      return res.json({ ResultCode: 0, ResultDesc: "Interim accepted" });
    }

    // 🔁 Deduplicate final callbacks
    const { data: existing } = await supabase
      .from("mpesa_callbacks")
      .select("id")
      .eq("checkout_request_id", CheckoutRequestID)
      .not("mpesa_receipt", "is", null)
      .maybeSingle();

    if (existing) {
      console.log("⚠️ Duplicate callback ignored:", CheckoutRequestID);
      return res.json({ ResultCode: 0, ResultDesc: "Duplicate ignored" });
    }

    // ✅ Save final successful payment
    await supabase.from("mpesa_callbacks").insert({
      merchant_request_id: MerchantRequestID,
      checkout_request_id: CheckoutRequestID,
      result_code: ResultCode,
      result_desc: ResultDesc,
      amount: meta.Amount || null,
      mpesa_receipt: meta.MpesaReceiptNumber,
      phone: meta.PhoneNumber || null,
      transaction_date: meta.TransactionDate || null,
      raw: callback,
    });

    console.log("✅ Payment confirmed:", CheckoutRequestID);

    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("🔥 CALLBACK ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 KonfirmPay running on port ${PORT}`);
});
