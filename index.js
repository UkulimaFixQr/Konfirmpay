const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/ussd", (req, res) => {
  res.set("Content-Type", "text/plain");

  // Africa's Talking sends data as form-urlencoded
  const text = req.body.text || "";

  if (text === "") {
    return res.send("CON Enter amount to pay:");
  }

  return res.send(`END You entered amount: KES ${text}`);
});

app.get("/", (req, res) => {
  res.send("KonfirmPay backend is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
