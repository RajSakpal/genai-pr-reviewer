import { Octokit } from "@octokit/rest";
import analyzeDiffWithAI from "./langchainAgent.js";
import { splitDiffIntoHunks } from "./utils/diffUtils.js";

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

    const commentPromises = files
      .filter((file) => file.patch)
      .flatMap((file) => {
        const hunks = splitDiffIntoHunks(file.patch);

        return hunks.map(async (hunk, index) => {
          try {
            console.log(`🔍 Analyzing hunk #${index + 1} in ${file.filename}`);
            const suggestions = await analyzeDiffWithAI(hunk, file.filename);

            await octokit.issues.createComment({
              owner,
              repo: repoName,
              issue_number: prNumber,
              body: `### 🤖 AI Suggestion for \`${file.filename}\`\n\n${suggestions}`,
            });

            console.log(
              `💬 Comment posted for hunk #${index + 1} in ${file.filename}`
            );
          } catch (err) {
            console.error(
              `❌ Error processing hunk in ${file.filename}:`,
              err.message
            );
          }
        });
      });

    await Promise.all(commentPromises);
  } catch (error) {
    console.error("❌ GitHub processing error:", error);
  }
}

export default processPullRequest;
