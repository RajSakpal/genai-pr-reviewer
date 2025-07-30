import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { processCodeCommitPullRequest } from "./codecommit/codecommitService.js";
import { createEmbeddingsForRepo } from "./embedding/embeddingService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for processed events (use Redis in production)
const processedEvents = new Map();
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const EVENT_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup old processed events periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedEvents.entries()) {
    if (now - timestamp > EVENT_TTL) {
      processedEvents.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

// Helper function to generate unique event key
function generateEventKey(event) {
  const repositoryName = event.detail?.repositoryNames?.[0];
  const pullRequestId = event.detail?.pullRequestId;
  const sourceCommit = event.detail?.sourceCommit;
  
  return `${repositoryName}-${pullRequestId}-${sourceCommit}`;
}

app.use(bodyParser.json());

// Repository indexing endpoint
app.post("/index", async (req, res) => {
  const { repoName, branchName } = req.body;

  if (!repoName || !branchName) {
    return res.status(400).json({ 
      error: "Missing required parameters", 
      required: ["repoName", "branchName"] 
    });
  }

  try {
    console.log(`🔍 Starting indexing: ${repoName}/${branchName}`);
    const startTime = Date.now();
    
    const result = await createEmbeddingsForRepo(repoName, branchName);
    
    const duration = Date.now() - startTime;
    console.log(`✅ Indexing completed in ${duration}ms`);
    
    res.status(200).json({ 
      message: `Indexing complete for ${repoName}/${branchName}`,
      duration: `${duration}ms`,
      summary: result
    });
  } catch (err) {
    console.error(`❌ Indexing failed for ${repoName}/${branchName}:`, err.message);
    res.status(500).json({ 
      error: "Failed to index repository", 
      repository: `${repoName}/${branchName}`,
      details: err.message 
    });
  }
});

// AWS CodeCommit Webhook Handler
app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;
    const lambdaEventKey = req.headers['x-event-key'] || event.lambdaEventKey;
    const lambdaRequestId = event.lambdaRequestId;
    
    const eventType = event.detail?.event;
    const repositoryName = event.detail?.repositoryNames?.[0];
    const pullRequestId = event.detail?.pullRequestId;

    if (!eventType) {
      console.error("❌ Missing event type in webhook payload");
      return res.status(400).json({ error: "Missing event type" });
    }

    if (eventType === "pullRequestCreated") {
      // Generate application-level event key (fallback if Lambda key not available)
      const appEventKey = generateEventKey(event);
      const eventKey = lambdaEventKey || appEventKey;
      
      console.log(`📥 Received PR #${pullRequestId} for ${repositoryName}`);
      console.log(`   Lambda Request ID: ${lambdaRequestId || 'N/A'}`);
      console.log(`   Event Key: ${eventKey}`);
      
      // Check if we've already processed this exact event
      if (processedEvents.has(eventKey)) {
        const processedTime = processedEvents.get(eventKey);
        const timeSinceProcessed = Date.now() - processedTime;
        
        console.log(`🔄 Duplicate PR event detected (App-level)`);
        console.log(`   Originally processed: ${Math.round(timeSinceProcessed / 1000)}s ago`);
        
        return res.status(200).json({
          message: "Event already processed (duplicate)",
          pullRequestId: pullRequestId,
          eventKey: eventKey,
          originallyProcessedAt: new Date(processedTime).toISOString(),
          duplicate: true,
          source: 'application-cache'
        });
      }

      // Mark event as being processed
      processedEvents.set(eventKey, Date.now());

      // Respond immediately to Lambda
      res.status(200).json({
        message: "Event received and queued for processing",
        pullRequestId: pullRequestId,
        eventKey: eventKey,
        lambdaRequestId: lambdaRequestId,
        accepted: true,
        status: 'queued'
      });

      // Process asynchronously in background
      setImmediate(async () => {
        const startTime = Date.now();
        
        try {
          console.log(`🤖 Starting background processing for PR #${pullRequestId}`);
          
          const result = await processCodeCommitPullRequest({
            repositoryName,
            pullRequestId: pullRequestId,
            sourceCommit: event.detail?.sourceCommit,
            destinationCommit: event.detail?.destinationCommit,
            sourceBranch: event.detail?.sourceReference?.replace("refs/heads/", ""),
            destinationBranch: event.detail?.destinationReference?.replace("refs/heads/", ""),
            eventTime: event.time,
            region: event.region,
            rawEvent: event,
            eventKey: eventKey,
            lambdaRequestId: lambdaRequestId
          });

          const duration = Date.now() - startTime;
          console.log(`✅ PR #${pullRequestId} background processing completed in ${duration}ms`);
          
        } catch (processingError) {
          console.error(`❌ Background processing failed for PR #${pullRequestId}:`, processingError.message);
          
          // Remove from processed events if processing failed
          processedEvents.delete(eventKey);
        }
      });

      return;

    } else {
      console.log(`ℹ️ Ignoring event type: ${eventType}`);
      return res.sendStatus(204);
    }
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
    return res.status(500).json({
      error: "Internal Server Error",
      details: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`🔍 Index: http://localhost:${PORT}/index`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully');
  process.exit(0);
});
