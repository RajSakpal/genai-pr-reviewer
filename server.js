import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { processCodeCommitPullRequest } from "./codecommit/codecommitService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("📩 Received CodeCommit webhook event");
  console.log("📄 Payload:", JSON.stringify(body, null, 2));

  const detail = body.detail;
  const eventType = detail.event;
  const repositoryName = detail.repositoryNames[0];

  if (eventType === "pullRequestCreated") {
    try {
      await processCodeCommitPullRequest({
        repositoryName,
        pullRequestId: detail.pullRequestId,
        sourceCommit: detail.sourceCommit,
        destinationCommit: detail.destinationCommit,
        sourceBranch: detail.sourceReference,
        destinationBranch: detail.destinationReference,
      });
      res.sendStatus(200);
    } catch (err) {
      console.error("❌ Error processing CodeCommit PR:", err.message);
      res.status(500).send("Internal Server Error");
    }
  } else {
    res.sendStatus(204); // No action needed
  }
});

app.listen(PORT, () => {
  console.log(`🚀 CodeCommit webhook server running on http://localhost:${PORT}`);
});
