const express = require("express");
const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));


/**
 * ====================================================
 * ENV CONFIG (DO NOT HARDCODE)
 * ====================================================
 */
const {
  SUPABASE_URL,
  SUPABASE_KEY,

  DARAJA_CONSUMER_KEY,
  DARAJA_CONSUMER_SECRET,
  DARAJA_SHORTCODE,        // KonfirmPay sandbox shortcode
  DARAJA_PASSKEY,
  DARAJA_CALLBACK_URL     // https://your-render-url/mpesa/callback
} = process.env;

/**
 * ====================================================
 * SIMPLE SUPABASE CLIENT (REST)
 * ====================================================
 */
async function supabase(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(t);
  }
  return res.json();
}

/**
 * ====================================================
 * DARAJA HELPERS
 * ====================================================
 */
async function getDarajaToken() {
  const auth = Buffer.from(
    `${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`
  ).toString("base64");

  const res = await fetch(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );

  const data = await res.json();
  return data.access_token;
}

function timestamp() {
  return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
}

function stkPassword(ts) {
  return Buffer.from(
    `${DARAJA_SHORTCODE}${DARAJA_PASSKEY}${ts}`
  ).toString("base64");
}

async function stkPush({ phone, amount, accountRef, description }) {
  const token = await getDarajaToken();
  const ts = timestamp();

  const payload = {
    BusinessShortCode: DARAJA_SHORTCODE,
    Password: stkPassword(ts),
    Timestamp: ts,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: phone,
    PartyB: DARAJA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: DARAJA_CALLBACK_URL,
    AccountReference: accountRef,
    TransactionDesc: description
  };

  const res = await fetch(
    "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  return res.json();
}

/**
 * ====================================================
 * HEALTH
 * ====================================================
 */
app.get("/", (_, res) => {
  res.send("KonfirmPay backend is running");
});

/**
 * ====================================================
 * ADMIN – REGISTER MERCHANT
 * ====================================================
 */
app.post("/admin/merchant", async (req, res) => {
  try {
    const merchant = await supabase("merchants", {
      method: "POST",
      body: req.body
    });
    res.json(merchant[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * ====================================================
 * ADMIN – GENERATE IMMUTABLE QR
 * ====================================================
 */
app.post("/admin/merchant/:id/generate-qr", async (req, res) => {
  try {
    const qrToken =
      "KPQR_" + crypto.randomBytes(4).toString("hex").toUpperCase();

    const qr = await supabase("merchant_qrs", {
      method: "POST",
      body: {
        merchant_id: req.params.id,
        qr_token: qrToken,
        store_name: req.body.store_name
      }
    });

    res.json({
      qr_token: qrToken,
      ussd_code: `*384*${qrToken}#`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * ====================================================
 * SIMULATED USSD → TRIGGERS STK #1
 * ====================================================
 */
app.get("/simulate-ussd", async (req, res) => {
  try {
    const { qr, text = "", phone = "254700000001" } = req.query;
    if (!qr) return res.send("END Invalid QR");

    const qrRows = await supabase(
      `merchant_qrs?qr_token=eq.${qr}&status=eq.ACTIVE`
    );
    if (!qrRows.length) return res.send("END Invalid QR");

    const merchant = (await supabase(
      `merchants?id=eq.${qrRows[0].merchant_id}`
    ))[0];

    if (text === "") {
      return res.send("CON Enter amount to pay:");
    }

    if (!text.includes("*")) {
      const amount = parseInt(text, 10);
      if (!amount) return res.send("END Invalid amount");

      const fee = amount <= 500 ? 1 : amount <= 5000 ? 3 : 5;

      const tx = await supabase("transactions", {
        method: "POST",
        body: {
          merchant_id: merchant.id,
          qr_id: qrRows[0].id,
          phone,
          amount,
          verification_fee: fee,
          status: "AWAITING_FEE"
        }
      });

      return res.send(
        `CON You will pay a KonfirmPay verification fee of KES ${fee}\n1. Continue\n2. Cancel`
      );
    }

    const [, choice] = text.split("*");
    if (choice !== "1") return res.send("END Cancelled");

    // 🔥 TRIGGER STK #1 IMMEDIATELY
    await stkPush({
      phone,
      amount: 5,
      accountRef: "KonfirmPay Verification",
      description: "KonfirmPay verification fee"
    });

    return res.send("END Enter PIN to complete verification");
  } catch (e) {
    console.error(e);
    res.send("END System error");
  }
});

/**
 * ====================================================
 * M-PESA CALLBACK
 * AUTO TRIGGERS STK #2 AFTER FEE SUCCESS
 * ====================================================
 */
app.post("/mpesa/callback", async (req, res) => {
  try {
    const result =
      req.body.Body.stkCallback;

    if (result.ResultCode !== 0) {
      return res.json({ ResultCode: 0, ResultDesc: "Rejected" });
    }

    // 👉 In sandbox we auto-trigger merchant STK
    // (In prod we match transaction IDs precisely)

    // TODO: lookup transaction → merchant → trigger STK #2

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) {
    console.error(e);
    res.json({ ResultCode: 0, ResultDesc: "Error" });
  }
});

/**
 * ====================================================
 * SERVER
 * ====================================================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("KonfirmPay running on", PORT)
);
