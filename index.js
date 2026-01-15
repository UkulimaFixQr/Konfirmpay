import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   STATIC FILES (CASE-SAFE)
========================= */
// 🔴 CHANGE THIS TO MATCH YOUR ACTUAL FOLDER NAME
app.use(express.static(path.join(__dirname, "Public"))); // or "public"

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
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "index.html"));
});

/* =========================
   DARAJA TOKEN
========================= */
async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString("base64");

  const { data } = await axios.get(
    `${process.env.DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` },
    }
  );

  return data.access_token;
}

/* =========================
   STK PUSH
========================= */
app.post("/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, amount, accountReference } = req.body;

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
        AccountReference: accountReference || "KonfirmPay",
        TransactionDesc: "KonfirmPay Payment",
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    console.log("📤 STK PUSH:", response.data);
    res.json(response.data);
  } catch (err) {
    console.error("❌ STK ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "STK failed" });
  }
});

/* =========================
   🔔 CALLBACK
========================= */
app.post("/mpesa/callback", async (req, res) => {
  try {
    console.log("🔔 CALLBACK RECEIVED");
    console.log(JSON.stringify(req.body, null, 2));

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
      CallbackMetadata.Item.forEach(i => (meta[i.Name] = i.Value));
    }

    await supabase.from("mpesa_callbacks").insert({
      merchant_request_id: MerchantRequestID,
      checkout_request_id: CheckoutRequestID,
      result_code: ResultCode,
      result_desc: ResultDesc,
      amount: meta.Amount || null,
      mpesa_receipt: meta.MpesaReceiptNumber || null,
      phone: meta.PhoneNumber || null,
      transaction_date: meta.TransactionDate || null,
      raw: callback,
    });

    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) {
    console.error("🔥 CALLBACK ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 KonfirmPay live on port ${PORT}`);
});
