import { Octokit } from "@octokit/rest";
import { analyzeDiffWithAI } from "../agents/langchainAgent.js";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export async function processPullRequest(pullRequest, repository) {
  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pullRequest.number;

  console.log(`📥 Processing PR #${prNumber} in ${owner}/${repo}`);

  try {
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    console.log(`🗂️ Found ${files.length} changed file(s).`);

    const commentTasks = files
      .filter((file) => file.patch)
      .map((file, idx) => {
        console.log(`📄 File #${idx + 1}: ${file.filename}`);
        return analyzeDiffAndComment(owner, repo, prNumber, file.filename, file.patch);
      });

    await Promise.all(commentTasks);

    console.log(`✅ All AI comments posted for PR #${prNumber}`);
  } catch (error) {
    console.error("❌ Error processing PR:", error.stack || error.message);
  }
}

async function analyzeDiffAndComment(owner, repo, prNumber, filename, patch) {
  try {
    console.log(`🔍 Analyzing ${filename}`);
    const suggestions = await analyzeDiffWithAI(patch, filename);

    console.log(`📝 AI suggestions ready for ${filename}`);

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `### 🤖 AI Suggestion for \`${filename}\`\n\n${suggestions}`,
    });

    console.log(`💬 Comment posted for ${filename}`);
  } catch (err) {
    console.error(`❌ Error posting comment for ${filename}:`, err.stack || err.message);
  }
}

