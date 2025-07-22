import { CodeCommitClient, GetDifferencesCommand, GetBlobCommand } from "@aws-sdk/client-codecommit";
import { analyzeDiffWithAI } from "../agents/langchainAgent.js";
import dotenv from "dotenv";

dotenv.config();

/**
 * Configure AWS CodeCommit client with region and credentials
 * Uses environment variables for authentication with fallback to IAM roles
 */
const clientConfig = {
  region: process.env.AWS_REGION || "ap-south-1"
};

// Add explicit credentials if provided (useful for local development)
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  clientConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    // Include session token for temporary credentials (STS/AssumeRole)
    ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN })
  };
}

const client = new CodeCommitClient(clientConfig);

/**
 * Main function to process a CodeCommit Pull Request for AI analysis
 * 
 * @param {Object} params - Pull request details
 * @param {string} params.repositoryName - Name of the CodeCommit repository
 * @param {string} params.pullRequestId - Unique identifier for the pull request
 * @param {string} params.sourceCommit - Commit SHA of the source branch (feature branch)
 * @param {string} params.destinationCommit - Commit SHA of the destination branch (target branch)
 * 
 * Flow:
 * 1. Fetch all differences between source and destination commits
 * 2. Filter files that need analysis (exclude deleted files)
 * 3. Generate patches/diffs for each changed file
 * 4. Send patches to AI for code review analysis
 */
