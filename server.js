import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { processCodeCommitPullRequest } from "./codecommit/codecommitService.js";
import { createEmbeddingsForRepo } from "./embedding/embeddingService.js";
import { 
  storeGuidelineDocument,
  searchGuidelines,
  getAllDocuments,
  getDocumentsByLanguage,
  updateGuidelineDocument,
  deleteGuidelineDocument,
  deleteDocumentsByLanguage,
  formatGuidelinesForPrompt,
  getCollectionStats,
  testConnection
} from "./embedding/directGuidelineEmbeddingService.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const upload = multer({ 
  dest: 'temp/',
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /\.(pdf|txt|md|markdown)$/i;
    if (allowedTypes.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, and Markdown files are allowed'));
    }
  }
});

// In-memory store for processed events (for both webhook and indexing)
const processedEvents = new Map();
const processedIndexEvents = new Map(); // Separate store for indexing events
const CLEANUP_INTERVAL = 60 * 60 * 1000;
const EVENT_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  
  // Clean up webhook events
  for (const [key, timestamp] of processedEvents.entries()) {
    if (now - timestamp > EVENT_TTL) {
      processedEvents.delete(key);
    }
  }
  
  // Clean up indexing events
  for (const [key, timestamp] of processedIndexEvents.entries()) {
    if (now - timestamp > EVENT_TTL) {
      processedIndexEvents.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

function generateEventKey(event) {
  const repositoryName = event.detail?.repositoryNames?.[0];
  const pullRequestId = event.detail?.pullRequestId;
  const sourceCommit = event.detail?.sourceCommit;
  return `${repositoryName}-${pullRequestId}-${sourceCommit}`;
}

function generateIndexEventKey(repoName, branchName) {
  return `index-${repoName}-${branchName}`;
}

app.use(bodyParser.json());

// Repository indexing endpoint with duplicate prevention and cleanup
app.post("/index", async (req, res) => {
  console.log("🤖 Received indexing request");

  console.log(`📨 Request body:`, req.body);
  console.log(`🔑 Headers:`, req.headers);
  
  const { repoName, branchName, forceReindex = false } = req.body;

  if (!repoName || !branchName) {
    return res.status(400).json({ 
      error: "Missing required parameters", 
      required: ["repoName", "branchName"] 
    });
  }

  try {
    const indexEventKey = generateIndexEventKey(repoName, branchName);
    
    // Check for duplicate indexing request (unless force reindex is requested)
    if (!forceReindex && processedIndexEvents.has(indexEventKey)) {
      const processedTime = processedIndexEvents.get(indexEventKey);
      const timeSinceProcessed = Date.now() - processedTime;
      
      console.log(`🔄 Duplicate indexing request detected for ${repoName}/${branchName}`);
      
      return res.status(200).json({
        message: "Repository already being indexed or recently indexed (duplicate)",
        repoName,
        branchName,
        eventKey: indexEventKey,
        originallyProcessedAt: new Date(processedTime).toISOString(),
        timeSinceProcessed: `${Math.round(timeSinceProcessed / 1000)}s ago`,
        duplicate: true,
        note: "Use forceReindex: true to bypass this check"
      });
    }

    // Mark this indexing request as being processed
    processedIndexEvents.set(indexEventKey, Date.now());

    console.log(`🔍 Starting indexing: ${repoName}/${branchName}${forceReindex ? ' (forced)' : ''}`);

    // Send immediate response
    res.status(200).json({
      message: `Indexing queued for ${repoName}/${branchName}`,
      eventKey: indexEventKey,
      accepted: true,
      status: 'queued',
      forceReindex
    });

    // Process indexing in background
    setImmediate(async () => {
      const startTime = Date.now();
      
      try {
        console.log(`🤖 Starting background indexing for ${repoName}/${branchName}`);
        
        const result = await createEmbeddingsForRepo(repoName, branchName);
        
        const duration = Date.now() - startTime;
        console.log(`✅ Indexing completed for ${repoName}/${branchName} in ${duration}ms`);
        
      } catch (processingError) {
        console.error(`❌ Background indexing failed for ${repoName}/${branchName}:`, processingError.message);
        // Remove from processed events on failure so it can be retried
        processedIndexEvents.delete(indexEventKey);
      }
    });

  } catch (err) {
    console.error(`❌ Indexing failed:`, err.message);
    
    // Remove from processed events on error
    const indexEventKey = generateIndexEventKey(repoName, branchName);
    processedIndexEvents.delete(indexEventKey);
    
    res.status(500).json({ 
      error: "Failed to queue repository indexing", 
      details: err.message 
    });
  }
});

// GUIDELINES ENDPOINTS (unchanged)
// ... (all your existing guideline endpoints remain the same)

// Upload guideline document
app.post("/guidelines/upload", upload.single('file'), async (req, res) => {
  try {
    const { language, title } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ 
        error: "No file uploaded" 
      });
    }

    if (!language) {
      await fs.unlink(file.path);
      return res.status(400).json({ 
        error: "Language is required" 
      });
    }

    console.log(`📁 Uploading: ${file.originalname} for ${language}`);

    const document = {
      filePath: file.path,
      title: title || file.originalname.replace(/\.[^/.]+$/, ""),
      language: language,
      fileType: path.extname(file.originalname).substring(1)
    };

    const result = await storeGuidelineDocument(document);
    
    // Clean up temp file
    await fs.unlink(file.path);
    
    res.json({
      success: true,
      message: "Guidelines uploaded successfully",
      ...result
    });

  } catch (error) {
    console.error(`❌ Upload failed:`, error.message);
    
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch {}
    }
    
    res.status(500).json({ 
      success: false,
      error: "Upload failed", 
      details: error.message 
    });
  }
});

