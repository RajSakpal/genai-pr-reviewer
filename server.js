import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { processCodeCommitPullRequest } from "./codecommit/codecommitService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("📩 Received AWS CodeCommit EventBridge event");
    console.log("📄 Complete Payload:", JSON.stringify(event, null, 2));

    // Extract details from the EventBridge structure
    const eventType = event.detail?.event;
    const repositoryName = event.detail?.repositoryNames?.[0];
    
    if (!eventType) {
      console.error("❌ Missing event type in payload");
      return res.status(400).send("Bad Request: Missing event type");
    }

    if (eventType === "pullRequestCreated") {
      await processCodeCommitPullRequest({
        repositoryName,
        pullRequestId: event.detail?.pullRequestId,
        sourceCommit: event.detail?.sourceCommit,
        destinationCommit: event.detail?.destinationCommit,
        sourceBranch: event.detail?.sourceReference?.replace('refs/heads/', ''),
        destinationBranch: event.detail?.destinationReference?.replace('refs/heads/', ''),
        // Include additional context if needed
        eventTime: event.time,
        region: event.region,
        rawEvent: event // Optional: include full event for debugging
      });
      return res.sendStatus(200);
    } else {
      console.log(`ℹ️ No action needed for event type: ${eventType}`);
      return res.sendStatus(204);
    }
  } catch (err) {
    console.error("❌ Error processing webhook:", err);
    return res.status(500).json({
      error: "Internal Server Error",
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on http://localhost:${PORT}`);
});