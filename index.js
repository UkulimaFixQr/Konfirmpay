import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

// =====================
// SUPABASE
// =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =====================
// MPESA HELPERS
// =====================
const getAccessToken = async () => {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const res = await fetch(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: { Authorization: `Basic ${auth}` },
    }
  );

  const data = await res.json();
  return data.access_token;
};

const generatePassword = () => {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  const password = Buffer.from(
    process.env.MPESA_SHORTCODE +
      process.env.MPESA_PASSKEY +
      timestamp
  ).toString("base64");

  return { password, timestamp };
};

// =====================
// HEALTH CHECK
// =====================
app.get("/", (req, res) => {
  console.log("HEALTH CHECK HIT");
  res.json({ status: "OK" });
});

// =====================
// START VERIFICATION
// =====================
app.post("/verify/start", async (req, res) => {
  try {
    console.log("VERIFY START:", req.body);

    const { merchant_id, phone, amount } = req.body;

    if (!merchant_id || !phone || !amount) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const verification_fee = 5;
    const session_id = crypto.randomUUID();

    // Save verification session
    const { error: insertError } = await supabase
      .from("verifications")
      .insert({
        session_id,
        merchant_id,
        phone,
        amount,
        verification_fee,
        verification_status: "PENDING",
        status: "AWAITING_PAYMENT",
      });

    if (insertError) {
      console.error("SUPABASE INSERT ERROR:", insertError);
      return res.status(500).json({ error: "DB insert failed" });
    }

    // Trigger STK Push
    const token = await getAccessToken();
    const { password, timestamp } = generatePassword();

    const stkRes = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: process.env.MPESA_SHORTCODE,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: verification_fee,
          PartyA: phone,
          PartyB: process.env.MPESA_SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: process.env.MPESA_CALLBACK_URL,
          AccountReference: session_id,
          TransactionDesc: "Verification Fee",
        }),
      }
    );

    const stkData = await stkRes.json();
    console.log("STK RESPONSE:", stkData);

    await supabase
      .from("verifications")
      .update({ checkout_request_id: stkData.CheckoutRequestID })
      .eq("session_id", session_id);

    res.json({
      session_id,
      verification_fee,
      message: "Verification fee KES 5 required",
    });
  } catch (err) {
    console.error("VERIFY START ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =====================
// MPESA CALLBACK
// =====================
app.post("/mpesa/callback", async (req, res) => {
  try {
    console.log("MPESA CALLBACK:", JSON.stringify(req.body, null, 2));

    const callback =
      req.body.Body.stkCallback;

    if (callback.ResultCode !== 0) {
      console.log("PAYMENT FAILED");
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const items = callback.CallbackMetadata.Item;
    const receipt = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
    const phone = items.find(i => i.Name === "PhoneNumber")?.Value;
    const checkout = callback.CheckoutRequestID;

    await supabase
      .from("verifications")
      .update({
        mpesa_receipt: receipt,
        paid_at: new Date(),
        verification_status: "PAID",
        status: "VERIFIED",
      })
      .eq("checkout_request_id", checkout);

    console.log("VERIFICATION PAID:", checkout);

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("CALLBACK ERROR:", err);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// =====================
// CHECK STATUS
// =====================
app.get("/verify/:session_id/status", async (req, res) => {
  const { session_id } = req.params;

  const { data, error } = await supabase
    .from("verifications")
    .select("*")
    .eq("session_id", session_id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Not found" });
  }

  res.json(data);
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("SERVER RUNNING ON PORT", PORT);
});
