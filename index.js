const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * ----------------------------------------------------
 * BASIC HEALTH CHECK
 * ----------------------------------------------------
 */
app.get("/", (req, res) => {
  res.send("KonfirmPay backend is running");
});

/**
 * ----------------------------------------------------
 * USSD ENDPOINT (kept for future Africa's Talking use)
 * ----------------------------------------------------
 */
app.get("/ussd", (req, res) => {
  res.set("Content-Type", "text/plain");
  res.send("END KonfirmPay USSD endpoint is live");
});

app.post("/ussd", (req, res) => {
  res.set("Content-Type", "text/plain");

  const text = req.body.text || "";

  if (text === "") {
    return res.send("CON Enter amount to pay:");
  }

  return res.send(`END You entered amount: KES ${text}`);
});

/**
 * ----------------------------------------------------
 * SIMULATED USSD FLOW (USED FOR NOW)
 * This replaces Africa's Talking sandbox during development
 * ----------------------------------------------------
 */
app.get("/simulate-ussd", (req, res) => {
  const text = req.query.text || "";

  /**
   * STEP 1: Ask for amount
   */
  if (text === "") {
    return res.send("CON Enter amount to pay:");
  }

  /**
   * STEP 2: Amount entered (no * yet)
   */
  if (!text.includes("*")) {
    const amount = parseInt(text, 10);

    if (isNaN(amount) || amount <= 0) {
      return res.send("END Invalid amount entered");
    }

    // Verification fee calculation (LOCKED RULE)
    let fee = 0;
    if (amount <= 500) fee = 1;
    else if (amount <= 5000) fee = 3;
    else fee = 5;

    return res.send(
      `CON You will pay a KonfirmPay verification fee of KES ${fee}\n1. Continue\n2. Cancel`
    );
  }

  /**
   * STEP 3: User selects option (amount*choice)
   */
  const [amountText, choice] = text.split("*");
  const amount = parseInt(amountText, 10);

  if (choice === "1") {
    return res.send(
      "END Proceeding to KonfirmPay verification payment..."
    );
  }

  return res.send("END Transaction cancelled");
});

/**
 * ----------------------------------------------------
 * SERVER START
 * ----------------------------------------------------
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("KonfirmPay server running on port", PORT);
});
