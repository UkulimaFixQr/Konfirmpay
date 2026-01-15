const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

dotenv.config();

console.log("🔥 KONFIRMPAY INDEX.JS LOADED");

const app = express();
app.use(cors());
app.use(express.json());

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
      headers: { Authorization: `Basic ${auth}` },
    }
  );

  return response.data.access_token;
}

/* =====================================================
   STK PUSH (SAME PAYBILL, MERCHANT IDENTIFIED VIA QR)
   Money goes to Paybill — we only record entitlement
===================================================== */
app.post("/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, amount, merchant_id } = req.body;

    if (!phone || !amount || !merchant_id) {
      return res.status(400).json({ error: "phone, amount, merchant_id required" });
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

    const stkResponse = await axios.post(
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
        AccountReference: merchant_id, // 🔑 binds payment to merchant
        TransactionDesc: "KonfirmPay Payment",
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    // Save STK request for later callback matching
    await supabase.from("stk_requests").insert({
      checkout_request_id: stkResponse.data.CheckoutRequestID,
      merchant_id,
      amount,
      phone,
      status: "PENDING",
    });

    res.json(stkResponse.data);
  } catch (err) {
    console.error("❌ STK ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "STK push failed" });
  }
});

/* =====================================================
   🔔 M-PESA CALLBACK
   - Ignores interim callbacks
   - Deduplicates final callbacks
   - Credits merchant ledger (NO MONEY HELD)
===================================================== */
app.post("/mpesa/callback", async (req, res) => {
  try {
    console.log("🔔 CALLBACK RECEIVED");

    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      return res.status(400).json({ message: "Invalid callback" });
    }

    const {
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = callback;

    let meta = {};
    if (CallbackMetadata?.Item) {
      CallbackMetadata.Item.forEach(i => {
        meta[i.Name] = i.Value;
      });
    }

    // ⏳ Ignore interim callbacks (PIN entered)
    if (!meta.MpesaReceiptNumber) {
      console.log("⏳ Interim callback:", CheckoutRequestID);
      return res.json({ ResultCode: 0, ResultDesc: "Interim accepted" });
    }

    // 🔁 Deduplicate final callbacks
    const { data: alreadyProcessed } = await supabase
      .from("transactions")
      .select("id")
      .eq("checkout_request_id", CheckoutRequestID)
      .maybeSingle();

    if (alreadyProcessed) {
      console.log("⚠️ Duplicate callback ignored:", CheckoutRequestID);
      return res.json({ ResultCode: 0, ResultDesc: "Duplicate ignored" });
    }

    // 🔍 Get original STK request
    const { data: stk } = await supabase
      .from("stk_requests")
      .select("merchant_id, amount")
      .eq("checkout_request_id", CheckoutRequestID)
      .single();

    if (!stk) {
      console.error("❌ STK request not found:", CheckoutRequestID);
      return res.status(400).json({ error: "Unknown transaction" });
    }

    // ✅ Record merchant entitlement (ledger entry)
    await supabase.from("transactions").insert({
      merchant_id: stk.merchant_id,
      checkout_request_id: CheckoutRequestID,
      mpesa_receipt: meta.MpesaReceiptNumber,
      amount: stk.amount,
      status: "PAID",
    });

    // Update STK request status
    await supabase
      .from("stk_requests")
      .update({ status: "PAID" })
      .eq("checkout_request_id", CheckoutRequestID);

    console.log("✅ Merchant credited (ledger):", stk.merchant_id);

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
