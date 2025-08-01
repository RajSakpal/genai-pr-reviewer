import dotenv from "dotenv";
import { getBlobContent } from "./codecommit/codecommitService.js";
import { getRelevantContext, formatContextForPrompt } from "./utils/qdrantKnowledgeBase.js";
import { HybridAIClient } from "./utils/HybridAIClient.js";
import { detectLanguage } from "./utils/languageDetector.js";
import { 
  analyzeSpecificChanges, 
  generateDiffSummary, 
  shouldUseContext, 
  generateContextAwarePromptAddition 
} from "./utils/changeAnalyzer.js";
import { modifiedFileTemplate, newFileTemplate } from "./templates/promptTemplates.js";
import { postAIAnalysisComment, postLineSpecificIssues, isCommentingEnabled } from "./utils/codecommitComments.js";

dotenv.config();

// Initialize Hybrid AI client
const aiClient = new HybridAIClient();

// Simple startup log without health check
console.log(`✅ AI Client initialized:`);
console.log(`   🌟 Gemini: Primary provider`);
console.log(`   🤖 Ollama: Fallback provider`);
console.log(`   🔄 Auto-switching enabled`);

/**
 * Helper function to format AI response for logging (truncated version)
 */
function formatAIResponseForLog(analysis, filename) {
  const maxLength = 300;
  const separator = "─".repeat(60);
  
  let formatted = `\n${separator}\n`;
  formatted += `📝 AI REVIEW SUMMARY FOR: ${filename}\n`;
  formatted += `${separator}\n`;
  
  if (analysis.length > maxLength) {
    formatted += analysis.substring(0, maxLength) + "...\n";
    formatted += `[Truncated - Full response: ${analysis.length} characters - see complete analysis above]\n`;
  } else {
    formatted += analysis + "\n";
  }
  
  formatted += `${separator}`;
  return formatted;
}

/**
 * Log complete AI response with enhanced formatting
 */
function logCompleteAIResponse(response, filename) {
  const showFullResponse = process.env.LOG_FULL_AI_RESPONSE !== 'false'; // Default to true
  
  if (showFullResponse) {
    console.log(`\n${'='.repeat(100)}`);
    console.log(`🤖 COMPLETE AI ANALYSIS FOR: ${filename}`);
    console.log(`${'='.repeat(100)}`);
    console.log(`AI Provider: ${response.provider || 'unknown'}`);
    console.log(`Model: ${response.model || 'unknown'}`);
    console.log(`Response Length: ${response.content.length} characters`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`${'='.repeat(100)}`);
    console.log(response.content);
    console.log(`${'='.repeat(100)}\n`);
  }
}

/**
 * Save complete AI response to file (optional)
 */
async function saveCompleteAIResponse(response, filename, pullRequestId) {
  if (process.env.SAVE_AI_RESPONSES !== 'true') {
    return;
  }
  
  try {
    const fs = await import('fs/promises');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeFilename = filename.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    const responseFilename = `ai-response-${pullRequestId || 'unknown'}-${safeFilename}-${timestamp}.txt`;
    
    const content = `AI Analysis Response
====================
File: ${filename}
Provider: ${response.provider || 'unknown'}
Model: ${response.model || 'unknown'}
Timestamp: ${new Date().toISOString()}
Response Length: ${response.content.length} characters

Analysis:
${response.content}
`;
    
    await fs.writeFile(responseFilename, content);
    console.log(`📄 Complete AI response saved: ${responseFilename}`);
  } catch (error) {
    console.error('❌ Failed to save AI response:', error.message);
  }
}

/**
 * Helper function to extract key findings from AI response
 */
function extractKeyFindings(analysis) {
  const findings = {
    whatChanged: [],
    securityIssues: [],
    codeQuality: [],
    logicIssues: [],
    performance: [],
    suggestions: []
  };
  
  try {
    const lines = analysis.split('\n');
    let currentSection = '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.includes('What Changed') || trimmed.includes('Changed')) {
        currentSection = 'whatChanged';
      } else if (trimmed.includes('Security') || trimmed.includes('SECURITY')) {
        currentSection = 'securityIssues';
      } else if (trimmed.includes('Quality') || trimmed.includes('QUALITY')) {
        currentSection = 'codeQuality';
      } else if (trimmed.includes('Logic') || trimmed.includes('LOGIC')) {
        currentSection = 'logicIssues';
      } else if (trimmed.includes('Performance') || trimmed.includes('PERFORMANCE')) {
        currentSection = 'performance';
      } else if (trimmed.includes('Suggestion') || trimmed.includes('SUGGESTION')) {
        currentSection = 'suggestions';
      } else if (trimmed.length > 10 && currentSection && !trimmed.startsWith('**')) {
        findings[currentSection].push(trimmed);
      }
    }
  } catch (error) {
    console.warn(`⚠️ Failed to extract findings: ${error.message}`);
  }
  
  return findings;
}