export async function processCodeCommitPullRequest({ repositoryName, pullRequestId, sourceCommit, destinationCommit }) {
  console.log(`📥 [START] Processing PR #${pullRequestId} in repo ${repositoryName}`);
  console.log(`    Comparing commits: ${sourceCommit} (source) → ${destinationCommit} (destination)`);

  try {
    const changedFiles = []; // Store files that need AI analysis
    let pageCount = 0;       // Track pagination for debugging
    let nextToken;           // AWS pagination token
    
    // Paginate through all differences (AWS limits results per page)
    do {
      pageCount++;
      console.log(`\n🔎 [PAGE ${pageCount}] Fetching differences...`);
      console.log(`    Using nextToken: ${nextToken || 'None (first page)'}`);
      
      // Get differences between commits using AWS CodeCommit API
      const response = await client.send(
        new GetDifferencesCommand({
          repositoryName,
          beforeCommitSpecifier: destinationCommit, // What we're comparing FROM
          afterCommitSpecifier: sourceCommit,       // What we're comparing TO
          nextToken, // For pagination
        })
      );

      console.log(`    Found ${response.differences?.length || 0} differences in this page`);
      
      // Process each file difference in this page
      response.differences?.forEach((diff, index) => {
        console.log(`    [DIFF ${index + 1}] Type: ${diff.changeType}, File: ${diff.afterBlob?.path || diff.beforeBlob?.path}`);
        
        // Filter files for analysis:
        // - Include: Added (A) and Modified (M) files
        // - Exclude: Deleted (D) files (no content to analyze)
        if (diff.changeType !== "D") {
          const filePath = diff.afterBlob?.path || diff.beforeBlob?.path;
          if (filePath) {
            changedFiles.push({
              filename: filePath,
              beforeBlobId: diff.beforeBlob?.blobId, // null for new files
              afterBlobId: diff.afterBlob?.blobId,   // null for deleted files
              changeType: diff.changeType, // A=Added, M=Modified, D=Deleted
            });
            console.log(`      ✅ Added to analysis queue (${diff.changeType === 'A' ? 'new file' : 'modified file'})`);
          }
        } else {
          console.log(`      ⏩ Skipped (deleted file)`);
        }
      });

      nextToken = response.nextToken;
      console.log(`    Next token for pagination: ${nextToken || 'None (last page)'}`);
    } while (nextToken); // Continue until all pages are fetched

    // Log summary of files found for analysis
    console.log(`\n📊 [SUMMARY] Found ${changedFiles.length} changed files to analyze:`);
    changedFiles.forEach((file, i) => {
      const typeLabel = file.changeType === 'A' ? '(NEW)' : '(MODIFIED)';
      console.log(`    ${i + 1}. ${file.filename} ${typeLabel}`);
    });

    // Process each file sequentially for AI analysis
    for (const [index, file] of changedFiles.entries()) {
      console.log(`\n🔍 [FILE ${index + 1}/${changedFiles.length}] Analyzing ${file.filename}`);
      console.log(`    Change type: ${file.changeType}`);
      console.log(`    Before blob: ${file.beforeBlobId || 'None (new file)'}`);
      console.log(`    After blob: ${file.afterBlobId}`);
      
      try {
        // Generate patch/diff for this file
        const patch = await getPatchDiff(repositoryName, file.beforeBlobId, file.afterBlobId, file.changeType);
        
        if (patch) {
          // Log preview of generated patch for debugging
          console.log(`    Generated patch (${patch.split('\n').length} lines):\n${'='.repeat(40)}`);
          console.log(patch.substring(0, 500) + (patch.length > 500 ? '...' : '')); // Log first 500 chars
          console.log(`${'='.repeat(40)}`);
          
          // Send patch to AI for analysis
          console.log(`    🤖 Sending to AI for analysis...`);
          const suggestions = await analyzeDiffWithAI(patch, file.filename, file.changeType);
          
          // Display AI suggestions
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

/**
 * Generate a patch/diff for a single file by comparing before and after blob content
 * Handles three scenarios:
 * 1. New files (A) - Show entire content as additions
 * 2. Modified files (M) - Show traditional diff with removed/added lines
 * 3. No changes - Return null
 * 
 * @param {string} repositoryName - CodeCommit repository name
 * @param {string} beforeBlobId - Blob ID before changes (null for new files)
 * @param {string} afterBlobId - Blob ID after changes (null for deleted files)
 * @param {string} changeType - Type of change (A=Added, M=Modified, D=Deleted)
 * @returns {Promise<string|null>} - Generated patch or null if no changes
 */
async function getPatchDiff(repositoryName, beforeBlobId, afterBlobId, changeType) {
  console.log(`    🛠️ Generating diff for ${changeType} file...`);
  
  // SCENARIO 1: New file added (changeType 'A')
  // beforeBlobId is null, afterBlobId contains the new file content
  if (changeType === 'A' && !beforeBlobId && afterBlobId) {
    console.log(`    📝 Processing new file...`);
    console.log(`    Fetching new file content (${afterBlobId})...`);
    
    const after = await client.send(new GetBlobCommand({ repositoryName, blobId: afterBlobId }));
    const afterContent = Buffer.from(after.content).toString("utf8");
    
    console.log(`    New file: ${afterContent.split('\n').length} lines`);
    
    // For new files, show all content as additions (prefixed with '+')
    const lines = afterContent.split('\n');
    const patchLines = lines.map(line => `+ ${line}`);
    
    console.log(`    Generated patch for new file (${patchLines.length} lines)`);
    return patchLines.join('\n');
  }
  
  // SCENARIO 2: Modified file (changeType 'M')
  // Both beforeBlobId and afterBlobId exist and are different
  if (beforeBlobId && afterBlobId && beforeBlobId !== afterBlobId) {
    console.log(`    📝 Processing modified file...`);
    console.log(`    Fetching before blob (${beforeBlobId})...`);
    const before = await client.send(new GetBlobCommand({ repositoryName, blobId: beforeBlobId }));
    console.log(`    Fetched ${before.content.length} bytes`);
    
    console.log(`    Fetching after blob (${afterBlobId})...`);
    const after = await client.send(new GetBlobCommand({ repositoryName, blobId: afterBlobId }));
    console.log(`    Fetched ${after.content.length} bytes`);

    // Convert blob content from Buffer to UTF-8 strings
    const beforeContent = Buffer.from(before.content).toString("utf8");
    const afterContent = Buffer.from(after.content).toString("utf8");
    
    console.log(`    Before: ${beforeContent.split('\n').length} lines`);
    console.log(`    After: ${afterContent.split('\n').length} lines`);

    // Generate unified diff showing changes
    return generateUnifiedDiff(beforeContent, afterContent);
  }
  
  // SCENARIO 3: No meaningful changes or edge cases
  console.log(`    ⏩ No diff needed (no changes detected)`);
  return null;
}

/**
 * Generate a unified diff between two versions of file content
 * Creates a simple line-by-line comparison showing:
 * - Lines removed from old version (prefixed with '-')
 * - Lines added to new version (prefixed with '+')
 * 
 * Note: This is a basic implementation. For production use, consider
 * using a proper diff algorithm like Myers' algorithm for better
 * context and more accurate change detection.
 * 
 * @param {string} oldStr - Original file content
 * @param {string} newStr - Modified file content
 * @returns {string} - Unified diff format string
 */
function generateUnifiedDiff(oldStr, newStr) {
  console.log(`    Generating unified diff...`);
  
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const patchLines = [];
  let changesCount = 0;

  // Simple line-by-line comparison
  // NOTE: This doesn't handle moved blocks or context lines like git diff
  const maxLines = Math.max(oldLines.length, newLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    
    if (oldLine !== undefined && newLine !== undefined) {
      // Both lines exist - compare them
      if (oldLine !== newLine) {
        patchLines.push(`- ${oldLine}`);  // Show what was removed
        patchLines.push(`+ ${newLine}`);  // Show what was added
        changesCount++;
      }
      // If lines are identical, we skip them (no context lines in this simple implementation)
    } else if (oldLine !== undefined) {
      // Line was removed (exists in old but not new)
      patchLines.push(`- ${oldLine}`);
      changesCount++;
    } else if (newLine !== undefined) {
      // Line was added (exists in new but not old)
      patchLines.push(`+ ${newLine}`);
      changesCount++;
    }
  }

  console.log(`    Found ${changesCount} changed lines`);
  return patchLines.join("\n");
}