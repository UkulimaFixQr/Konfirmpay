import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

/* =========================
   SUPABASE
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   DARAJA (SANDBOX)
========================= */
const DARAJA_BASE = "https://sandbox.safaricom.co.ke";

/* =========================
   DARAJA TOKEN
========================= */
async function getDarajaToken() {
  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString("base64");

  const res = await fetch(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` }
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ DARAJA TOKEN ERROR:", text);
    throw new Error("Daraja token failed");
  }

  const data = await res.json();
  console.log("✅ DARAJA TOKEN OK");
  return data.access_token;
}

/* =========================
   PASSWORD + TIMESTAMP
========================= */
function darajaPassword() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  const password = Buffer.from(
    process.env.DARAJA_SHORTCODE +
      process.env.DARAJA_PASSKEY +
      timestamp
  ).toString("base64");

  return { password, timestamp };
}

/* =========================
   HEALTH
========================= */
app.get("/", (_, res) => {
  res.json({ status: "KonfirmPay sandbox running" });
});

/* =========================
   VERIFY START (STK #1)
========================= */
app.post("/verify/start", async (req, res) => {
  try {
    console.log("🔔 VERIFY START:", req.body);

    const { merchant_id, phone, amount } = req.body;
    if (!merchant_id || !phone || !amount) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const session_id = crypto.randomUUID();

    // verification fee rules
    let verification_fee = 1;
    if (amount > 1000 && amount <= 5000) verification_fee = 5;
    else if (amount > 5000 && amount <= 10000) verification_fee = 10;
    else if (amount > 10000 && amount <= 20000) verification_fee = 15;
    else if (amount > 20000 && amount <= 30000) verification_fee = 20;
    else if (amount > 30000 && amount <= 50000) verification_fee = 30;
    else if (amount > 50000) verification_fee = 50;

    await supabase.from("verifications").insert({
      session_id,
      merchant_id,
      phone,
      amount,
      verification_fee,
      verification_status: "PENDING",
      status: "AWAITING_VERIFICATION"
    });

    const token = await getDarajaToken();
    const { password, timestamp } = darajaPassword();

    console.log("📤 SENDING STK #1 (VERIFICATION)");

    const stkRes = await fetch(
      `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: process.env.DARAJA_SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: verification_fee,
          PartyA: phone,
          PartyB: process.env.DARAJA_SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: process.env.DARAJA_CALLBACK_URL,
          AccountReference: session_id,
          TransactionDesc: "KonfirmPay verification"
        })
      }
    );

    const stkData = await stkRes.json();
    console.log("📩 STK #1 RESPONSE:", stkData);

    await supabase
      .from("verifications")
      .update({ checkout_request_id: stkData.CheckoutRequestID })
      .eq("session_id", session_id);

    res.json({
      session_id,
      verification_fee,
      message: `Verification fee KES ${verification_fee} required`
    });
  } catch (err) {
    console.error("❌ VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

/* =========================
   CALLBACK (STK #1 → STK #2)
========================= */
app.post("/mpesa/callback", async (req, res) => {
  try {
    console.log("📩 CALLBACK:", JSON.stringify(req.body, null, 2));

    const stk = req.body?.Body?.stkCallback;
    if (!stk) return res.json({ ResultCode: 0 });

    const checkoutId = stk.CheckoutRequestID;

    if (stk.ResultCode !== 0) {
      console.log("❌ PAYMENT FAILED:", stk.ResultDesc);
      return res.json({ ResultCode: 0 });
    }

    const items = stk.CallbackMetadata.Item;
    const receipt =
      items.find(i => i.Name === "MpesaReceiptNumber")?.Value || null;

    // 1️⃣ Mark verification PAID
    const { data: verification } = await supabase
      .from("verifications")
      .update({
        verification_status: "PAID",
        status: "VERIFIED",
        mpesa_receipt: receipt,
        paid_at: new Date()
      })
      .eq("checkout_request_id", checkoutId)
      .select()
      .single();

    console.log("✅ VERIFICATION PAID:", receipt);

    // 2️⃣ FETCH MERCHANT
    const { data: merchant } = await supabase
      .from("merchants")
      .select("paybill")
      .eq("id", verification.merchant_id)
      .single();

    // 3️⃣ SEND STK #2 (MERCHANT PAYMENT)
    const token = await getDarajaToken();
    const { password, timestamp } = darajaPassword();

    console.log("📤 SENDING STK #2 (MERCHANT PAYMENT)");

    await fetch(
      `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: merchant.paybill,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: verification.amount,
          PartyA: verification.phone,
          PartyB: merchant.paybill,
          PhoneNumber: verification.phone,
          CallBackURL: process.env.DARAJA_CALLBACK_URL,
          AccountReference: verification.session_id,
          TransactionDesc: "Merchant payment"
        })
      }
    );

    console.log("✅ STK #2 SENT");

    res.json({ ResultCode: 0 });
  } catch (err) {
    console.error("❌ CALLBACK ERROR:", err);
    res.json({ ResultCode: 0 });
  }
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 KonfirmPay sandbox running on port ${PORT}`);
});