/**
 * Enhanced analyze function with hybrid AI support and line-specific issue commenting
 */
export async function analyzeFileWithAI(fileData, repositoryName, branchName = 'main', pullRequestInfo = null) {
  const startTime = Date.now();
  let beforeContent = null;
  let afterContent = null;
  
  try {
    // Skip certain file types
    const skipPatterns = [
      /\.idea\//,           // IntelliJ IDEA files
      /\.vscode\//,         // VS Code files
      /\.git\//,            // Git files
      /node_modules\//,     // Node modules
      /\.log$/,             // Log files
      /\.tmp$/,             // Temp files
      /\.cache$/,           // Cache files
      /\.(png|jpg|jpeg|gif|svg|ico)$/i, // Image files
      /\.(pdf|doc|docx)$/i, // Document files
    ];
    
    const shouldSkip = skipPatterns.some(pattern => pattern.test(fileData.filename));
    if (shouldSkip) {
      console.log(`   ⏭️ ${fileData.filename}: Skipped (non-code file)`);
      return {
        filename: fileData.filename,
        changeType: fileData.changeType,
        analysis: "Analysis skipped: Non-code file (not relevant for code review)",
        context: { hasContext: false, relatedFiles: [], contextChunksCount: 0, summary: "File type skipped." },
        reviewComment: { success: false, error: 'File skipped' },
        analysisTime: Date.now() - startTime,
        error: false,
        skipped: true,
        timestamp: new Date().toISOString(),
        success: true
      };
    }

    // Detect language
    const language = detectLanguage(fileData.filename);
    console.log(`   🔍 Starting ${language} analysis for ${fileData.filename} (${fileData.changeType})...`);

    let prompt;
    let fileContent;
    let context = { hasContext: false, contextChunks: [], relatedFiles: [], summary: "No context available." };
    let diffSummary = '';
    let useContext = false;
    
    if (fileData.changeType === 'A') {
      // Handle new file
      if (!fileData.blobId) {
        throw new Error('Missing blobId for new file');
      }
      
      console.log(`      📖 Reading new file content...`);
      fileContent = await getBlobContent(repositoryName, fileData.blobId);
      afterContent = fileContent; // Store for commenting
      
      console.log(`      🧠 Fetching context for new file...`);
      context = await getRelevantContext(repositoryName, branchName, fileData.filename, fileContent, 5);
      useContext = true;
      
      const contextSection = formatContextForPrompt(context);
      
      prompt = await newFileTemplate.format({
        filename: fileData.filename,
        content: fileContent,
        contextSection: contextSection,
        language: language
      });
      
    } else if (fileData.changeType === 'M') {
      // Handle modified file
      if (!fileData.beforeBlobId || !fileData.afterBlobId) {
        throw new Error('Missing blob IDs for modified file');
      }
      
      console.log(`      📖 Reading before/after content...`);
      [beforeContent, afterContent] = await Promise.all([
        getBlobContent(repositoryName, fileData.beforeBlobId),
        getBlobContent(repositoryName, fileData.afterBlobId)
      ]);
      
      // Analyze specific changes
      const specificChanges = analyzeSpecificChanges(beforeContent, afterContent, fileData.filename);
      diffSummary = generateDiffSummary(specificChanges);
      
      // Intelligent context decision
      useContext = shouldUseContext(specificChanges, fileData.filename);
      
      console.log(`      🔍 Detected ${language} changes: ${diffSummary}`);
      console.log(`      🧠 Context needed: ${useContext ? 'YES' : 'NO'}`);
      
      if (useContext) {
        console.log(`      🔗 Fetching relevant context for integration analysis...`);
        context = await getRelevantContext(repositoryName, branchName, fileData.filename, afterContent, 5);
        
        if (context.hasContext) {
          console.log(`      📚 Found context: ${context.contextChunks.length} chunks from ${context.relatedFiles.length} files`);
        }
      } else {
        console.log(`      🚫 Skipping context - changes don't require integration analysis`);
        context = { hasContext: false, contextChunks: [], relatedFiles: [], summary: "Context skipped - diff-focused analysis." };
      }
      
      fileContent = afterContent;
      
      const contextSection = formatContextForPrompt(context);
      const contextPromptAddition = generateContextAwarePromptAddition(specificChanges);
      const contextAnalysisInstructions = useContext ? 
        "Use the provided context to identify potential integration issues and cross-file dependencies." :
        "Focus purely on the changes in this file as no integration context is needed.";
      
      // Limit content for performance
      const maxContentLength = 3000;
      const truncatedBefore = beforeContent.length > maxContentLength 
        ? beforeContent.substring(0, maxContentLength) + "\n... [truncated for performance]"
        : beforeContent;
      const truncatedAfter = afterContent.length > maxContentLength 
        ? afterContent.substring(0, maxContentLength) + "\n... [truncated for performance]"
        : afterContent;
      
      prompt = await modifiedFileTemplate.format({
        filename: fileData.filename,
        beforeContent: truncatedBefore,
        afterContent: truncatedAfter,
        contextSection: contextSection,
        contextPromptAddition: contextPromptAddition,
        contextAnalysisInstructions: contextAnalysisInstructions,
        language: language
      });
      
    } else {
      throw new Error(`Unsupported change type: ${fileData.changeType}`);
    }

    console.log(`      🤖 Sending to AI (hybrid: Gemini → Ollama)...`);
    
    // Use hybrid AI client
    const response = await aiClient.invoke(prompt, {
      temperature: 0.1,
      top_p: 0.8,
      top_k: 20
    });
    
    const analysisTime = Date.now() - startTime;
    
    // Log the complete AI response (untruncated)
    logCompleteAIResponse(response, fileData.filename);
    
    // Save complete AI response to file if enabled
    await saveCompleteAIResponse(response, fileData.filename, pullRequestInfo?.pullRequestId);
    
    // Extract key findings
    const findings = extractKeyFindings(response.content);
    
    // Log the truncated summary for readability
    console.log(formatAIResponseForLog(response.content, fileData.filename));
    
    // Enhanced logging
    console.log(`\n📊 KEY FINDINGS SUMMARY for ${fileData.filename}:`);
    if (diffSummary) {
      console.log(`   🔄 Changes: ${diffSummary}`);
    }
    if (useContext && context.hasContext) {
      console.log(`   🔗 Integration Context: ${context.contextChunks.length} chunks analyzed`);
    }
    if (findings.whatChanged.length > 0) {
      console.log(`   📋 What Changed: ${findings.whatChanged.length} items identified`);
      findings.whatChanged.slice(0, 2).forEach(change => console.log(`      - ${change}`));
    }
    if (findings.securityIssues.length > 0) {
      console.log(`   🔒 Security Issues: ${findings.securityIssues.length} found`);
      findings.securityIssues.slice(0, 2).forEach(issue => console.log(`      - ${issue}`));
    }
    if (findings.suggestions.length > 0) {
      console.log(`   💡 Suggestions: ${findings.suggestions.length} provided`);
      findings.suggestions.slice(0, 2).forEach(suggestion => console.log(`      - ${suggestion}`));
    }
    
    console.log(`   ✅ ${fileData.filename} completed (${analysisTime}ms, ${response.provider}${context.contextChunks.length ? `, ${context.contextChunks.length} context chunks` : ''})\n`);
    
    const result = {
      filename: fileData.filename,
      changeType: fileData.changeType,
      language: language,
      analysis: response.content,
      keyFindings: findings,
      diffSummary: diffSummary,
      contextUsed: useContext,
      context: {
        hasContext: context.hasContext,
        relatedFiles: context.relatedFiles,
        contextChunksCount: context.contextChunks.length,
        summary: context.summary
      },
      analysisTime: analysisTime,
      timestamp: new Date().toISOString(),
      success: true,
      aiProvider: response.provider,
      model: response.model
    };

    // Post line-specific AI issues if PR info is provided
    if (pullRequestInfo && isCommentingEnabled() && result.success) {
      try {
        console.log(`      💬 Posting line-specific AI issue comments...`);
        
        const commentResults = await postLineSpecificIssues({
          repositoryName,
          pullRequestId: pullRequestInfo.pullRequestId,
          beforeCommitId: pullRequestInfo.beforeCommitId,
          afterCommitId: pullRequestInfo.afterCommitId,
          filePath: fileData.filename,
          aiAnalysis: response.content,
          beforeContent: beforeContent,
          afterContent: afterContent
        });
        
        const successfulComments = commentResults.filter(r => r.success).length;
        console.log(`      ✅ Posted ${successfulComments} line-specific issue comments`);
        
        result.reviewComment = {
          success: successfulComments > 0,
          totalComments: commentResults.length,
          successfulComments: successfulComments,
          commentIds: commentResults.filter(r => r.success).map(r => r.commentId),
          type: 'line-specific-issues'
        };
        
      } catch (commentError) {
        console.error(`      ⚠️ Comment posting failed:`, commentError.message);
        result.reviewComment = {
          success: false,
          error: commentError.message
        };
      }
    } else {
      result.reviewComment = {
        success: false,
        error: !pullRequestInfo ? 'No PR info provided' : 'Commenting disabled'
      };
    }

    return result;
    
  } catch (error) {
    const analysisTime = Date.now() - startTime;
    console.error(`   ❌ ${fileData.filename}: ${error.message} (${analysisTime}ms)`);
    
    return {
      filename: fileData.filename,
      changeType: fileData.changeType,
      analysis: `Analysis failed: ${error.message}`,
      keyFindings: { whatChanged: [], securityIssues: [], codeQuality: [], logicIssues: [], performance: [], suggestions: [] },
      context: { hasContext: false, relatedFiles: [], contextChunksCount: 0, summary: "Context unavailable due to error." },
      reviewComment: { success: false, error: 'Analysis failed' },
      analysisTime: analysisTime,
      error: true,
      errorDetails: {
        name: error.name,
        message: error.message
      },
      timestamp: new Date().toISOString(),
      success: false,
      aiProvider: 'hybrid',
      model: 'unknown'
    };
  }
}

