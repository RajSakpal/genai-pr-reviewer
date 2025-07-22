import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { processCodeCommitPullRequest } from "./codecommit/codecommitService.js";

dotenv.config();

/**
 * Express.js server to handle AWS EventBridge webhooks from CodeCommit
 * Listens for pull request events and triggers AI-based code analysis
 */
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON payloads from EventBridge
app.use(bodyParser.json());

/**
 * Main webhook endpoint for receiving AWS EventBridge events from CodeCommit
 * 
 * Expected event structure from AWS EventBridge:
 * {
 *   "detail": {
 *     "event": "pullRequestCreated",
 *     "repositoryNames": ["repo-name"],
 *     "pullRequestId": "123",
 *     "sourceCommit": "abc123...",
 *     "destinationCommit": "def456...",
 *     "sourceReference": "refs/heads/feature-branch",
 *     "destinationReference": "refs/heads/main"
 *   },
 *   "time": "2024-01-01T12:00:00Z",
 *   "region": "us-east-1"
 * }
 */
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("📩 Received AWS CodeCommit EventBridge event");
    console.log("📄 Complete Payload:", JSON.stringify(event, null, 2));

    // Extract event details from the EventBridge structure
    const eventType = event.detail?.event;
    const repositoryName = event.detail?.repositoryNames?.[0];
    
    // Validate that we have the minimum required data
    if (!eventType) {
      console.error("❌ Missing event type in payload");
      return res.status(400).send("Bad Request: Missing event type");
    }

    // Handle pull request creation events
    if (eventType === "pullRequestCreated") {
      console.log(`🔄 Processing pull request creation for repo: ${repositoryName}`);
      
      // Call the main processing function with extracted data
      await processCodeCommitPullRequest({
        repositoryName,
        pullRequestId: event.detail?.pullRequestId,
        sourceCommit: event.detail?.sourceCommit,        // Feature branch commit
        destinationCommit: event.detail?.destinationCommit, // Target branch commit
        sourceBranch: event.detail?.sourceReference?.replace('refs/heads/', ''),
        destinationBranch: event.detail?.destinationReference?.replace('refs/heads/', ''),
        
        // Additional metadata for debugging and auditing
        eventTime: event.time,
        region: event.region,
        rawEvent: event // Full event payload for debugging
      });
      
      console.log("✅ Successfully processed pull request");
      return res.sendStatus(200);
    } else {
      // Log unhandled event types (pullRequestMergeStatusUpdated, etc.)
      console.log(`ℹ️ No action needed for event type: ${eventType}`);
      return res.sendStatus(204); // No Content - event received but not processed
    }
  } catch (err) {
    // Log detailed error information for debugging
    console.error("❌ Error processing webhook:", err);
    console.error("Stack trace:", err.stack);
    
    return res.status(500).json({
      error: "Internal Server Error",
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Health check endpoint for monitoring and load balancer checks
 */
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "codecommit-ai-reviewer"
  });
});

/**
 * Start the Express server
 * Server will listen for incoming webhook requests from AWS EventBridge
 */
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on http://localhost:${PORT}`);
  console.log(`📋 Health check available at: http://localhost:${PORT}/health`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhook`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});