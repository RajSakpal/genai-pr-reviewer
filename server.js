import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { processPullRequest, updateEmbeddingsOnMerge } from "./github/githubService.js";
import sequelize from './config/sequelize.js';
import ProjectSummary from './models/ProjectSummary.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '10mb' })); // Increase limit for large payloads
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Webhook endpoint with improved error handling
app.post("/webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  const deliveryId = req.headers["x-github-delivery"];
  
  console.log(`📦 Received GitHub event: ${event} (delivery: ${deliveryId})`);

  try {
    if (event === "pull_request") {
      const { pull_request, repository, action } = req.body;
      
      // Validate required fields
      if (!pull_request || !repository) {
        console.error("❌ Missing required fields in webhook payload");
        return res.status(400).send("Bad Request: Missing required fields");
      }

      // Handle different PR actions
      if (action === "opened") {
        // Process PR asynchronously to avoid webhook timeout
        processPullRequest(pull_request, repository)
          .catch(error => {
            console.error("❌ Failed to process PR:", error.message);
          });
        
        res.sendStatus(200);
      } else if (action === "closed" && pull_request.merged) {
        // Update embeddings when PR is merged
        updateEmbeddingsOnMerge(pull_request, repository)
          .catch(error => {
            console.error("❌ Failed to update embeddings:", error.message);
          });
        
        res.sendStatus(200);
      } else {
        console.log(`ℹ️ Ignoring PR action: ${action}`);
        res.sendStatus(204); // No action needed
      }
    } else {
      console.log(`ℹ️ Ignoring event: ${event}`);
      res.sendStatus(204); // No action needed
    }
  } catch (error) {
    console.error("❌ Webhook processing error:", error.message);
    res.status(500).send("Internal Server Error");
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack || err.message);
  res.status(500).send('Something went wrong!');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 Received SIGTERM, shutting down gracefully');
  try {
    await sequelize.close();
    console.log('✅ Database connection closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error.message);
    process.exit(1);
  }
});

// Initialize server
async function startServer() {
  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('✅ PostgreSQL connection established');

    // Sync database models
    await ProjectSummary.sync();
    console.log('✅ ProjectSummary table synced');

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔗 Health check available at http://localhost:${PORT}/health`);
    });

  } catch (error) {
    console.error('❌ Error starting server:', error.message);
    process.exit(1);
  }
}

startServer();