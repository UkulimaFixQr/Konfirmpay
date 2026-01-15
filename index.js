console.log("🔥 KONFIRMPAY INDEX.JS LOADED");

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
app.post("/mpesa/callback", (req, res) => {
  return res.json({ ok: true, message: "CALLBACK ROUTE HIT" });
});


/* =========================
   STATIC FILES (CASE-SENSITIVE)
========================= */
app.use(express.static(path.join(__dirname, "Public"))); // or "public"

/* =========================
   SUPABASE
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   HOME
========================= */
app.get("/", (req, res) => {
  res.send("KonfirmPay backend running");
});

/* =========================
   DARAJA TOKEN
========================= */
async function getAccessToken() {
  const auth = Buffer.from(
    process.env.DARAJA_CONSUMER_KEY + ":" +
    process.env.DARAJA_CONSUMER_SECRET
  ).toString("base64");

  const response = await axios.get(
    `${process.env.DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` }
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
        TransactionDesc: "KonfirmPay Payment"
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    res.json(response.data);
  } catch (e) {
    console.error("STK ERROR:", e.response?.data || e.message);
    res.status(500).json({ error: "STK failed" });
  }
});

/* =========================
   CALLBACK
========================= */
app.post("/mpesa/callback", async (req, res) => {
  try {
    console.log("CALLBACK:", JSON.stringify(req.body, null, 2));
    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) {
    console.error("CALLBACK ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`KonfirmPay running on port ${PORT}`);
});
