import { CodeCommitClient, GetDifferencesCommand, GetBlobCommand } from "@aws-sdk/client-codecommit";
import { isCommentingEnabled } from "../utils/codecommitComments.js";
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

// Export client for use in comment service
export { client };

/**
 * Fetch blob content from AWS CodeCommit
 * @param {string} repositoryName - Name of the repository
 * @param {string} blobId - Blob identifier
 * @returns {Promise<string>} - File content as string
 */
export async function getBlobContent(repositoryName, blobId) {
  try {
    const response = await client.send(
      new GetBlobCommand({
        repositoryName,
        blobId
      })
    );
    
    // Convert blob content to string
    const content = Buffer.from(response.content).toString('utf-8');
    return content;
  } catch (error) {
    console.error(`❌ Failed to fetch blob ${blobId}:`, error.message);
    throw error;
  }
}

/**
 * Main function to process a CodeCommit Pull Request and perform context-aware AI analysis with comments
 */
export async function processCodeCommitPullRequest({ 
  repositoryName, 
  pullRequestId, 
  sourceCommit, 
  destinationCommit,
  sourceBranch,
  destinationBranch 
}) {
  console.log(`📥 Processing PR #${pullRequestId} in ${repositoryName}`);
  console.log(`   ${sourceBranch || 'unknown'} → ${destinationBranch || 'unknown'}`);
  
  try {
    const changedFiles = [];
    const newFiles = [];
    const deletedFiles = [];
    let nextToken;
    let totalDifferences = 0;
    
    // Fetch all differences with pagination
    do {
      const response = await client.send(
        new GetDifferencesCommand({
          repositoryName,
          beforeCommitSpecifier: destinationCommit,
          afterCommitSpecifier: sourceCommit,
          nextToken,
        })
      );

      totalDifferences += response.differences?.length || 0;

      response.differences?.forEach((diff) => {
        const filePath = diff.afterBlob?.path || diff.beforeBlob?.path;
        
        if (diff.changeType === "A") {
          newFiles.push({
            filename: filePath,
            changeType: diff.changeType,
            blobId: diff.afterBlob?.blobId
          });
        } else if (diff.changeType === "M") {
          changedFiles.push({
            filename: filePath,
            changeType: diff.changeType,
            beforeBlobId: diff.beforeBlob?.blobId,
            afterBlobId: diff.afterBlob?.blobId
          });
        } else if (diff.changeType === "D") {
          deletedFiles.push({
            filename: filePath,
            changeType: diff.changeType,
            beforeBlobId: diff.beforeBlob?.blobId
          });
        }
      });

      nextToken = response.nextToken;
    } while (nextToken);

    // Log summary
    console.log(`📊 Found ${totalDifferences} file changes:`);
    console.log(`   ✨ ${newFiles.length} new, 🔄 ${changedFiles.length} modified, 🗑️ ${deletedFiles.length} deleted`);

    // Early exit if no analyzable files
    const allAnalyzableFiles = [...newFiles, ...changedFiles];
    if (allAnalyzableFiles.length === 0) {
      console.log(`⚠️ No files to analyze (only deletions)`);
      return {
        pullRequestId,
        repositoryName,
        sourceBranch,
        destinationBranch,
        sourceCommit,
        destinationCommit,
        summary: {
          totalFiles: deletedFiles.length,
          newFiles: 0,
          modifiedFiles: 0,
          deletedFiles: deletedFiles.length,
          analyzedFiles: 0,
          successfulAnalyses: 0,
          failedAnalyses: 0,
          contextualAnalyses: 0,
          totalContextChunks: 0,
          commentsPosted: 0,
          commentsFailed: 0
        },
        newFiles: [],
        changedFiles: [],
        deletedFiles,
        aiAnalysis: [],
        processedAt: new Date().toISOString()
      };
    }

    // Start AI Analysis
    console.log(`🤖 Starting AI analysis of ${allAnalyzableFiles.length} files...`);
    
    const contextBranch = destinationBranch?.replace('refs/heads/', '') || 'main';
    
    // Prepare PR info for commenting with both commit IDs
    const pullRequestInfo = isCommentingEnabled() ? {
      pullRequestId: pullRequestId,
      beforeCommitId: destinationCommit, // The base commit
      afterCommitId: sourceCommit,       // The new commit
      repositoryName: repositoryName
    } : null;

    if (pullRequestInfo) {
      console.log(`💬 AI analysis comments will be posted to Changes tab for PR #${pullRequestId}`);
    } else {
      console.log(`⚠️ Comment posting disabled`);
    }
    
    // Dynamic import to avoid circular dependencies
    const { analyzeFilesInBatches } = await import('../analyzePR.js');
    
    const analysisResults = await analyzeFilesInBatches(
      allAnalyzableFiles, 
      repositoryName, 
      contextBranch, 
      2,
      pullRequestInfo // Pass PR info for commenting
    );

    // Calculate comment statistics
    const commentStats = analysisResults.reduce((stats, result) => {
      if (result.reviewComment && result.reviewComment.success) {
        stats.successful++;
      } else if (result.reviewComment && result.reviewComment.error && 
                 result.reviewComment.error !== 'No PR info provided' && 
                 result.reviewComment.error !== 'Commenting disabled' &&
                 result.reviewComment.error !== 'File skipped') {
        stats.failed++;
      }
      return stats;
    }, { successful: 0, failed: 0 });

    // Calculate statistics
    const contextStats = analysisResults.reduce((stats, result) => {
      if (result.success && result.context && result.context.hasContext) {
        stats.withContext++;
        stats.totalContextChunks += result.context.contextChunksCount || 0;
        stats.totalRelatedFiles += result.context.relatedFiles?.length || 0;
      }
      return stats;
    }, { withContext: 0, totalContextChunks: 0, totalRelatedFiles: 0 });

    const successfulAnalyses = analysisResults.filter(r => r.success).length;
    const failedAnalyses = analysisResults.filter(r => r.error).length;
    const totalAnalysisTime = analysisResults.reduce((total, r) => total + (r.analysisTime || 0), 0);

    // Final summary
    console.log(`\n✅ Analysis Complete:`);
    console.log(`   📈 ${successfulAnalyses}/${analysisResults.length} successful analyses`);
    console.log(`   🔗 ${contextStats.withContext} files with context (${contextStats.totalContextChunks} chunks)`);
    console.log(`   💬 ${commentStats.successful} comments posted to Changes tab`);
    if (commentStats.failed > 0) {
      console.log(`   ⚠️ ${commentStats.failed} comments failed`);
    }
    console.log(`   ⏱️ Total time: ${totalAnalysisTime}ms (avg: ${successfulAnalyses > 0 ? Math.round(totalAnalysisTime / successfulAnalyses) : 0}ms/file)`);

    // Log failed analyses if any
    if (failedAnalyses > 0) {
      const failedFiles = analysisResults.filter(r => r.error).map(r => r.filename);
      console.log(`   ⚠️ Failed to analyze: ${failedFiles.join(', ')}`);
    }
    
    return {
      pullRequestId,
      repositoryName,
      sourceBranch,
      destinationBranch,
      sourceCommit,
      destinationCommit,
      contextBranch,
      summary: {
        totalFiles: newFiles.length + changedFiles.length + deletedFiles.length,
        newFiles: newFiles.length,
        modifiedFiles: changedFiles.length,
        deletedFiles: deletedFiles.length,
        analyzedFiles: analysisResults.length,
        successfulAnalyses: successfulAnalyses,
        failedAnalyses: failedAnalyses,
        contextualAnalyses: contextStats.withContext,
        totalContextChunks: contextStats.totalContextChunks,
        totalRelatedFiles: contextStats.totalRelatedFiles,
        totalAnalysisTime: totalAnalysisTime,
        averageAnalysisTime: successfulAnalyses > 0 ? Math.round(totalAnalysisTime / successfulAnalyses) : 0,
        commentsPosted: commentStats.successful,
        commentsFailed: commentStats.failed
      },
      newFiles,
      changedFiles,
      deletedFiles,
      aiAnalysis: analysisResults,
      processedAt: new Date().toISOString()
    };

  } catch (err) {
    console.error(`❌ Error processing PR #${pullRequestId}: ${err.message}`);
    throw err;
  }
}