/**
 * Enhanced batch analysis with hybrid AI support and line-specific issue commenting
 */
export async function analyzeFilesInBatches(files, repositoryName, branchName = 'main', batchSize = 1, pullRequestInfo = null) {
  const results = [];
  const totalBatches = Math.ceil(files.length / batchSize);
  
  console.log(`🤖 Starting multi-language analysis of ${files.length} files`);
  console.log(`📋 Files to analyze: ${files.map(f => `${f.filename} (${f.changeType})`).join(', ')}\n`);
  
  if (pullRequestInfo && isCommentingEnabled()) {
    console.log(`💬 Line-specific AI issue comments will be posted to Changes tab for PR #${pullRequestInfo.pullRequestId}`);
  } else {
    console.log(`⚠️ Comment posting disabled`);
  }
  
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    
    console.log(`📦 Batch ${batchNumber}/${totalBatches} - Processing ${batch.length} files:`);
    batch.forEach(file => console.log(`   📄 ${file.filename} (${file.changeType})`));
    
    const batchPromises = batch.map(file => 
      analyzeFileWithAI(file, repositoryName, branchName, pullRequestInfo)
    );
    
    const batchResults = await Promise.allSettled(batchPromises);
    
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const analysisResult = result.value;
        if (analysisResult && typeof analysisResult === 'object') {
          results.push(analysisResult);
        } else {
          console.error(`   ❌ ${batch[index].filename}: Invalid analysis result structure`);
          results.push({
            filename: batch[index].filename,
            changeType: batch[index].changeType,
            analysis: `Analysis returned invalid result structure`,
            keyFindings: { whatChanged: [], securityIssues: [], codeQuality: [], logicIssues: [], performance: [], suggestions: [] },
            context: { hasContext: false, relatedFiles: [], contextChunksCount: 0 },
            reviewComment: { success: false, error: 'Invalid result structure' },
            error: true,
            timestamp: new Date().toISOString(),
            success: false,
            aiProvider: 'hybrid'
          });
        }
      } else {
        console.error(`   ❌ ${batch[index].filename}: Batch processing failed - ${result.reason}`);
        results.push({
          filename: batch[index].filename,
          changeType: batch[index].changeType,
          analysis: `Batch processing failed: ${result.reason}`,
          keyFindings: { whatChanged: [], securityIssues: [], codeQuality: [], logicIssues: [], performance: [], suggestions: [] },
          context: { hasContext: false, relatedFiles: [], contextChunksCount: 0 },
          reviewComment: { success: false, error: 'Batch processing failed' },
          error: true,
          timestamp: new Date().toISOString(),
          success: false,
          aiProvider: 'hybrid'
        });
      }
    });
    
    const batchSuccessful = batchResults.filter(r => r.status === 'fulfilled').length;
    console.log(`📦 Batch ${batchNumber} complete: ${batchSuccessful}/${batch.length} successful\n`);
  }
  
  const successfulAnalyses = results.filter(r => r.success && !r.skipped);
  const skippedAnalyses = results.filter(r => r.skipped);
  const failedAnalyses = results.filter(r => r.error);
  
  // Calculate comment statistics
  const commentStats = results.reduce((stats, result) => {
    if (result.reviewComment && result.reviewComment.success) {
      stats.successful += result.reviewComment.totalComments || 1;
    } else if (result.reviewComment && result.reviewComment.error && 
               result.reviewComment.error !== 'No PR info provided' && 
               result.reviewComment.error !== 'Commenting disabled' &&
               result.reviewComment.error !== 'File skipped') {
      stats.failed++;
    }
    return stats;
  }, { successful: 0, failed: 0 });
  
  // Enhanced final summary with language breakdown and AI provider stats
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 FINAL MULTI-LANGUAGE ANALYSIS SUMMARY`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Total Files: ${results.length}`);
  console.log(`✅ Successful: ${successfulAnalyses.length}`);
  console.log(`⏭️ Skipped: ${skippedAnalyses.length}`);
  console.log(`❌ Failed: ${failedAnalyses.length}`);
  console.log(`💬 Total Line-Specific Issue Comments Posted: ${commentStats.successful}`);
  if (commentStats.failed > 0) {
    console.log(`⚠️ Comments Failed: ${commentStats.failed}`);
  }
  
  // Language breakdown
  const languageStats = successfulAnalyses.reduce((stats, result) => {
    const lang = result.language || 'Unknown';
    stats[lang] = (stats[lang] || 0) + 1;
    return stats;
  }, {});
  
  // AI Provider breakdown
  const aiProviderStats = successfulAnalyses.reduce((stats, result) => {
    const provider = result.aiProvider || 'Unknown';
    stats[provider] = (stats[provider] || 0) + 1;
    return stats;
  }, {});
  
  if (Object.keys(languageStats).length > 0) {
    console.log(`\n🌐 Languages analyzed: ${Object.entries(languageStats).map(([lang, count]) => `${lang} (${count})`).join(', ')}`);
  }
  
  if (Object.keys(aiProviderStats).length > 0) {
    console.log(`\n🤖 AI Providers used: ${Object.entries(aiProviderStats).map(([provider, count]) => `${provider} (${count})`).join(', ')}`);
  }
  
  if (successfulAnalyses.length > 0) {
    console.log(`\n📋 SUCCESSFUL ANALYSES:`);
    successfulAnalyses.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.filename} (${result.changeType}) - ${result.language} [${result.aiProvider}]`);
      if (result.diffSummary) {
        console.log(`   🔄 Changes: ${result.diffSummary}`);
      }
      console.log(`   📝 Analysis length: ${result.analysis.length} characters`);
      console.log(`   ⏱️ Analysis time: ${result.analysisTime}ms`);
      console.log(`   🧠 Context used: ${result.contextUsed ? 'YES' : 'NO'}`);
      
      const totalComments = result.reviewComment?.totalComments || (result.reviewComment?.success ? 1 : 0);
      console.log(`   💬 Line-specific issue comments posted: ${totalComments}`);
      
      if (result.keyFindings) {
        const totalFindings = Object.values(result.keyFindings).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`   🔍 Key findings: ${totalFindings} items`);
      }
    });
  }
  
  console.log(`${'='.repeat(80)}\n`);
  
  return results;
}

/**
 * Get AI usage statistics
 */
export async function getAIStats() {
  return aiClient.getStats();
}

/**
 * Force switch to Ollama (for testing)
 */
export function forceOllamaMode() {
  aiClient.forceOllamaMode();
}

/**
 * Force switch to Gemini (for testing)
 */
export function forceGeminiMode() {
  aiClient.forceGeminiMode();
}
