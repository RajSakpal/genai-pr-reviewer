import { Octokit } from "@octokit/rest";
import { analyzeDiffWithContext } from "../agents/contextualLangchainAgent.js";
import { CodebaseEmbeddingService } from "../services/embeddingService.js";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export async function processContextualPullRequest(pullRequest, repository) {
  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pullRequest.number;

  console.log(`📥 Processing PR #${prNumber} in ${owner}/${repo} with full context`);

  try {
    const embeddingService = new CodebaseEmbeddingService(owner, repo);

    // Get PR files
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    console.log(`🗂️ Found ${files.length} changed file(s).`);

    // Process each file with full context
    for (const file of files) {
      if (file.patch) {
        console.log(`🔍 Analyzing ${file.filename} with codebase context`);
        
        const suggestions = await analyzeDiffWithContext(
          file.patch,
          file.filename,
          owner,
          repo
        );

        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: `### 🤖 Contextual AI Review for \`${file.filename}\`\n\n${suggestions}`,
        });

        console.log(`💬 Contextual comment posted for ${file.filename}`);
      }
    }

    console.log(`✅ All contextual reviews posted for PR #${prNumber}`);
  } catch (error) {
    console.error("❌ Error processing contextual PR:", error);
  }
}

// Function to update embeddings when PR is merged
export async function updateEmbeddingsOnMerge(pullRequest, repository) {
  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pullRequest.number;

  console.log(`🔄 Updating embeddings after PR #${prNumber} merge`);

  try {
    const embeddingService = new CodebaseEmbeddingService(owner, repo);

    // Get the merged files
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Update embeddings for each changed file
    for (const file of files) {
      if (file.status === 'modified' || file.status === 'added') {
        // Get the latest file content
        const { data: fileContent } = await octokit.repos.getContent({
          owner,
          repo,
          path: file.filename,
        });

        const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
        
        await embeddingService.updateFileEmbeddings(file.filename, content);
      } else if (file.status === 'removed') {
        await embeddingService.deleteFileEmbeddings(file.filename);
      }
    }

    console.log(`✅ Embeddings updated for PR #${prNumber}`);
  } catch (error) {
    console.error("❌ Error updating embeddings:", error);
  }
}

// Main function to process pull requests - this should be called from your server
export async function processPullRequest(pullRequest, repository) {
  // You can choose which processing method to use
  // For now, using the contextual approach
  await processContextualPullRequest(pullRequest, repository);
}