/**
 * Save analysis results to file system
 */
export async function saveAnalysisResults(pullRequestData) {
  try {
    const fs = await import('fs/promises');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `pr-analysis-${pullRequestData.repositoryName}-${pullRequestData.pullRequestId}-${timestamp}.json`;
    
    const cleanData = {
      ...pullRequestData,
      aiAnalysis: pullRequestData.aiAnalysis.map(analysis => ({
        ...analysis,
        errorDetails: analysis.errorDetails ? {
          name: analysis.errorDetails.name,
          message: analysis.errorDetails.message
        } : undefined
      }))
    };
    
    await fs.writeFile(filename, JSON.stringify(cleanData, null, 2));
    console.log(`📁 Analysis saved: ${filename}`);
    
    return filename;
  } catch (error) {
    console.error('❌ Failed to save analysis:', error.message);
    throw error;
  }
}

/**
 * Get summary statistics from analysis results
 */
export function getAnalysisSummary(analysisData) {
  const { aiAnalysis = [], summary = {} } = analysisData;
  
  const byChangeType = aiAnalysis.reduce((counts, analysis) => {
    const type = analysis.changeType || 'UNKNOWN';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  
  const contextStats = aiAnalysis.reduce((stats, analysis) => {
    if (analysis.success && analysis.context?.hasContext) {
      stats.withContext++;
    } else if (analysis.success) {
      stats.withoutContext++;
    }
    return stats;
  }, { withContext: 0, withoutContext: 0 });
  
  const topContextFiles = aiAnalysis
    .filter(a => a.success && a.context?.hasContext)
    .sort((a, b) => (b.context?.contextChunksCount || 0) - (a.context?.contextChunksCount || 0))
    .slice(0, 5)
    .map(a => ({
      filename: a.filename,
      contextChunks: a.context?.contextChunksCount || 0,
      relatedFiles: a.context?.relatedFiles?.length || 0
    }));
  
  return {
    overview: summary,
    byChangeType,
    contextStats,
    topContextFiles,
    generatedAt: new Date().toISOString()
  };
}
