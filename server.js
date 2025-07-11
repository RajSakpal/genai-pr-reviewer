import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { processPullRequest } from "./github/githubService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  console.log(`📦 Received GitHub event: ${event}`);

  if (event === "pull_request" && req.body.action === "opened") {
    const { pull_request, repository } = req.body;

    try {
      await processPullRequest(pull_request, repository);
      res.sendStatus(200);
    } catch (error) {
      console.error("❌ Failed to process PR:", error.message);
      res.status(500).send("Internal Server Error");
    }
  } else {
    res.sendStatus(204); // No action needed
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on http://localhost:${PORT}`);
});