// Store guideline with direct content
app.post("/guidelines/store", async (req, res) => {
  try {
    const { content, title, language, fileType = 'text' } = req.body;

    if (!content || !language || !title) {
      return res.status(400).json({ 
        error: "Missing required fields: content, title, language" 
      });
    }

    const document = {
      content,
      title,
      language,
      fileType
    };

    const result = await storeGuidelineDocument(document);
    
    res.json({
      success: true,
      message: "Guidelines stored successfully",
      ...result
    });

  } catch (error) {
    console.error(`❌ Store failed:`, error.message);
    res.status(500).json({ 
      success: false,
      error: "Store failed", 
      details: error.message 
    });
  }
});

// Search guidelines
app.post("/guidelines/search", async (req, res) => {
  try {
    const { language, codeContent, limit = 5 } = req.body;

    if (!codeContent) {
      return res.status(400).json({ 
        error: "codeContent is required" 
      });
    }

    const guidelines = await searchGuidelines(language, codeContent, limit);
    
    res.json({
      success: true,
      guidelines,
      count: guidelines.length,
      formatted: formatGuidelinesForPrompt(guidelines)
    });

  } catch (error) {
    console.error(`❌ Search failed:`, error.message);
    res.status(500).json({ 
      success: false,
      error: "Search failed", 
      details: error.message 
    });
  }
});

// Get all documents
app.get("/guidelines/documents", async (req, res) => {
  try {
    const { language } = req.query;
    
    const documents = language ? 
      await getDocumentsByLanguage(language) : 
      await getAllDocuments();
    
    res.json({
      success: true,
      documents,
      count: documents.length,
      language: language || 'all'
    });

  } catch (error) {
    console.error(`❌ Get documents failed:`, error.message);
    res.status(500).json({ 
      success: false,
      error: "Failed to get documents", 
      details: error.message 
    });
  }
});

// Update document
app.put("/guidelines/documents/:documentId", async (req, res) => {
  try {
    const { documentId } = req.params;
    const { content, title, language, fileType = 'text' } = req.body;

    if (!content || !title || !language) {
      return res.status(400).json({ 
        error: "Missing required fields: content, title, language" 
      });
    }

    const updatedDocument = {
      content,
      title,
      language,
      fileType
    };

    const result = await updateGuidelineDocument(documentId, updatedDocument);
    
    res.json({
      success: true,
      message: "Document updated successfully",
      ...result
    });

  } catch (error) {
    console.error(`❌ Update failed:`, error.message);
    res.status(500).json({ 
      success: false,
      error: "Update failed", 
      details: error.message 
    });
  }
});

