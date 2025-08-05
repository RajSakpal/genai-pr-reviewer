import { env } from '@xenova/transformers';
import fs from 'fs/promises';
import PDFParser from "pdf2json";

// Force WASM backend configuration
env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";
env.backends.onnx.wasm.numThreads = 1;
env.allowLocalModels = false;
env.allowRemoteModels = true;
delete env.backends.onnx.node;

import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { v4 as uuidv4 } from 'uuid';

// Initialize Qdrant client
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL || 'http://localhost:6333',
  apiKey: process.env.QDRANT_API_KEY,
});

const COLLECTION_NAME = "ai_guidelines";

// Track if indexes have been created to avoid recreating them
let indexesCreated = false;

let embedder;
async function getEmbedder() {
  if (!embedder) {
    console.log("⚙️ Initializing embedder pipeline...");
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { 
      quantized: false, 
      backend: 'wasm' 
    });
    console.log("✅ Embedder pipeline ready");
  }
  return embedder;
}

/**
 * Create required indexes for filtering - only when needed
 */
async function createIndexes() {
  if (indexesCreated) {
    return; // Skip if already created
  }
  
  console.log("🔧 Creating indexes for filtering...");
  
  const indexes = [
    { field: 'language', type: 'keyword' },
    { field: 'document_id', type: 'keyword' },
    { field: 'document_title', type: 'text' }
  ];
  
  let createdCount = 0;
  
  for (const index of indexes) {
    try {
      await qdrant.createPayloadIndex(COLLECTION_NAME, {
        field_name: index.field,
        field_schema: index.type
      });
      console.log(`✅ Created index for ${index.field}`);
      createdCount++;
    } catch (error) {
      if (error.message && error.message.includes('already exists')) {
        console.log(`✅ Index already exists for ${index.field}`);
        createdCount++;
      } else {
        console.warn(`⚠️ Failed to create index for ${index.field}:`, error.message);
      }
    }
  }
  
  if (createdCount === indexes.length) {
    indexesCreated = true;
    console.log(`✅ All indexes ready for collection: ${COLLECTION_NAME}`);
  }
}

/**
 * Check if collection exists - simple check without index creation
 */
async function checkCollection() {
  try {
    const collection = await qdrant.getCollection(COLLECTION_NAME);
    return collection;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Initialize collection with proper schema - creates indexes only once
 */
async function initializeCollection() {
  try {
    console.log(`🔍 Checking collection: ${COLLECTION_NAME}`);
    
    // Check if collection exists
    const existingCollection = await checkCollection();
    
    if (existingCollection) {
      console.log(`✅ Collection exists with ${existingCollection.points_count} points`);
      
      // Create indexes only if this is the first time or they weren't created before
      if (!indexesCreated) {
        await createIndexes();
      }
      
      return true;
    }
    
    // Create new collection
    console.log(`📋 Creating collection: ${COLLECTION_NAME}`);
    await qdrant.createCollection(COLLECTION_NAME, {
      vectors: {
        size: 384, // MiniLM-L6-v2 embedding dimension
        distance: 'Cosine'
      },
      optimizers_config: {
        default_segment_number: 2
      },
      replication_factor: 1
    });
    
    console.log(`✅ Collection created: ${COLLECTION_NAME}`);
    
    // Create indexes for new collection
    await createIndexes();
    
    return true;
    
  } catch (error) {
    console.error(`❌ Failed to initialize collection:`, error);
    throw error;
  }
}

/**
 * Extract text from PDF
 */
async function extractPDFText(filePath) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();
    
    pdfParser.on("pdfParser_dataError", errData => {
      reject(new Error(`PDF parsing error: ${errData.parserError}`));
    });
    
    pdfParser.on("pdfParser_dataReady", pdfData => {
      try {
        let extractedText = "";
        
        if (pdfData.Pages && pdfData.Pages.length > 0) {
          pdfData.Pages.forEach(page => {
            if (page.Texts) {
              page.Texts.forEach(text => {
                if (text.R && text.R.length > 0) {
                  text.R.forEach(textRun => {
                    if (textRun.T) {
                      extractedText += decodeURIComponent(textRun.T) + " ";
                    }
                  });
                }
              });
            }
            extractedText += "\n";
          });
        }
        
        if (extractedText.trim().length === 0) {
          reject(new Error("PDF appears to be empty"));
          return;
        }
        
        console.log(`✅ PDF extracted: ${extractedText.length} characters from ${pdfData.Pages.length} pages`);
        resolve(extractedText);
      } catch (processingError) {
        reject(new Error(`PDF processing failed: ${processingError.message}`));
      }
    });
    
    pdfParser.loadPDF(filePath);
  });
}

