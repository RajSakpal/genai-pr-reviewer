import { CodeCommitClient, GetDifferencesCommand } from "@aws-sdk/client-codecommit";
import { analyzeDiffWithAI } from "../agents/langchainAgent.js";
import dotenv from "dotenv";

dotenv.config();

const clientConfig = {
  region: process.env.AWS_REGION || "ap-south-1"
};

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  clientConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN })
  };
}

const client = new CodeCommitClient(clientConfig);

export async function processCodeCommitPullRequest({ repositoryName, pullRequestId, sourceCommit, destinationCommit }) {
  console.log(`📥 [START] Processing PR #${pullRequestId} in repo ${repositoryName}`);
  console.log(`    Comparing commits: ${sourceCommit} (source) → ${destinationCommit} (destination)`);

  try {
    const changedFiles = [];
    let pageCount = 0;
    let nextToken;
    
    do {
      pageCount++;
      console.log(`\n🔎 [PAGE ${pageCount}] Fetching differences...`);
      console.log(`    Using nextToken: ${nextToken || 'None (first page)'}`);
      
      const response = await client.send(
        new GetDifferencesCommand({
          repositoryName,
          beforeCommitSpecifier: destinationCommit,
          afterCommitSpecifier: sourceCommit,
          nextToken,
        })
      );

      console.log(`    Found ${response.differences?.length || 0} differences in this page`);
      
      response.differences?.forEach((diff, index) => {
        console.log(`    [DIFF ${index + 1}] Type: ${diff.changeType}, File: ${diff.afterBlob?.path || diff.beforeBlob?.path}`);
        
        if (diff.afterBlob?.path && diff.changeType !== "D") {
          changedFiles.push({
            filename: diff.afterBlob.path,
            beforeBlobId: diff.beforeBlob?.blobId,
            afterBlobId: diff.afterBlob.blobId,
          });
          console.log(`      ✅ Added to analysis queue`);
        } else {
          console.log(`      ⏩ Skipped (${!diff.afterBlob?.path ? 'no path' : 'deleted file'})`);
        }
      });

      nextToken = response.nextToken;
      console.log(`    Next token for pagination: ${nextToken || 'None (last page)'}`);
    } while (nextToken);

    console.log(`\n📊 [SUMMARY] Found ${changedFiles.length} changed files to analyze:`);
    changedFiles.forEach((file, i) => console.log(`    ${i + 1}. ${file.filename}`));

    for (const [index, file] of changedFiles.entries()) {
      console.log(`\n🔍 [FILE ${index + 1}/${changedFiles.length}] Analyzing ${file.filename}`);
      console.log(`    Before blob: ${file.beforeBlobId || 'None (new file)'}`);
      console.log(`    After blob: ${file.afterBlobId}`);
      
      try {
        const patch = await getPatchDiff(repositoryName, file.beforeBlobId, file.afterBlobId);
        
        if (patch) {
          console.log(`    Generated patch (${patch.split('\n').length} lines):\n${'='.repeat(40)}`);
          console.log(patch.substring(0, 500) + (patch.length > 500 ? '...' : '')); // Log first 500 chars
          console.log(`${'='.repeat(40)}`);
          
          console.log(`    🤖 Sending to AI for analysis...`);
          const suggestions = await analyzeDiffWithAI(patch, file.filename);
          
          console.log(`    💡 AI Suggestions:\n${'~'.repeat(40)}`);
          console.log(suggestions);
          console.log(`${'~'.repeat(40)}`);
        } else {
          console.log(`    ⏩ No meaningful changes to analyze`);
        }
      } catch (fileErr) {
        console.error(`    ❌ Error processing file:`, fileErr.message);
      }
    }

    console.log(`\n✅ [COMPLETE] Finished processing PR #${pullRequestId}`);
  } catch (err) {
    console.error(`❌ [ERROR] Processing PR #${pullRequestId}:`);
    console.error(err.stack || err.message);
    throw err;
  }
}

async function getPatchDiff(repositoryName, beforeBlobId, afterBlobId) {
  console.log(`    🛠️ Generating diff between blobs...`);
  
  if (!beforeBlobId || !afterBlobId || beforeBlobId === afterBlobId) {
    console.log(`    ⏩ No diff needed (${!beforeBlobId ? 'new file' : 'no changes'})`);
    return null;
  }

  console.log(`    Fetching before blob (${beforeBlobId})...`);
  const before = await client.send(new GetBlobCommand({ repositoryName, blobId: beforeBlobId }));
  console.log(`    Fetched ${before.content.length} bytes`);
  
  console.log(`    Fetching after blob (${afterBlobId})...`);
  const after = await client.send(new GetBlobCommand({ repositoryName, blobId: afterBlobId }));
  console.log(`    Fetched ${after.content.length} bytes`);

  const beforeContent = Buffer.from(before.content).toString("utf8");
  const afterContent = Buffer.from(after.content).toString("utf8");
  
  console.log(`    Before: ${beforeContent.split('\n').length} lines`);
  console.log(`    After: ${afterContent.split('\n').length} lines`);

  return generateUnifiedDiff(beforeContent, afterContent);
}

function generateUnifiedDiff(oldStr, newStr) {
  console.log(`    Generating unified diff...`);
  
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const patchLines = [];
  let changesCount = 0;

  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const oldLine = oldLines[i] || "";
    const newLine = newLines[i] || "";
    
    if (oldLine !== newLine) {
      patchLines.push(`- ${oldLine}`);
      patchLines.push(`+ ${newLine}`);
      changesCount++;
    }
  }

  console.log(`    Found ${changesCount} changed lines`);
  return patchLines.join("\n");
}
