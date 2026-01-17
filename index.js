import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const PORT = process.env.PORT || 10000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DARAJA_BASE_URL = "https://sandbox.safaricom.co.ke";
const SHORTCODE = process.env.DARAJA_SHORTCODE;
const PASSKEY = process.env.DARAJA_PASSKEY;
const CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET;
const CALLBACK_URL = "https://konfirmpay.onrender.com/mpesa/callback";

// ================== HELPERS ==================
function getTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
}

async function getAccessToken() {
  const auth = Buffer.from(
    `${CONSUMER_KEY}:${CONSUMER_SECRET}`
  ).toString("base64");

  const res = await axios.get(
    `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  return res.data.access_token;
}

// ================== ROUTES ==================

// 🔹 START VERIFICATION (POSTMAN)
app.post("/verify/start", async (req, res) => {
  try {
    const { merchant_id, phone, amount } = req.body;

    if (!merchant_id || !phone || !amount) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const verificationId = crypto.randomUUID();

    // Insert verification row FIRST
    const { error: insertError } = await supabase
      .from("verifications")
      .insert({
        id: verificationId,
        merchant_id,
        phone,
        amount,
        verification_fee: 5,
        status: "PENDING"
      });

    if (insertError) {
      console.error("INSERT FAILED:", insertError);
      return res.status(500).json({ error: "DB insert failed" });
    }

    const token = await getAccessToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(
      SHORTCODE + PASSKEY + timestamp
    ).toString("base64");

    const stkRes = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: 5,
        PartyA: phone,
        PartyB: SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: CALLBACK_URL,
        AccountReference: verificationId,
        TransactionDesc: "Verification Fee"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Save CheckoutRequestID
    await supabase
      .from("verifications")
      .update({ checkout_request_id: stkRes.data.CheckoutRequestID })
      .eq("id", verificationId);

    res.json({
      session_id: verificationId,
      verification_fee: 5,
      message: "Verification fee KES 5 required"
    });
  } catch (err) {
    console.error("VERIFY START ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Verification start failed" });
  }
});

// 🔹 M-PESA CALLBACK
app.post("/mpesa/callback", async (req, res) => {
  try {
    const stk = req.body.Body.stkCallback;
    const checkoutId = stk.CheckoutRequestID;

    if (stk.ResultCode !== 0) {
      return res.json({ ok: true });
    }

    const meta = stk.CallbackMetadata.Item;
    const receipt = meta.find(i => i.Name === "MpesaReceiptNumber")?.Value;

    // ✅ UPDATE USING checkout_request_id (NOT UUID)
    const { error } = await supabase
      .from("verifications")
      .update({
        status: "PAID",
        mpesa_receipt: receipt
      })
      .eq("checkout_request_id", checkoutId);

    if (error) {
      console.error("CALLBACK UPDATE FAILED:", error);
    } else {
      console.log("VERIFICATION PAID:", receipt);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("CALLBACK ERROR:", err.message);
    res.json({ ok: true });
  }
});

// 🔹 CHECK STATUS (POSTMAN / FRONTEND)
app.get("/verify/:id/status", async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("verifications")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Not found" });
  }

  if (data.status !== "PAID") {
    return res.status(403).json({ error: "verification required" });
  }

  res.json({
    merchant: {
      id: data.merchant_id,
      phone: data.phone,
      amount: data.amount
    }
  });
});

// ================== SERVER ==================
app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
