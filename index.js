const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("KonfirmPay backend is running");
});

app.post("/ussd", (req, res) => {
  const { text } = req.body;

  res.set("Content-Type", "text/plain");

  if (!text || text === "") {
    res.send("CON Enter amount to pay:");
  } else {
    res.send(`END You entered amount: KES ${text}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
