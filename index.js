const express = require("express");
const path = require("path");

const app = express();

/**
 * ====================================================
 * BASIC LOGGING (VERY IMPORTANT FOR RENDER)
 * ====================================================
 */
console.log("🚀 KonfirmPay server starting...");

/**
 * ====================================================
 * MIDDLEWARE (ORDER MATTERS)
 * ====================================================
 */
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/**
 * ====================================================
 * SERVE STATIC FILES (ADMIN DASHBOARD)
 * ====================================================
 */
app.use(express.static(path.join(__dirname, "public")));
console.log("📁 Serving static files from /public");

/**
 * ====================================================
 * HEALTH CHECK
 * ====================================================
 */
app.get("/", (req, res) => {
  console.log("✅ Health check hit");
  res.send("KonfirmPay backend is running");
});

/**
 * ====================================================
 * ADMIN – REGISTER MERCHANT (DEBUG LOGS)
 * ====================================================
 */
app.post("/admin/merchant", (req, res) => {
  console.log("🧑‍💼 Register merchant request:", req.body);

  // TEMP RESPONSE (just to prove route works)
  res.json({
    status: "OK",
    message: "Merchant endpoint reached",
    data: req.body
  });
});

/**
 * ====================================================
 * ADMIN – GENERATE QR (DEBUG LOGS)
 * ====================================================
 */
app.post("/admin/merchant/:id/generate-qr", (req, res) => {
  console.log("📦 Generate QR for merchant:", req.params.id);
  console.log("📄 Store name:", req.body.store_name);

  res.json({
    qr_token: "KPQR_TEST123",
    ussd_code: "*384*KPQR_TEST123#"
  });
});

/**
 * ====================================================
 * SIMULATED USSD (DEBUG)
 * ====================================================
 */
app.get("/simulate-ussd", (req, res) => {
  console.log("📲 USSD simulation:", req.query);

  const { text = "" } = req.query;

  if (text === "") {
    return res.send("CON Enter amount to pay:");
  }

  if (!text.includes("*")) {
    return res.send(
      "CON You will pay a KonfirmPay verification fee of KES 5\n1. Continue\n2. Cancel"
    );
  }

  const [, choice] = text.split("*");

  if (choice === "1") {
    return res.send("END Proceeding to payment...");
  }

  return res.send("END Cancelled");
});

/**
 * ====================================================
 * GLOBAL ERROR HANDLER (IMPORTANT)
 * ====================================================
 */
app.use((err, req, res, next) => {
  console.error("🔥 UNHANDLED ERROR:", err);
  res.status(500).send("Internal Server Error");
});

/**
 * ====================================================
 * START SERVER
 * ====================================================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🟢 KonfirmPay running on port ${PORT}`);
});
