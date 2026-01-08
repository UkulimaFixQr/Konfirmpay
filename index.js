const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("KonfirmPay backend is running");
});

app.post("/ussd", (req, res) => {
  console.log("USSD REQUEST:", req.body);

  res.set("Content-Type", "text/plain");
  res.send("END KonfirmPay USSD is connected");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
