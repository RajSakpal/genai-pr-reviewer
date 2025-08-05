import { env } from '@xenova/transformers';

// Force WASM backend configuration
env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/";
env.backends.onnx.wasm.numThreads = 1;
env.allowLocalModels = false;
env.allowRemoteModels = true;
delete env.backends.onnx.node;

import { CodeCommitClient, GetFolderCommand, GetBlobCommand } from '@aws-sdk/client-codecommit';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import { v4 as uuidv4 } from 'uuid';

const REGION = process.env.AWS_REGION || 'us-east-1';
const client = new CodeCommitClient({ region: REGION });

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

function getFileExtension(path) {
  return path.includes('.') ? path.split('.').pop() : 'unknown';
}

const getRepoFiles = async (repoName, branchName, folderPath = '/') => {
  const command = new GetFolderCommand({
    repositoryName: repoName,
    commitSpecifier: branchName,
    folderPath: folderPath,
  });

  const response = await client.send(command);
  let fileList = [];
  let loadedCount = 0;
  let failedCount = 0;

  if (response.files) {
    for (const file of response.files) {
      try {
        const blob = await client.send(
          new GetBlobCommand({
            repositoryName: repoName,
            blobId: file.blobId,
          })
        );

        fileList.push({
          path: file.absolutePath,
          blobId: file.blobId,
          content: new TextDecoder().decode(blob.content),
        });
        loadedCount++;
      } catch (e) {
        failedCount++;
        console.warn(`❌ Failed to load ${file.absolutePath}: ${e.message}`);
      }
    }
    
    if (loadedCount > 0) {
      console.log(`📄 Loaded ${loadedCount}/${response.files.length} files from ${folderPath}`);
    }
  }

  if (response.subFolders) {
    for (const subFolder of response.subFolders) {
      const subFiles = await getRepoFiles(repoName, branchName, subFolder.absolutePath);
      fileList = fileList.concat(subFiles);
    }
  }

  return fileList;
};

async function clearCollectionSafely(collectionName) {
  try {
    console.log(`🧹 Clearing old embeddings from collection: ${collectionName}`);
    
    // Method 1: Try to delete the entire collection and recreate it
    try {
      await qdrant.deleteCollection(collectionName);
      console.log(`🗑️ Deleted collection: ${collectionName}`);
      
      // Recreate the collection
      await qdrant.createCollection(collectionName, {
        vectors: {
          size: 384, // MiniLM-L6-v2 embedding dimension
          distance: 'Cosine',
        },
        optimizers_config: {
          default_segment_number: 2,
        },
        replication_factor: 1,
      });
      console.log(`✅ Recreated collection: ${collectionName}`);
      return true;
    } catch (deleteError) {
      console.log(`⚠️ Could not delete collection, trying alternative method...`);
      
      // Method 2: If deletion fails, try to clear all points using filter
      try {
        // Get collection info to see how many points exist
        const collectionInfo = await qdrant.getCollection(collectionName);
        const pointCount = collectionInfo.points_count || 0;
        
        if (pointCount > 0) {
          console.log(`🔍 Found ${pointCount} existing points, clearing them...`);
          
          // Delete all points using a filter that matches everything
          await qdrant.delete(collectionName, {
            wait: true,
            filter: {
              must: [
                {
                  key: 'repository',
                  match: { any: [collectionName.split('_')[0]] } // This will match our repo
                }
              ]
            }
          });
          console.log(`✅ Cleared ${pointCount} points from collection`);
        } else {
          console.log(`ℹ️ Collection is already empty`);
        }
        return true;
      } catch (filterError) {
        console.log(`⚠️ Filter deletion failed, trying scroll and delete...`);
        
        // Method 3: Scroll through all points and delete them in batches
        try {
          let offset = 0;
          const limit = 100;
          let hasMore = true;
          let totalDeleted = 0;
          
          while (hasMore) {
            const scrollResult = await qdrant.scroll(collectionName, {
              limit: limit,
              offset: offset,
              with_payload: false,
              with_vector: false
            });
            
            if (scrollResult.points && scrollResult.points.length > 0) {
              const pointIds = scrollResult.points.map(point => point.id);
              
              await qdrant.delete(collectionName, {
                wait: true,
                points: pointIds
              });
              
              totalDeleted += pointIds.length;
              console.log(`   🗑️ Deleted batch of ${pointIds.length} points (total: ${totalDeleted})`);
              
              if (scrollResult.points.length < limit) {
                hasMore = false;
              } else {
                offset += limit;
              }
            } else {
              hasMore = false;
            }
          }
          
          if (totalDeleted > 0) {
            console.log(`✅ Successfully deleted ${totalDeleted} points via scroll method`);
          } else {
            console.log(`ℹ️ No points found to delete`);
          }
          return true;
        } catch (scrollError) {
          console.warn(`⚠️ All cleanup methods failed, proceeding with existing data:`, scrollError.message);
          return false;
        }
      }
    }
  } catch (error) {
    console.warn(`⚠️ Collection cleanup failed, proceeding anyway:`, error.message);
    return false;
  }
}