/**
 * Extract text from various file formats
 */
async function extractDocumentText(filePath, fileType) {
  console.log(`📄 Extracting ${fileType.toUpperCase()}: ${filePath}`);
  
  switch (fileType.toLowerCase()) {
    case 'pdf':
      return await extractPDFText(filePath);
    
    case 'txt':
    case 'md':
    case 'markdown':
      return await fs.readFile(filePath, 'utf-8');
    
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}

/**
 * Store guideline document embeddings
 */
export async function storeGuidelineDocument(document) {
  console.log(`🚀 Storing guideline document: ${document.title || 'Untitled'}`);
  
  try {
    // Initialize collection (creates indexes if needed)
    await initializeCollection();
    
    // Get embedder
    const embedderInstance = await getEmbedder();
    
    // Extract text content
    let textContent = document.content;
    if (document.filePath && !textContent) {
      const fileType = document.fileType || document.filePath.split('.').pop();
      textContent = await extractDocumentText(document.filePath, fileType);
    }
    
    if (!textContent || textContent.trim().length === 0) {
      throw new Error('Document content is empty');
    }
    
    // Split text into chunks
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
      separators: ["\n\n", "\n", ". ", " "]
    });
    
    const chunks = await splitter.splitText(textContent);
    console.log(`📄 Created ${chunks.length} chunks`);
    
    // Generate document ID
    const documentId = document.id || uuidv4();
    
    // Prepare points for insertion
    const points = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i].trim();
      if (chunk.length < 50) continue; // Skip small chunks
      
      // Generate embedding
      const embedding = await embedderInstance(chunk, { pooling: 'mean', normalize: true });
      
      points.push({
        id: uuidv4(),
        vector: Array.from(embedding.data),
        payload: {
          text: chunk,
          language: document.language || 'General',
          document_id: documentId,
          document_title: document.title || 'Untitled',
          document_type: document.fileType || 'text',
          chunk_index: i,
          total_chunks: chunks.length,
          created_at: new Date().toISOString()
        }
      });
    }
    
    if (points.length === 0) {
      throw new Error('No valid chunks created');
    }
    
    // Insert points in batches
    const batchSize = 50;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await qdrant.upsert(COLLECTION_NAME, {
        wait: true,
        points: batch
      });
      console.log(`💾 Inserted batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(points.length/batchSize)}`);
    }
    
    console.log(`✅ Stored ${points.length} chunks for document: ${document.title}`);
    
    return {
      document_id: documentId,
      document_title: document.title,
      language: document.language,
      chunks_created: points.length,
      success: true
    };
    
  } catch (error) {
    console.error(`❌ Failed to store document:`, error);
    throw error;
  }
}

/**
 * Search guidelines based on code content - no index creation during search
 */
export async function searchGuidelines(language, codeContent, limit = 5) {
  console.log(`🔍 Searching guidelines: ${language || 'any language'}, limit: ${limit}`);
  
  try {
    // Simple collection check - no index creation
    const collectionInfo = await checkCollection();
    
    if (!collectionInfo) {
      console.log(`⚠️ Collection ${COLLECTION_NAME} doesn't exist`);
      return [];
    }
    
    if (collectionInfo.points_count === 0) {
      console.log(`⚠️ No guidelines found in collection`);
      return [];
    }
    
    console.log(`📋 Collection has ${collectionInfo.points_count} points`);
    
    // Get embedder and generate query embedding
    const embedderInstance = await getEmbedder();
    const queryEmbedding = await embedderInstance(codeContent, { pooling: 'mean', normalize: true });
    
    let searchResults = [];
    
    // Try search with language filter first
    if (language && language !== 'General' && language !== 'any') {
      try {
        console.log(`🔍 Searching with language filter: ${language}`);
        
        searchResults = await qdrant.search(COLLECTION_NAME, {
          vector: Array.from(queryEmbedding.data),
          filter: {
            must: [
              { key: "language", match: { value: language } }
            ]
          },
          limit: limit,
          score_threshold: 0.3,
          with_payload: true
        });
        
        console.log(`✅ Language-filtered search found ${searchResults.length} results`);
        
      } catch (filterError) {
        console.warn(`⚠️ Language-filtered search failed: ${filterError.message}`);
        console.log(`🔄 Falling back to manual filtering...`);
        
        // Fallback: search without filter, then filter manually
        try {
          const allResults = await qdrant.search(COLLECTION_NAME, {
            vector: Array.from(queryEmbedding.data),
            limit: limit * 3, // Get more to filter manually
            score_threshold: 0.3,
            with_payload: true
          });
          
          // Filter by language manually
          searchResults = allResults.filter(result => 
            result.payload.language === language
          ).slice(0, limit);
          
          console.log(`✅ Manual filtering found ${searchResults.length} results for ${language}`);
          
        } catch (fallbackError) {
          console.error(`❌ Fallback search also failed: ${fallbackError.message}`);
          return [];
        }
      }
    } else {
      // Search across all languages
      try {
        console.log(`🔍 Searching across all languages`);
        
        searchResults = await qdrant.search(COLLECTION_NAME, {
          vector: Array.from(queryEmbedding.data),
          limit: limit,
          score_threshold: 0.3,
          with_payload: true
        });
        
        console.log(`✅ Cross-language search found ${searchResults.length} results`);
        
      } catch (searchError) {
        console.error(`❌ Cross-language search failed: ${searchError.message}`);
        return [];
      }
    }
    
    // Process results
    const results = searchResults.map(result => ({
      id: result.id,
      text: result.payload.text,
      document_title: result.payload.document_title,
      document_type: result.payload.document_type,
      language: result.payload.language,
      relevance_score: result.score,
      chunk_index: result.payload.chunk_index
    }));
    
    console.log(`✅ Returning ${results.length} relevant guidelines`);
    return results;
    
  } catch (error) {
    console.error(`❌ Search failed:`, error);
    return [];
  }
}

