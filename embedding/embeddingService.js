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

export async function createEmbeddingsForRepo(repoName, branchName) {
  console.log(`🚀 Starting embedding process for ${repoName}/${branchName}`);
  
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
            branch: branchName
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
  const collectionName = `${repoName}_${branchName}`.replace(/[\/:*?"<>|\s-]/g, '_').toLowerCase();
  
  try {
    // Check if collection exists, create if not
    try {
      await qdrant.getCollection(collectionName);
      console.log(`📋 Collection ${collectionName} already exists`);
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
        throw error;
      }
    }

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
        branch: embedding.metadata.branch
      },
    }));

    // Insert points in batches of 100
    const batchSize = 100;
    let insertedCount = 0;
    
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await qdrant.upsert(collectionName, {
        wait: true,
        points: batch,
      });
      insertedCount += batch.length;
      
      if (insertedCount % 500 === 0 || insertedCount === points.length) {
        console.log(`   💾 Inserted ${insertedCount}/${points.length} points`);
      }
    }
    
    console.log(`✅ Successfully stored ${embeddings.length} embeddings in collection: ${collectionName}`);
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
    skipReasons: skippedFiles.reduce((acc, file) => {
      acc[file.reason] = (acc[file.reason] || 0) + 1;
      return acc;
    }, {})
  };
}
