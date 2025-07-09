import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import processPullRequest from "./githubService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  console.log(`Received event: ${event}`);

  try {
    if (event === "pull_request" && req.body.action === "opened") {
      const { pull_request, repository } = req.body;
      await processPullRequest(pull_request, repository);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Webhook listening on port ${PORT}`);
});
