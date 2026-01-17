require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ======================
// GLOBAL REQUEST LOGGER (FIXES LOG ISSUE)
// ======================
app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );
  next();
});

console.log("🔥 KONFIRMPAY BACKEND STARTING");

// ======================
// SUPABASE
// ======================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("✅ Supabase connected");

// ======================
// HEALTH
// ======================
app.get("/", (req, res) => {
  console.log("✅ HEALTH CHECK HIT");
  res.send("KonfirmPay backend running");
});

// ======================
// VERIFICATION FEE LOGIC
// ======================
function calculateVerificationFee(amount) {
  if (amount <= 1000) return 1;
  if (amount <= 5000) return 5;
  if (amount <= 10000) return 10;
  if (amount <= 20000) return 15;
  if (amount <= 30000) return 20;
  if (amount <= 50000) return 30;
  return 50;
}

// ======================
// VERIFY START
// ======================
app.post("/verify/start", async (req, res) => {
  try {
    const { merchant_id, phone, amount } = req.body;

    console.log("🔔 VERIFY START:", req.body);

    const verificationFee = calculateVerificationFee(amount);

    const { data, error } = await supabase
      .from("verifications")
      .insert({
        merchant_id,
        phone,
        amount,
        verification_fee: verificationFee,
        verification_status: "PENDING"
      })
      .select()
      .single();

    if (error) throw error;

    console.log("✅ Verification session created:", data.id);

    // 🔔 Here is where STK push for VERIFICATION FEE would go

    res.json({
      session_id: data.id,
      verification_fee: verificationFee,
      message: `Verification fee KES ${verificationFee} required`
    });
  } catch (err) {
    console.error("❌ VERIFY START ERROR:", err);
    res.status(500).json({ error: "Failed to start verification" });
  }
});

// ======================
// VERIFY STATUS
// ======================
app.get("/verify/:sessionId/status", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { data, error } = await supabase
      .from("verifications")
      .select("*")
      .eq("id", sessionId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (data.verification_status !== "PAID") {
      return res.status(403).json({ error: "verification required" });
    }

    res.json({
      merchant: {
        name: "Wanjiru groceries",
        paybill: "123456"
      }
    });
  } catch (err) {
    console.error("❌ STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

// ======================
// AUTO MERCHANT PAYMENT
// ======================
async function autoPayMerchant(verification) {
  console.log("💰 AUTO PAY MERCHANT START");

  console.log("➡️ Merchant ID:", verification.merchant_id);
  console.log("➡️ Amount:", verification.amount);
  console.log("➡️ Phone:", verification.phone);

  // 🔔 REAL merchant STK push would go here

  console.log("✅ MERCHANT PAYMENT TRIGGERED");
}

// ======================
// M-PESA CALLBACK
// ======================
app.post("/mpesa/callback", async (req, res) => {
  try {
    console.log("📩 CALLBACK RECEIVED");
    console.log(JSON.stringify(req.body, null, 2));

    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      console.log("⚠️ Invalid callback format");
      return res.json({ ok: true });
    }

    if (callback.ResultCode !== 0) {
      console.log("❌ PAYMENT FAILED:", callback.ResultDesc);
      return res.json({ ok: true });
    }

    const items = callback.CallbackMetadata.Item;
    const receipt =
      items.find(i => i.Name === "MpesaReceiptNumber")?.Value || null;
    const checkoutId = callback.CheckoutRequestID;

    console.log("✅ VERIFICATION PAID:", receipt);

    const { data, error } = await supabase
      .from("verifications")
      .update({
        verification_status: "PAID",
        mpesa_receipt: receipt,
        checkout_request_id: checkoutId
      })
      .eq("checkout_request_id", checkoutId)
      .select()
      .single();

    if (error) throw error;

    // 🔥 AUTO PAY MERCHANT HERE 🔥
    await autoPayMerchant(data);

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ CALLBACK ERROR:", err);
    res.json({ ok: true });
  }
});

// ======================
// SERVER
// ======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 SERVER RUNNING ON PORT ${PORT}`);
});
