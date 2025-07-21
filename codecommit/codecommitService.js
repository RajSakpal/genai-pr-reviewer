import { CodeCommitClient, GetDifferencesCommand } from "@aws-sdk/client-codecommit";
import { analyzeDiffWithAI } from "../agents/langchainAgent.js";
import dotenv from "dotenv";

dotenv.config();

const client = new CodeCommitClient({ region: process.env.AWS_REGION || "ap-south-1" });

export async function processCodeCommitPullRequest({ repositoryName, pullRequestId, sourceCommit, destinationCommit }) {
  console.log(`📥 Processing CodeCommit PR #${pullRequestId} in ${repositoryName}`);

  try {
    const changedFiles = [];

    let nextToken;
    do {
      const response = await client.send(
        new GetDifferencesCommand({
          repositoryName,
          beforeCommitSpecifier: destinationCommit,
          afterCommitSpecifier: sourceCommit,
          nextToken,
        })
      );

      response.differences?.forEach((diff) => {
        if (diff.afterBlob?.path && diff.changeType !== "D") {
          changedFiles.push({
            filename: diff.afterBlob.path,
            beforeBlobId: diff.beforeBlob?.blobId,
            afterBlobId: diff.afterBlob.blobId,
          });
        }
      });

      nextToken = response.nextToken;
    } while (nextToken);

    console.log(`🗂️ Found ${changedFiles.length} changed file(s)`);

    for (const file of changedFiles) {
      const patch = await getPatchDiff(repositoryName, file.beforeBlobId, file.afterBlobId);
      if (patch) {
        console.log(`🔍 Analyzing ${file.filename}`);
        const suggestions = await analyzeDiffWithAI(patch, file.filename);
        console.log(`🤖 Suggestions for ${file.filename}:\n${suggestions}\n`);
        // TODO: Save or post suggestions somewhere (e.g., DynamoDB, SNS, email, etc.)
      }
    }
  } catch (err) {
    console.error("❌ Error analyzing CodeCommit PR:", err.stack || err.message);
    throw err;
  }
}

async function getPatchDiff(repositoryName, beforeBlobId, afterBlobId) {
  if (!beforeBlobId || !afterBlobId || beforeBlobId === afterBlobId) return null;

  const { GetBlobCommand } = await import("@aws-sdk/client-codecommit");

  const before = await client.send(new GetBlobCommand({ repositoryName, blobId: beforeBlobId }));
  const after = await client.send(new GetBlobCommand({ repositoryName, blobId: afterBlobId }));

  const beforeContent = Buffer.from(before.content).toString("utf8");
  const afterContent = Buffer.from(after.content).toString("utf8");

  return generateUnifiedDiff(beforeContent, afterContent);
}

// You can use `diff` or `diff-match-patch` for better diff quality
function generateUnifiedDiff(oldStr, newStr) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const patchLines = [];
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i] || "";
    const newLine = newLines[i] || "";
    if (oldLine !== newLine) {
      patchLines.push(`- ${oldLine}`);
      patchLines.push(`+ ${newLine}`);
    }
  }

  return patchLines.join("\n");
}
