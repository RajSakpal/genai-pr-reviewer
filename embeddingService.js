import dotenv from 'dotenv';
import crypto from 'crypto';
import { Pinecone } from '@pinecone-database/pinecone';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

dotenv.config();

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pinecone.Index(process.env.PINECONE_INDEX_NAME);

export class CodebaseEmbeddingService {
  constructor(repoOwner, repoName) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.namespace = this.createNamespaceName(repoOwner, repoName);
    this.index = index.namespace(this.namespace);
    this.textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
  }

  createNamespaceName(owner, repo) {
    return `${owner}_${repo}`.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 128);
  }

  getFileExtension(filePath) {
    return filePath.split('.').pop() || 'unknown';
  }

  shouldSkipFile(filePath) {
    const skipPatterns = [
      /\.git\//, /node_modules\//, /\.lock$/, /\.min\.js$/, /\.bundle\.js$/, /\.map$/,
      /\.(png|jpe?g|gif|svg|ico|pdf|zip|tar|gz|woff2?|ttf|eot)$/i,
      /package-lock\.json$/, /yarn\.lock$/,
    ];
    return skipPatterns.some(p => p.test(filePath));
  }

  createChunkId(filePath, chunkIndex, contentHash) {
    return `${this.namespace}_${filePath}_${chunkIndex}_${contentHash}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
async processFile(filePath, content) {
  if (this.shouldSkipFile(filePath)) return [];

  try {
    const chunks = await this.textSplitter.splitText(content);
    const vectors = [];

    for (const [index, chunk] of chunks.entries()) {
      const contentHash = crypto.createHash("md5").update(chunk).digest("hex");

      vectors.push({
        id: this.createChunkId(filePath, index, contentHash),
        values: { text: chunk },
        metadata: {
          filePath,
          chunkIndex: index,
          contentHash,
          fileType: this.getFileExtension(filePath),
          lastModified: new Date().toISOString(),
        },
      });
    }

    return vectors;
  } catch (err) {
    console.error(`❌ Failed to process ${filePath}:`, err);
    return [];
  }
}

  async upsertVectors(vectors) {
    if (!vectors?.length) return;
    try {
      await this.index.upsert(vectors);
      console.log(`✅ Upserted ${vectors.length} vectors`);
    } catch (err) {
      console.error('❌ Vector upsert failed:', err);
    }
  }

  async deleteFileEmbeddings(filePath) {
    try {
      const queryRes = await this.index.query({
        vector: new Array(1536).fill(0),
        filter: { filePath: { $eq: filePath } },
        topK: 1000,
        includeMetadata: true,
      });

      const idsToDelete = queryRes.matches.map(m => m.id);
      if (idsToDelete.length) {
        await this.index.deleteMany(idsToDelete);
        console.log(`🗑️ Deleted ${idsToDelete.length} vectors for ${filePath}`);
      }
    } catch (err) {
      console.error(`❌ Deletion error for ${filePath}:`, err);
    }
  }

  async updateFileEmbeddings(filePath, newContent) {
    console.log(`🔄 Updating embeddings for ${filePath}`);
    await this.deleteFileEmbeddings(filePath);
    const vectors = await this.processFile(filePath, newContent);
    await this.upsertVectors(vectors);
    return vectors.length;
  }

  async findRelevantContext(query, filePath, topK = 10) {
    try {
      const res = await this.index.query({
        text: query,
        topK,
        includeMetadata: true,
        filter: { filePath: { $ne: filePath } },
      });
      return res.matches.map(({ metadata, score }) => ({
        filePath: metadata.filePath,
        content: metadata.content,
        fileType: metadata.fileType,
        score,
      }));
    } catch (err) {
      console.error('❌ Context search error:', err);
      return [];
    }
  }

  async getFileContext(filePath) {
    try {
      const res = await this.index.query({
        text: filePath,
        filter: { filePath: { $eq: filePath } },
        topK: 1000,
        includeMetadata: true,
      });
      return res.matches
        .sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex)
        .map(m => m.metadata.content)
        .join('\n');
    } catch (err) {
      console.error(`❌ Context fetch failed for ${filePath}:`, err);
      return null;
    }
  }

  async extractArchitecturePatterns() {
    const queries = [
      'error handling try catch', 'api response format', 'database query',
      'authentication middleware', 'test describe it', 'export function',
      'import from', 'async await',
    ];
    const patterns = [];

    for (const query of queries) {
      try {
        const res = await this.index.query({ text: query, topK: 3, includeMetadata: true });
        if (res.matches.length) {
          patterns.push(this.analyzePatternFromMatches(query, res.matches));
        }
      } catch (err) {
        console.error(`❌ Pattern query failed for "${query}"`, err);
      }
    }

    return patterns.length ? patterns.join('\n') : 'No specific patterns detected';
  }

  analyzePatternFromMatches(query, matches) {
    const fileTypes = [...new Set(matches.map(m => m.metadata.fileType))];
    const files = [...new Set(matches.map(m => m.metadata.filePath))];
    return `• **${query}**: Found in ${fileTypes.join(', ')} files (${files.length} files)`;
  }
}
