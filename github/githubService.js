import { Octokit } from "@octokit/rest";
import { splitDiffIntoHunks } from "../utils/diffUtils.js";
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

    const commentTasks = [];

    for (const file of files) {
      if (!file.patch) continue;

      const hunks = splitDiffIntoHunks(file.patch);

      hunks.forEach((hunk, index) => {
        const task = analyzeDiffAndComment(owner, repo, prNumber, file.filename, hunk, index);
        commentTasks.push(task);
      });
    }

    await Promise.all(commentTasks);
    console.log(`✅ All comments posted for PR #${prNumber}`);
  } catch (error) {
    console.error("❌ Failed to process PR:", error.message);
  }
}

async function analyzeDiffAndComment(owner, repo, prNumber, filename, hunk, index) {
  try {
    console.log(`🔍 Analyzing hunk #${index + 1} in ${filename}`);
    const suggestions = await analyzeDiffWithAI(hunk, filename);

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `### 🤖 AI Suggestion for \`${filename}\`\n\n${suggestions}`,
    });

    console.log(`💬 Comment posted for hunk #${index + 1} in ${filename}`);
  } catch (err) {
    console.error(`❌ Error posting comment for ${filename} hunk #${index + 1}:`, err.message);
  }
}