/**
 * Get all documents
 */
export async function getAllDocuments(language = null) {
  console.log(`📋 Getting all documents${language ? ` for language: ${language}` : ''}`);
  
  try {
    const collectionInfo = await checkCollection();
    
    if (!collectionInfo) {
      console.log(`⚠️ Collection doesn't exist`);
      return [];
    }
    
    // Get all points from collection
    const scrollParams = {
      limit: 1000,
      with_payload: true,
      with_vector: false
    };
    
    const allPoints = await qdrant.scroll(COLLECTION_NAME, scrollParams);
    
    if (allPoints.points.length === 0) {
      console.log(`⚠️ No documents found`);
      return [];
    }
    
    // Group by document_id and filter by language if specified
    const documentsMap = new Map();
    
    allPoints.points.forEach(point => {
      const payload = point.payload;
      const docId = payload.document_id;
      
      // Skip if language filter doesn't match
      if (language && payload.language !== language) {
        return;
      }
      
      if (!documentsMap.has(docId)) {
        documentsMap.set(docId, {
          document_id: docId,
          document_title: payload.document_title,
          document_type: payload.document_type,
          language: payload.language,
          created_at: payload.created_at,
          total_chunks: payload.total_chunks,
          chunk_count: 0
        });
      }
      
      documentsMap.get(docId).chunk_count++;
    });
    
    const documents = Array.from(documentsMap.values());
    console.log(`✅ Found ${documents.length} documents`);
    
    return documents;
    
  } catch (error) {
    console.error(`❌ Failed to get documents:`, error);
    throw error;
  }
}

/**
 * Get documents by language
 */
export async function getDocumentsByLanguage(language) {
  return await getAllDocuments(language);
}

/**
 * Update/Replace guideline document
 */
export async function updateGuidelineDocument(documentId, updatedDocument) {
  console.log(`🔄 Updating document: ${documentId}`);
  
  try {
    // Delete old document chunks by scrolling and collecting IDs
    console.log(`🗑️ Removing old chunks for document: ${documentId}`);
    
    const existingPoints = await qdrant.scroll(COLLECTION_NAME, {
      limit: 1000,
      with_payload: true,
      with_vector: false
    });
    
    // Filter points that belong to this document
    const pointsToDelete = existingPoints.points.filter(point => 
      point.payload.document_id === documentId
    );
    
    if (pointsToDelete.length > 0) {
      const pointIds = pointsToDelete.map(point => point.id);
      
      await qdrant.delete(COLLECTION_NAME, {
        points: pointIds,
        wait: true
      });
      
      console.log(`🗑️ Deleted ${pointIds.length} old chunks`);
    }
    
    // Store updated document with same ID
    const result = await storeGuidelineDocument({
      ...updatedDocument,
      id: documentId
    });
    
    console.log(`✅ Updated document with ${result.chunks_created} new chunks`);
    return result;
    
  } catch (error) {
    console.error(`❌ Failed to update document:`, error);
    throw error;
  }
}

/**
 * Delete guideline document
 */
