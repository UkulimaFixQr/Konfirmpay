const express = require("express");
const crypto = require("crypto");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * ----------------------------------------------------
 * CONFIG (TEMP – replace with env vars later)
 * ----------------------------------------------------
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

/**
 * Minimal Supabase client (no SDK, simple fetch)
 */
async function supabase(query, params = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method: params.method || "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }

  return res.json();
}

/**
 * ----------------------------------------------------
 * HEALTH CHECK
 * ----------------------------------------------------
 */
app.get("/", (req, res) => {
  res.send("KonfirmPay backend is running");
});

/**
 * ----------------------------------------------------
 * ADMIN – REGISTER MERCHANT
 * (simple endpoint for now)
 * ----------------------------------------------------
 */
app.post("/admin/merchant", async (req, res) => {
  const { name, paybill, account, is_chain } = req.body;

  const merchant = await supabase("merchants", {
    method: "POST",
    body: { name, paybill, account, is_chain },
  });

  res.json(merchant[0]);
});

/**
 * ----------------------------------------------------
 * ADMIN – GENERATE IMMUTABLE QR
 * ----------------------------------------------------
 */
app.post("/admin/merchant/:id/generate-qr", async (req, res) => {
  const merchantId = req.params.id;
  const { store_name } = req.body;

  const qrToken = "KPQR_" + crypto.randomBytes(4).toString("hex").toUpperCase();

  const qr = await supabase("merchant_qrs", {
    method: "POST",
    body: {
      merchant_id: merchantId,
      qr_token: qrToken,
      store_name,
    },
  });

  res.json({
    qr_token: qrToken,
    ussd_code: `*384*${qrToken}#`,
  });
});

/**
 * ----------------------------------------------------
 * SIMULATED USSD FLOW (CORE BUSINESS LOGIC)
 * Format:
 * 1st call: /simulate-ussd?qr=TOKEN
 * 2nd call: /simulate-ussd?qr=TOKEN&text=20000
 * 3rd call: /simulate-ussd?qr=TOKEN&text=20000*1
 * ----------------------------------------------------
 */
app.get("/simulate-ussd", async (req, res) => {
  const { qr, text = "", phone = "+254700000001" } = req.query;

  if (!qr) {
    return res.send("END Invalid QR");
  }

  // Resolve QR
  const qrRows = await supabase(
    `merchant_qrs?qr_token=eq.${qr}&status=eq.ACTIVE`
  );

  if (qrRows.length === 0) {
    return res.send("END Invalid or disabled QR");
  }

  const qrRow = qrRows[0];

  const merchants = await supabase(
    `merchants?id=eq.${qrRow.merchant_id}`
  );

  const merchant = merchants[0];

  /**
   * STEP 1: Ask for amount
   */
  if (text === "") {
    return res.send("CON Enter amount to pay:");
  }

  /**
   * STEP 2: Amount entered
   */
  if (!text.includes("*")) {
    const amount = parseInt(text, 10);
    if (isNaN(amount) || amount <= 0) {
      return res.send("END Invalid amount");
    }

    let fee = amount <= 500 ? 1 : amount <= 5000 ? 3 : 5;

    // Log transaction
    await supabase("transactions", {
      method: "POST",
      body: {
        merchant_id: merchant.id,
        qr_id: qrRow.id,
        phone,
        amount,
        verification_fee: fee,
        status: "FEE_SHOWN",
      },
    });

    return res.send(
      `CON You will pay a KonfirmPay verification fee of KES ${fee}\n1. Continue\n2. Cancel`
    );
  }

  /**
   * STEP 3: Confirmation
   */
  const [amountText, choice] = text.split("*");

  if (choice === "1") {
    return res.send(
      `END Proceeding to verification.\nMerchant: ${merchant.name}`
    );
  }

  return res.send("END Transaction cancelled");
});

/**
 * ----------------------------------------------------
 * SERVER
 * ----------------------------------------------------
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("KonfirmPay server running on port", PORT);
});
