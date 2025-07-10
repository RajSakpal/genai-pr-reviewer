import { Octokit } from "@octokit/rest";
import analyzeDiffWithAI from "./langchainAgent.js";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function processPullRequest(pr, repo) {
  const owner = repo.owner.login;
  const repoName = repo.name;
  const prNumber = pr.number;

  console.log(`📥 Processing PR #${prNumber} in ${owner}/${repoName}`);

  try {
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    for (const file of files) {
      if (file.patch) {
        console.log(`🔍 Analyzing ${file.filename}`);
        console.log("File Patch: ",file.patch);
        const suggestions = await analyzeDiffWithAI(file.patch, file.filename);

        await octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: prNumber,
          body: `### 🤖 AI Suggestions for \`${file.filename}\`\n\n${suggestions}`,
        });

        console.log(`💬 Comment posted for ${file.filename}`);
      }
    }
  } catch (error) {
    console.error("❌ GitHub processing error:", error);
  }
}

export default processPullRequest;
