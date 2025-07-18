import { Octokit } from '@octokit/rest';
import { CodebaseEmbeddingService } from './embeddingService.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export async function indexRepository(owner, repo, branch = 'main') {
  const embeddingService = new CodebaseEmbeddingService(owner, repo);
  const { data: tree } = await octokit.git.getTree({ owner, repo, tree_sha: branch, recursive: true });

  const files = tree.tree.filter(i => i.type === 'blob');
  console.log(`🗂 Found ${files.length} files in ${owner}/${repo}`);

  let processed = 0, skipped = 0;

  for (const file of files) {
    if (embeddingService.shouldSkipFile(file.path)) {
      skipped++;
      continue;
    }

    try {
      const { data: content } = await octokit.repos.getContent({ owner, repo, path: file.path });
      const decoded = Buffer.from(content.content, 'base64').toString('utf8');
      const vectors = await embeddingService.processFile(file.path, decoded);

      if (vectors.length) {
        await embeddingService.upsertVectors(vectors);
        processed++;
        console.log(`✅ ${file.path} (${vectors.length} chunks)`);
      }
    } catch (err) {
      console.error(`❌ ${file.path} failed:`, err.message);
    }
  }

  console.log(`🎉 Indexed: ${processed}, Skipped: ${skipped}`);
  return { processed, skipped, total: files.length, namespace: embeddingService.namespace };
}

export async function indexLocalDirectory(dirPath, repoOwner, repoName) {
  const embeddingService = new CodebaseEmbeddingService(repoOwner, repoName);
  let processed = 0, skipped = 0;

  async function walk(dir, base = '') {
    const entries = fs.readdirSync(dir);

    for (const entry of entries) {
      const full = path.join(dir, entry);
      const rel = path.join(base, entry);
      const stat = fs.statSync(full);

      if (stat.isDirectory()) await walk(full, rel);
      else if (embeddingService.shouldSkipFile(rel)) skipped++;
      else {
        try {
          const content = fs.readFileSync(full, 'utf8');
          const vectors = await embeddingService.processFile(rel, content);
          if (vectors.length) {
            await embeddingService.upsertVectors(vectors);
            processed++;
            console.log(`✅ ${rel} (${vectors.length} chunks)`);
          }
        } catch (err) {
          console.error(`❌ ${rel} failed:`, err.message);
        }
      }
    }
  }

  await walk(dirPath);
  console.log(`🎉 Local Indexed: ${processed}, Skipped: ${skipped}`);
  return { processed, skipped };
}

// CLI Entrypoint
if (process.argv[2] === 'index') {
  const [,, , ...args] = process.argv;
  if (args.length >= 2) {
    indexRepository(args[0], args[1], args[2] || 'main');
  } else if (args.length === 1 && args[0].startsWith('./')) {
    indexLocalDirectory(args[0], process.env.DEFAULT_REPO_OWNER || 'local', process.env.DEFAULT_REPO_NAME || 'project');
  } else {
    console.log('Usage:\n  node codebaseIndexer.js index <owner> <repo> [branch]\n  node codebaseIndexer.js index <local-directory>');
    process.exit(1);
  }
}