export async function createEmbeddingsForRepo(repoName, branchName) {
  console.log(`🚀 Starting embedding process for ${repoName}/${branchName}`);
  
  const collectionName = `${repoName}_${branchName}`.replace(/[\/:*?"<>|\s-]/g, '_').toLowerCase();
  let collectionExisted = false;
  
  // Check if collection exists and clean up old embeddings
  try {
    await qdrant.getCollection(collectionName);
    collectionExisted = true;
    console.log(`📋 Collection ${collectionName} exists`);
    
    // Clear old embeddings
    await clearCollectionSafely(collectionName);
    
  } catch (error) {
    if (error.status === 404) {
      console.log(`📋 Creating new collection: ${collectionName}`);
      await qdrant.createCollection(collectionName, {
        vectors: {
          size: 384, // MiniLM-L6-v2 embedding dimension
          distance: 'Cosine',
        },
        optimizers_config: {
          default_segment_number: 2,
        },
        replication_factor: 1,
      });
      console.log(`✅ Created collection: ${collectionName}`);
    } else {
      console.error(`❌ Error checking collection:`, error.message);
      throw error;
    }
  }
  
  // File retrieval
  console.time("File retrieval");
  const files = await getRepoFiles(repoName, branchName);
  console.timeEnd("File retrieval");
  console.log(`📂 Found ${files.length} files total`);

  // Initialize services
  const embedder = await getEmbedder();
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 500, chunkOverlap: 50 });

  // Processing files
  const documents = [];
  const skippedFiles = [];
  let totalChunks = 0;
  let processedCount = 0;

  console.log("🔨 Processing files...");
  for (const file of files) {
    const content = file.content;
    processedCount++;

    // Skip empty files
    if (!content.trim()) {
      skippedFiles.push({ path: file.path, reason: 'empty' });
      continue;
    }

    // Skip large files
    if (content.length > 50000) {
      skippedFiles.push({ path: file.path, reason: 'too_large', size: content.length });
      continue;
    }

    try {
      const chunks = await splitter.splitText(content);
      totalChunks += chunks.length;
      
      chunks.forEach((chunk, i) => {
        documents.push({
          id: uuidv4(),
          text: chunk,
          metadata: {
            source: file.path,
            chunkIndex: i,
            language: getFileExtension(file.path),
            repository: repoName,
            branch: branchName,
            indexedAt: new Date().toISOString()
          },
        });
      });
    } catch (e) {
      skippedFiles.push({ path: file.path, reason: 'chunking_failed', error: e.message });
      console.warn(`❌ Failed to chunk ${file.path}: ${e.message}`);
    }

    // Progress update every 50 files
    if (processedCount % 50 === 0 || processedCount === files.length) {
      console.log(`   📝 Processed ${processedCount}/${files.length} files (${totalChunks} chunks so far)`);
    }
  }

  console.log(`✅ File processing complete: ${documents.length} chunks from ${files.length - skippedFiles.length} files`);

  // Generate embeddings
  console.log("🧠 Generating embeddings...");
  console.time("Embedding generation");
  
  const embeddings = [];
  const failedEmbeddings = [];
  let embeddedCount = 0;

  for (const doc of documents) {
    try {
      const output = await embedder(doc.text, { pooling: 'mean', normalize: true });
      embeddings.push({ 
        ...doc, 
        embedding: Array.from(output.data) 
      });
      embeddedCount++;

      // Progress update every 100 embeddings
      if (embeddedCount % 100 === 0 || embeddedCount === documents.length) {
        console.log(`   🔍 Generated ${embeddedCount}/${documents.length} embeddings`);
      }
    } catch (e) {
      failedEmbeddings.push({ source: doc.metadata.source, error: e.message });
      console.warn(`❌ Failed to embed chunk from ${doc.metadata.source}: ${e.message}`);
    }
  }

  console.timeEnd("Embedding generation");
  console.log(`✅ Embedding complete: ${embeddings.length}/${documents.length} successful`);

  // Store in Qdrant
  console.log("💾 Storing in Qdrant...");
  
  try {
    // Prepare points for batch insertion
    const points = embeddings.map((embedding) => ({
      id: embedding.id,
      vector: embedding.embedding,
      payload: {
        text: embedding.text,
        source: embedding.metadata.source,
        chunkIndex: embedding.metadata.chunkIndex,
        language: embedding.metadata.language,
        repository: embedding.metadata.repository,
        branch: embedding.metadata.branch,
        indexedAt: embedding.metadata.indexedAt
      },
    }));

    // Insert points in batches of 100
    const batchSize = 100;
    let insertedCount = 0;
    
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      try {
        await qdrant.upsert(collectionName, {
          wait: true,
          points: batch,
        });
        insertedCount += batch.length;
        
        if (insertedCount % 500 === 0 || insertedCount === points.length) {
          console.log(`   💾 Inserted ${insertedCount}/${points.length} points`);
        }
      } catch (batchError) {
        console.error(`❌ Failed to insert batch ${Math.floor(i/batchSize) + 1}:`, batchError.message);
        // Continue with next batch rather than failing completely
      }
    }
    
    console.log(`✅ Successfully stored ${insertedCount} embeddings in collection: ${collectionName}`);
  } catch (e) {
    console.error("❌ Failed to store embeddings:", e.message);
    throw e;
  }

  // Final summary
  console.log("\n📊 Embedding Summary:");
  console.log(`   📁 Total files: ${files.length}`);
  console.log(`   ✅ Successfully processed: ${files.length - skippedFiles.length}`);
  console.log(`   ⏭️ Skipped: ${skippedFiles.length}`);
  console.log(`   📄 Chunks created: ${totalChunks}`);
  console.log(`   🧠 Embeddings stored: ${embeddings.length}`);
  console.log(`   ❌ Failed embeddings: ${failedEmbeddings.length}`);
  console.log(`   🗃️ Qdrant collection: ${collectionName}`);
  console.log(`   🔄 Collection existed: ${collectionExisted ? 'Yes (cleaned)' : 'No (created)'}`);
  
  // Show skip reasons if any
  if (skippedFiles.length > 0) {
    const skipReasons = skippedFiles.reduce((acc, file) => {
      acc[file.reason] = (acc[file.reason] || 0) + 1;
      return acc;
    }, {});
    console.log(`   Skip reasons:`, skipReasons);
  }

  return {
    repo: repoName,
    branch: branchName,
    filesIndexed: files.length - skippedFiles.length,
    chunksEmbedded: embeddings.length,
    skippedFiles: skippedFiles.length,
    failedEmbeddings: failedEmbeddings.length,
    collectionName: collectionName,
    collectionExisted,
    skipReasons: skippedFiles.reduce((acc, file) => {
      acc[file.reason] = (acc[file.reason] || 0) + 1;
      return acc;
    }, {})
  };
}