// Delete document
app.delete("/guidelines/documents/:documentId", async (req, res) => {
  try {
    const { documentId } = req.params;
    
    const result = await deleteGuidelineDocument(documentId);
    
    res.json({
      success: true,
      message: "Document deleted successfully",
      ...result
    });

  } catch (error) {
    console.error(`❌ Delete failed:`, error.message);
    res.status(500).json({ 
      success: false,
      error: "Delete failed", 
      details: error.message 
    });
  }
});

// Delete all documents by language
app.delete("/guidelines/language/:language", async (req, res) => {
  try {
    const { language } = req.params;
    
    const result = await deleteDocumentsByLanguage(language);
    
    res.json({
      success: true,
      message: `All documents deleted for language: ${language}`,
      ...result
    });

  } catch (error) {
    console.error(`❌ Delete by language failed:`, error.message);
    res.status(500).json({ 
      success: false,
      error: "Delete failed", 
      details: error.message 
    });
  }
});

// Get collection statistics
app.get("/guidelines/stats", async (req, res) => {
  try {
    const stats = await getCollectionStats();
    
    res.json({
      success: true,
      ...stats
    });

  } catch (error) {
    console.error(`❌ Stats failed:`, error.message);
    res.status(500).json({ 
      success: false,
      error: "Failed to get stats", 
      details: error.message 
    });
  }
});

// Test connection
app.get("/guidelines/test", async (req, res) => {
  try {
    const result = await testConnection();
    
    res.json({
      success: result.status === 'success',
      ...result
    });

  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: "Connection test failed",
      details: error.message 
    });
  }
});

// AWS CodeCommit Webhook Handler (unchanged)
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
      const appEventKey = generateEventKey(event);
      const eventKey = lambdaEventKey || appEventKey;
      
      console.log(`📥 Received PR #${pullRequestId} for ${repositoryName}`);
      
      if (processedEvents.has(eventKey)) {
        const processedTime = processedEvents.get(eventKey);
        const timeSinceProcessed = Date.now() - processedTime;
        
        console.log(`🔄 Duplicate PR event detected`);
        
        return res.status(200).json({
          message: "Event already processed (duplicate)",
          pullRequestId: pullRequestId,
          eventKey: eventKey,
          originallyProcessedAt: new Date(processedTime).toISOString(),
          duplicate: true
        });
      }

      processedEvents.set(eventKey, Date.now());

      res.status(200).json({
        message: "Event received and queued for processing",
        pullRequestId: pullRequestId,
        eventKey: eventKey,
        lambdaRequestId: lambdaRequestId,
        accepted: true,
        status: 'queued'
      });

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
          console.log(`✅ PR #${pullRequestId} processing completed in ${duration}ms`);
          
        } catch (processingError) {
          console.error(`❌ Background processing failed for PR #${pullRequestId}:`, processingError.message);
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
  console.log(`\n📋 GUIDELINES API:`);
  console.log(`   📁 Upload: POST http://localhost:${PORT}/guidelines/upload`);
  console.log(`   📝 Store: POST http://localhost:${PORT}/guidelines/store`);
  console.log(`   🔎 Search: POST http://localhost:${PORT}/guidelines/search`);
  console.log(`   📖 Documents: GET http://localhost:${PORT}/guidelines/documents`);
  console.log(`   🔄 Update: PUT http://localhost:${PORT}/guidelines/documents/:id`);
  console.log(`   🗑️ Delete: DELETE http://localhost:${PORT}/guidelines/documents/:id`);
  console.log(`   🗑️ Delete Language: DELETE http://localhost:${PORT}/guidelines/language/:lang`);
  console.log(`   📊 Stats: GET http://localhost:${PORT}/guidelines/stats`);
  console.log(`   🔧 Test: GET http://localhost:${PORT}/guidelines/test`);
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
