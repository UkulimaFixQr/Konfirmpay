import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =======================
   SUPABASE
======================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================
   HEALTH
======================= */
app.get("/", (req, res) => {
  console.log("HEALTH CHECK HIT");
  res.send("KonfirmPay backend running");
});

/* =======================
   DARAJA TOKEN
======================= */
async function getMpesaToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const r = await fetch(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: { Authorization: `Basic ${auth}` },
    }
  );

  const data = await r.json();
  return data.access_token;
}

/* =======================
   VERIFY START
======================= */
app.post("/verify/start", async (req, res) => {
  try {
    const { merchant_id, phone, amount } = req.body;

    console.log("VERIFY START:", req.body);

    if (!merchant_id || !phone || !amount) {
      return res.status(400).json({ error: "missing fields" });
    }

    const session_id = crypto.randomUUID();
    const verification_fee = 5;

    /* Save verification session */
    const { error } = await supabase.from("verifications").insert({
      session_id,
      merchant_id,
      phone,
      amount,
      verification_fee,
      verification_status: "pending",
      status: "active",
    });

    if (error) {
      console.error("DB INSERT ERROR:", error);
      return res.status(500).json({ error: "db insert failed" });
    }

    /* === SANDBOX NOTE ===
       Sandbox will NOT prompt real phones
       Use 254708374149 for simulator
    */
    const stkPhone =
      process.env.MPESA_ENV === "sandbox"
        ? "254708374149"
        : phone;

    /* STK PUSH */
    const token = await getMpesaToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      process.env.MPESA_SHORTCODE +
        process.env.MPESA_PASSKEY +
        timestamp
    ).toString("base64");

    console.log("ABOUT TO SEND STK PUSH");

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
          PartyA: stkPhone,
          PartyB: process.env.MPESA_SHORTCODE,
          PhoneNumber: stkPhone,
          CallBackURL: process.env.MPESA_CALLBACK_URL,
          AccountReference: session_id,
          TransactionDesc: "Verification fee",
        }),
      }
    );

    const stkData = await stkRes.json();
    console.log("STK RESPONSE:", stkData);

    if (stkData.CheckoutRequestID) {
      await supabase
        .from("verifications")
        .update({
          checkout_request_id: stkData.CheckoutRequestID,
        })
        .eq("session_id", session_id);
    }

    res.json({
      session_id,
      verification_fee,
      message: "Verification fee KES 5 required",
    });
  } catch (e) {
    console.error("VERIFY ERROR:", e);
    res.status(500).json({ error: "verify failed" });
  }
});

/* =======================
   MPESA CALLBACK
======================= */
app.post("/mpesa/callback", async (req, res) => {
  try {
    console.log("MPESA CALLBACK:", JSON.stringify(req.body, null, 2));

    const stk = req.body.Body?.stkCallback;
    if (!stk) return res.sendStatus(200);

    const checkoutId = stk.CheckoutRequestID;

    if (stk.ResultCode === 0) {
      const meta = stk.CallbackMetadata.Item;
      const receipt = meta.find(i => i.Name === "MpesaReceiptNumber")?.Value;

      await supabase
        .from("verifications")
        .update({
          verification_status: "paid",
          status: "completed",
          mpesa_receipt: receipt,
          paid_at: new Date(),
        })
        .eq("checkout_request_id", checkoutId);

      console.log("VERIFICATION PAID:", checkoutId);
    } else {
      await supabase
        .from("verifications")
        .update({
          verification_status: "failed",
        })
        .eq("checkout_request_id", checkoutId);

      console.log("VERIFICATION FAILED:", checkoutId);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("CALLBACK ERROR:", e);
    res.sendStatus(200);
  }
});

/* =======================
   VERIFY STATUS
======================= */
app.get("/verify/:session_id/status", async (req, res) => {
  const { session_id } = req.params;

  const { data } = await supabase
    .from("verifications")
    .select("*")
    .eq("session_id", session_id)
    .single();

  if (!data) return res.status(404).json({ error: "not found" });

  res.json(data);
});

/* =======================
   START SERVER
======================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`SERVER RUNNING ON PORT ${PORT}`)
);
