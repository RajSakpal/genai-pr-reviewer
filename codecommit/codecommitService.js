import { CodeCommitClient, GetDifferencesCommand } from "@aws-sdk/client-codecommit";
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
 * Main function to process a CodeCommit Pull Request and log changes
 * 
 * @param {Object} params - Pull request details
 * @param {string} params.repositoryName - Name of the CodeCommit repository
 * @param {string} params.pullRequestId - Unique identifier for the pull request
 * @param {string} params.sourceCommit - Commit SHA of the source branch (feature branch)
 * @param {string} params.destinationCommit - Commit SHA of the destination branch (target branch)
 * @param {string} params.sourceBranch - Source branch name
 * @param {string} params.destinationBranch - Destination branch name
 */
export async function processCodeCommitPullRequest({ 
  repositoryName, 
  pullRequestId, 
  sourceCommit, 
  destinationCommit,
  sourceBranch,
  destinationBranch 
}) {
  console.log(`📥 [START] Processing PR #${pullRequestId} in repo ${repositoryName}`);
  console.log(`    Source Branch: ${sourceBranch || 'unknown'} (${sourceCommit})`);
  console.log(`    Destination Branch: ${destinationBranch || 'unknown'} (${destinationCommit})`);

  try {
    const changedFiles = []; // Store files that were changed
    const newFiles = [];     // Store files that were added
    let pageCount = 0;       // Track pagination for debugging
    let nextToken;           // AWS pagination token
    
    // Paginate through all differences (AWS limits results per page)
    do {
      pageCount++;
      console.log(`\n🔎 [PAGE ${pageCount}] Fetching differences...`);
      
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
        const filePath = diff.afterBlob?.path || diff.beforeBlob?.path;
        
        console.log(`\n    [DIFF ${index + 1}]`);
        console.log(`      File: ${filePath}`);
        console.log(`      Change Type: ${getChangeTypeLabel(diff.changeType)}`);
        console.log(`      Before Blob: ${diff.beforeBlob?.blobId || 'None (new file)'}`);
        console.log(`      After Blob: ${diff.afterBlob?.blobId || 'None (deleted file)'}`);
        
        // Categorize the changes
        if (diff.changeType === "A") {
          // New file added
          newFiles.push({
            filename: filePath,
            changeType: diff.changeType,
            blobId: diff.afterBlob?.blobId
          });
          console.log(`      ✨ Added to NEW FILES list`);
        } else if (diff.changeType === "M") {
          // File modified
          changedFiles.push({
            filename: filePath,
            changeType: diff.changeType,
            beforeBlobId: diff.beforeBlob?.blobId,
            afterBlobId: diff.afterBlob?.blobId
          });
          console.log(`      🔄 Added to MODIFIED FILES list`);
        } else if (diff.changeType === "D") {
          console.log(`      🗑️ File deleted - logged but not tracked for analysis`);
        }
      });

      nextToken = response.nextToken;
    } while (nextToken); // Continue until all pages are fetched

    // Log comprehensive summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 PULL REQUEST SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Repository: ${repositoryName}`);
    console.log(`Pull Request ID: ${pullRequestId}`);
    console.log(`Source: ${sourceBranch || 'unknown'} → Destination: ${destinationBranch || 'unknown'}`);
    console.log(`Total Changes: ${newFiles.length + changedFiles.length} files`);
    
    // Log new files
    if (newFiles.length > 0) {
      console.log(`\n✨ NEW FILES (${newFiles.length}):`);
      newFiles.forEach((file, i) => {
        console.log(`    ${i + 1}. ${file.filename}`);
        console.log(`       └── Blob ID: ${file.blobId}`);
      });
    } else {
      console.log(`\n✨ NEW FILES: None`);
    }

    // Log modified files
    if (changedFiles.length > 0) {
      console.log(`\n🔄 MODIFIED FILES (${changedFiles.length}):`);
      changedFiles.forEach((file, i) => {
        console.log(`    ${i + 1}. ${file.filename}`);
        console.log(`       ├── Before: ${file.beforeBlobId}`);
        console.log(`       └── After:  ${file.afterBlobId}`);
      });
    } else {
      console.log(`\n🔄 MODIFIED FILES: None`);
    }

    console.log(`\n✅ [COMPLETE] Successfully logged all changes for PR #${pullRequestId}`);
    
    // Return summary data for further processing if needed
    return {
      pullRequestId,
      repositoryName,
      sourceBranch,
      destinationBranch,
      summary: {
        totalFiles: newFiles.length + changedFiles.length,
        newFiles: newFiles.length,
        modifiedFiles: changedFiles.length
      },
      newFiles,
      changedFiles
    };

  } catch (err) {
    console.error(`❌ [ERROR] Processing PR #${pullRequestId}:`);
    console.error(`Error Type: ${err.name}`);
    console.error(`Error Message: ${err.message}`);
    if (err.code) {
      console.error(`AWS Error Code: ${err.code}`);
    }
    console.error(`Stack Trace: ${err.stack}`);
    throw err;
  }
}

/**
 * Helper function to get human-readable change type labels
 * @param {string} changeType - AWS CodeCommit change type (A, M, D)
 * @returns {string} - Human readable label
 */
function getChangeTypeLabel(changeType) {
  switch (changeType) {
    case 'A':
      return 'ADDED (New File)';
    case 'M':
      return 'MODIFIED (Changed File)';
    case 'D':
      return 'DELETED (Removed File)';
    default:
      return `UNKNOWN (${changeType})`;
  }
}