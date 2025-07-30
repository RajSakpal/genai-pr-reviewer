import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import { env } from '@xenova/transformers';

// Configure WASM backend (same as your existing setup)
env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";
env.backends.onnx.wasm.numThreads = 1;
env.allowLocalModels = false;
env.allowRemoteModels = true;
delete env.backends.onnx.node;

// Initialize Qdrant client
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL || 'http://localhost:6333',
  apiKey: process.env.QDRANT_API_KEY, // For Qdrant Cloud
});

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

export async function getRelevantContext(repositoryName, branchName, filename, fileContent, maxResults = 10) {
  try {
    const collectionName = `${repositoryName}_${branchName}`.replace(/[\/:*?"<>|\s-]/g, '_').toLowerCase();
    const embedderInstance = await getEmbedder();
    
    // Check if collection exists
    try {
      await qdrant.getCollection(collectionName);
    } catch (error) {
      if (error.status === 404) {
        console.warn(`⚠️ Collection ${collectionName} not found. Repository may not be indexed.`);
        return {
          hasContext: false,
          contextChunks: [],
          relatedFiles: [],
          summary: "Repository not indexed. Please run indexing first."
        };
      }
      throw error;
    }
    
    // Create embedding for the current file content
    const queryText = `${filename}\n${fileContent.substring(0, 1000)}`;
    const queryEmbedding = await embedderInstance(queryText, { pooling: 'mean', normalize: true });
    
    // Search for similar code chunks
    const searchResults = await qdrant.search(collectionName, {
      vector: Array.from(queryEmbedding.data),
      limit: maxResults,
      with_payload: true,
      score_threshold: 0.3, // Only return results with similarity > 0.3
    });
    
    if (!searchResults || searchResults.length === 0) {
      return {
        hasContext: false,
        contextChunks: [],
        relatedFiles: [],
        summary: "No relevant context found in the knowledge base."
      };
    }
    
    const contextChunks = searchResults.map((result) => ({
      content: result.payload.text,
      metadata: {
        source: result.payload.source,
        chunkIndex: result.payload.chunkIndex,
        language: result.payload.language,
        repository: result.payload.repository,
        branch: result.payload.branch
      },
      similarity: result.score,
    }));
    
    const relatedFiles = [...new Set(contextChunks.map(chunk => chunk.metadata.source))];
    const externalContext = contextChunks.filter(chunk => 
      chunk.metadata.source !== filename && 
      chunk.similarity > 0.3
    );
    
    return {
      hasContext: externalContext.length > 0,
      contextChunks: externalContext,
      relatedFiles: relatedFiles.filter(file => file !== filename),
      summary: externalContext.length > 0 
        ? `Found ${externalContext.length} related code chunks from ${relatedFiles.length} files`
        : "No relevant external context found."
    };
    
  } catch (error) {
    console.error(`❌ Context lookup failed for ${filename}:`, error.message);
    return {
      hasContext: false,
      contextChunks: [],
      relatedFiles: [],
      summary: `Context retrieval failed: ${error.message}`,
      error: true
    };
  }
}

/**
 * Format context for AI prompt
 */
export function formatContextForPrompt(context) {
  if (!context.hasContext) {
    return "";
  }
  
  let formattedContext = "\n## RELEVANT CODEBASE CONTEXT\n";
  formattedContext += `${context.summary}\n\n`;
  
  // Group chunks by file for better organization
  const chunksByFile = {};
  context.contextChunks.forEach(chunk => {
    const file = chunk.metadata.source;
    if (!chunksByFile[file]) {
      chunksByFile[file] = [];
    }
    chunksByFile[file].push(chunk);
  });
  
  // Add top 5 most relevant files with their chunks
  const sortedFiles = Object.entries(chunksByFile)
    .sort((a, b) => Math.max(...b[1].map(c => c.similarity)) - Math.max(...a[1].map(c => c.similarity)))
    .slice(0, 5);
    
  sortedFiles.forEach(([filename, chunks]) => {
    formattedContext += `### Related Code from: ${filename}\n`;
    const bestChunk = chunks.sort((a, b) => b.similarity - a.similarity)[0];
    formattedContext += `\`\`\`${bestChunk.metadata.language || ''}\n${bestChunk.content.trim()}\n\`\`\`\n\n`;
  });
  
  return formattedContext;
}

/**
 * Health check for Qdrant connection
 */
export async function checkQdrantHealth() {
  try {
    const collections = await qdrant.getCollections();
    return {
      status: 'healthy',
      collectionsCount: collections.collections.length,
      collections: collections.collections.map(c => c.name)
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    };
  }
}

/**
 * Get collection statistics
 */
export async function getCollectionStats(repositoryName, branchName) {
  try {
    const collectionName = `${repositoryName}_${branchName}`.replace(/[\/:*?"<>|\s-]/g, '_').toLowerCase();
    const info = await qdrant.getCollection(collectionName);
    return {
      name: collectionName,
      pointsCount: info.points_count,
      status: info.status,
      vectorsConfig: info.config.params.vectors
    };
  } catch (error) {
    return {
      name: collectionName,
      error: error.message,
      status: 'not_found'
    };
  }
}