export async function deleteGuidelineDocument(documentId) {
  console.log(`🗑️ Deleting document: ${documentId}`);
  
  try {
    // Get all points and filter by document_id
    const allPoints = await qdrant.scroll(COLLECTION_NAME, {
      limit: 1000,
      with_payload: true,
      with_vector: false
    });
    
    const pointsToDelete = allPoints.points.filter(point => 
      point.payload.document_id === documentId
    );
    
    if (pointsToDelete.length === 0) {
      throw new Error('Document not found');
    }
    
    const pointIds = pointsToDelete.map(point => point.id);
    
    await qdrant.delete(COLLECTION_NAME, {
      points: pointIds,
      wait: true
    });
    
    console.log(`✅ Deleted ${pointIds.length} chunks`);
    
    return {
      document_id: documentId,
      chunks_deleted: pointIds.length,
      success: true
    };
    
  } catch (error) {
    console.error(`❌ Failed to delete document:`, error);
    throw error;
  }
}

/**
 * Delete all documents for a language
 */
export async function deleteDocumentsByLanguage(language) {
  console.log(`🗑️ Deleting all documents for language: ${language}`);
  
  try {
    // Get all points and filter by language
    const allPoints = await qdrant.scroll(COLLECTION_NAME, {
      limit: 1000,
      with_payload: true,
      with_vector: false
    });
    
    const pointsToDelete = allPoints.points.filter(point => 
      point.payload.language === language
    );
    
    if (pointsToDelete.length === 0) {
      console.log(`⚠️ No documents found for language: ${language}`);
      return { chunks_deleted: 0, success: true };
    }
    
    const pointIds = pointsToDelete.map(point => point.id);
    
    await qdrant.delete(COLLECTION_NAME, {
      points: pointIds,
      wait: true
    });
    
    console.log(`✅ Deleted ${pointIds.length} chunks for language: ${language}`);
    
    return {
      language: language,
      chunks_deleted: pointIds.length,
      success: true
    };
    
  } catch (error) {
    console.error(`❌ Failed to delete documents for language:`, error);
    throw error;
  }
}

/**
 * Manually create indexes (for troubleshooting)
 */
export async function createCollectionIndexes() {
  try {
    console.log(`🔧 Manually creating indexes for collection: ${COLLECTION_NAME}`);
    
    // Reset the flag to force index creation
    indexesCreated = false;
    await createIndexes();
    
    return {
      collection: COLLECTION_NAME,
      message: "Indexes created successfully",
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`❌ Failed to create indexes:`, error.message);
    throw error;
  }
}

/**
 * Format guidelines for AI prompt
 */
export function formatGuidelinesForPrompt(guidelines) {
  if (!guidelines || guidelines.length === 0) {
    return "Apply standard coding best practices.";
  }

  let formatted = "**Relevant Guidelines:**\n\n";
  
  guidelines.forEach((guideline, index) => {
    formatted += `**${index + 1}. From "${guideline.document_title}"** (Score: ${guideline.relevance_score.toFixed(2)})\n`;
    formatted += `${guideline.text}\n\n`;
  });

  return formatted.trim();
}

/**
 * Get collection statistics
 */
export async function getCollectionStats() {
  try {
    const collectionInfo = await checkCollection();
    
    if (!collectionInfo) {
      return {
        collection_name: COLLECTION_NAME,
        total_points: 0,
        total_documents: 0,
        languages: {},
        status: "Collection doesn't exist"
      };
    }
    
    // Get all points to calculate stats
    const allPoints = await qdrant.scroll(COLLECTION_NAME, {
      limit: 1000,
      with_payload: true,
      with_vector: false
    });
    
    // Count by language and documents
    const languageStats = {};
    const documentStats = new Set();
    
    allPoints.points.forEach(point => {
      const language = point.payload.language;
      languageStats[language] = (languageStats[language] || 0) + 1;
      documentStats.add(point.payload.document_id);
    });
    
    return {
      collection_name: COLLECTION_NAME,
      total_points: collectionInfo.points_count,
      total_documents: documentStats.size,
      languages: languageStats,
      status: collectionInfo.status,
      indexes_created: indexesCreated
    };
    
  } catch (error) {
    console.error(`❌ Failed to get collection stats:`, error);
    throw error;
  }
}

/**
 * Test connection
 */
export async function testConnection() {
  try {
    const collections = await qdrant.getCollections();
    console.log("✅ Qdrant connection successful");
    
    return {
      status: "success",
      collections: collections.collections.map(c => c.name),
      url: process.env.QDRANT_URL || 'http://localhost:6333',
      indexes_created: indexesCreated
    };
    
  } catch (error) {
    console.error("❌ Qdrant connection failed:", error);
    return {
      status: "failed",
      error: error.message,
      url: process.env.QDRANT_URL || 'http://localhost:6333'
    };
  }
}
