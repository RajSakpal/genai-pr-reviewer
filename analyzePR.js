import dotenv from "dotenv";
import { getBlobContent } from "./codecommit/codecommitService.js";
import { getRelevantContext, formatContextForPrompt, getDocumentGuidelines } from "./utils/qdrantKnowledgeBase.js";
import { GeminiAIClient } from "./utils/geminiClient.js";
import {AnthropicAIClient} from "./utils/anthropicClient.js";
import { detectLanguage } from "./utils/languageDetector.js";
import { 
  analyzeSpecificChanges, 
  generateDiffSummary, 
  shouldUseContext, 
  generateContextAwarePromptAddition 
} from "./utils/changeAnalyzer.js";
import { modifiedFileTemplate, newFileTemplate } from "./templates/promptTemplates.js";
import { postLineSpecificIssues, isCommentingEnabled } from "./utils/codecommitComments.js";

dotenv.config();

const aiClient = new GeminiAIClient();
// const aiClient = new AnthropicAIClient();

/**
 * Simple function to log prompt and response to file
 */
async function logPromptAndResponse(prompt, response, filename, pullRequestId) {
  try {
    const fs = await import('fs/promises');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeFilename = filename.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    const logFilename = `ai-log-${pullRequestId || 'unknown'}-${safeFilename}-${timestamp}.txt`;
    
    const logContent = `AI CODE REVIEW LOG
==================
File: ${filename}
PR ID: ${pullRequestId || 'unknown'}
Timestamp: ${new Date().toISOString()}
AI Provider: ${response.provider || 'unknown'}
Model: ${response.model || 'unknown'}
Prompt Length: ${prompt.length} characters
Response Length: ${response.content.length} characters

PROMPT SENT TO AI:
==================
${prompt}

RESPONSE FROM AI:
=================
${response.content}

LOG END
=======
`;
    
    await fs.writeFile(logFilename, logContent);
  } catch (error) {
    console.error('❌ Failed to save AI log:', error.message);
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
  } catch (error) {
    console.error('❌ Failed to save AI response:', error.message);
  }
}

// **HELPER FUNCTIONS FOR ENHANCED EXTRACTION**

function detectSection(text, sectionName, keywords) {
  const lowerText = text.toLowerCase();
  return keywords.some(keyword => 
    lowerText.includes(keyword) && 
    (lowerText.includes('**') || lowerText.includes('#') || lowerText.includes(':'))
  );
}

function extractLineSpecificIssue(text) {
  // Enhanced regex patterns for line-specific issues
  const patterns = [
    /(?:line\s+)?(\d+):\s*\[([^\]]+)\]\s*[-–—]\s*(.+)/i,
    /(?:line\s+)?(\d+):\s*([^-–—]+)[-–—]\s*(.+)/i,
    /(?:line\s+)?(\d+)\s*[-–—]\s*([^:]+):\s*(.+)/i,
    /(?:line\s+)?(\d+)\s*:\s*(.+?)(?:\s*\(([^)]+)\))?/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        line: parseInt(match[1]),
        type: match[2] ? match[2].trim() : 'Issue',
        description: match[3] ? match[3].trim() : match[2].trim(),
        severity: extractSeverity(text)
      };
    }
  }
  
  return null;
}

function extractNumberedItem(text) {
  const match = text.match(/^\d+\.\s*(.+)/);
  return match ? match[1].trim() : null;
}

function extractBulletPoint(text) {
  const match = text.match(/^[-•*]\s*(.+)/);
  return match ? match[1].trim() : null;
}

function extractGeneralIssue(text) {
  const issuePatterns = [
    { pattern: /security\s+(issue|problem|vulnerability)/i, type: 'Security' },
    { pattern: /performance\s+(issue|problem)/i, type: 'Performance' },
    { pattern: /code\s+quality\s+(issue|problem)/i, type: 'Code Quality' },
    { pattern: /logic\s+(error|issue|problem)/i, type: 'Logic' },
    { pattern: /null\s+pointer/i, type: 'Logic' },
    { pattern: /memory\s+leak/i, type: 'Performance' },
    { pattern: /sql\s+injection/i, type: 'Security' },
    { pattern: /unused\s+(variable|method|import)/i, type: 'Code Quality' }
  ];
  
  for (const { pattern, type } of issuePatterns) {
    if (pattern.test(text)) {
      return {
        type: type,
        description: text.trim()
      };
    }
  }
  
  return null;
}

function categorizeIssueType(type) {
  const lowerType = type.toLowerCase();
  
  if (lowerType.includes('security') || lowerType.includes('vulnerability')) return 'securityIssues';
  if (lowerType.includes('performance') || lowerType.includes('memory') || lowerType.includes('cpu')) return 'performance';
  if (lowerType.includes('logic') || lowerType.includes('bug') || lowerType.includes('error')) return 'logicIssues';
  if (lowerType.includes('quality') || lowerType.includes('maintainability') || lowerType.includes('readability')) return 'codeQuality';
  if (lowerType.includes('business') || lowerType.includes('functional')) return 'businessLogicIssues';
  if (lowerType.includes('integration') || lowerType.includes('dependency')) return 'integrationIssues';
  
  return 'suggestions'; // Default fallback
}

function extractSeverity(text) {
  const lowerText = text.toLowerCase();
  if (lowerText.includes('critical')) return 'Critical';
  if (lowerText.includes('high')) return 'High';
  if (lowerText.includes('medium')) return 'Medium';
  if (lowerText.includes('low')) return 'Low';
  return 'Medium'; // Default
}

function cleanIssueText(text) {
  return text
    .replace(/^[-•*]\s*/, '') // Remove bullet points
    .replace(/^\d+\.\s*/, '') // Remove numbering
    .replace(/^[*#]+\s*/, '') // Remove markdown headers
    .trim();
}

function isValidIssue(text) {
  // Filter out navigation text, headers, and other noise
  const invalidPatterns = [
    /^(fix|severity|recommended|additional)/i,
    /^(the |this |based on)/i,
    /^\w+:$/,
    /^```/
  ];
  
  return !invalidPatterns.some(pattern => pattern.test(text)) && text.length > 10;
}

/**
 * Enhanced helper function to extract key findings from AI response with comprehensive pattern matching
 */
function extractKeyFindings(analysis) {
  const findings = {
    whatChanged: [],
    securityIssues: [],
    codeQuality: [],
    logicIssues: [],
    performance: [],
    suggestions: [],
    lineSpecificIssues: [],
    businessLogicIssues: [],
    integrationIssues: [],
    languageSpecificIssues: []
  };
  
  try {
    const lines = analysis.split('\n');
    let currentSection = '';
    let isInCodeBlock = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Skip empty lines and code blocks
      if (!trimmed || trimmed.startsWith('```')) {
        if (trimmed.startsWith('```')) {
          continue;
        }
      }
      
      if (isInCodeBlock) continue;
      
      // **1. SECTION DETECTION** (Enhanced patterns)
      if (detectSection(trimmed, 'whatChanged', [
        'what changed', 'changes made', 'modifications', 'differences', 'altered'
      ])) {
        currentSection = 'whatChanged';
        continue;
      }
      
      if (detectSection(trimmed, 'securityIssues', [
        'security', 'vulnerability', 'injection', 'xss', 'csrf', 'authentication', 'authorization'
      ])) {
        currentSection = 'securityIssues';
        continue;
      }
      
      if (detectSection(trimmed, 'codeQuality', [
        'code quality', 'quality', 'maintainability', 'readability', 'clean code', 'best practices'
      ])) {
        currentSection = 'codeQuality';
        continue;
      }
      
      if (detectSection(trimmed, 'logicIssues', [
        'logic', 'bug', 'error', 'issue', 'problem', 'null pointer', 'exception'
      ])) {
        currentSection = 'logicIssues';
        continue;
      }
      
      if (detectSection(trimmed, 'performance', [
        'performance', 'optimization', 'efficiency', 'memory', 'cpu', 'slow'
      ])) {
        currentSection = 'performance';
        continue;
      }
      
      if (detectSection(trimmed, 'suggestions', [
        'suggestion', 'recommend', 'consider', 'improvement', 'enhancement'
      ])) {
        currentSection = 'suggestions';
        continue;
      }
      
      if (detectSection(trimmed, 'businessLogicIssues', [
        'business logic', 'functional', 'requirement', 'behavior'
      ])) {
        currentSection = 'businessLogicIssues';
        continue;
      }
      
      if (detectSection(trimmed, 'integrationIssues', [
        'integration', 'dependency', 'api', 'interface', 'breaking change'
      ])) {
        currentSection = 'integrationIssues';
        continue;
      }
      
      if (detectSection(trimmed, 'languageSpecificIssues', [
        'language-specific', 'java-specific', 'javascript-specific', 'python-specific'
      ])) {
        currentSection = 'languageSpecificIssues';
        continue;
      }
      
      // **2. LINE-SPECIFIC ISSUE DETECTION** (Most important!)
      const lineIssue = extractLineSpecificIssue(trimmed);
      if (lineIssue) {
        findings.lineSpecificIssues.push(lineIssue);
        
        // Also categorize by type
        const category = categorizeIssueType(lineIssue.type);
        if (findings[category]) {
          findings[category].push(`Line ${lineIssue.line}: ${lineIssue.description}`);
        }
        continue;
      }
      
      // **3. NUMBERED LIST DETECTION**
      const numberedItem = extractNumberedItem(trimmed);
      if (numberedItem && currentSection) {
        findings[currentSection].push(numberedItem);
        continue;
      }
      
      // **4. BULLET POINT DETECTION**
      const bulletItem = extractBulletPoint(trimmed);
      if (bulletItem && currentSection) {
        findings[currentSection].push(bulletItem);
        continue;
      }
      
      // **5. GENERAL ISSUE PATTERNS** (Fallback)
      const generalIssue = extractGeneralIssue(trimmed);
      if (generalIssue) {
        const category = categorizeIssueType(generalIssue.type);
        if (findings[category]) {
          findings[category].push(generalIssue.description);
        }
        continue;
      }
      
      // **6. CONTEXT-BASED CLASSIFICATION**
      if (currentSection && trimmed.length > 15 && !trimmed.startsWith('**') && !trimmed.startsWith('#')) {
        // Clean up the line and add to current section
        const cleanedLine = cleanIssueText(trimmed);
        if (cleanedLine && isValidIssue(cleanedLine)) {
          findings[currentSection].push(cleanedLine);
        }
      }
    }
    
    // **7. POST-PROCESSING** - Remove duplicates and sort by importance
    Object.keys(findings).forEach(key => {
      findings[key] = [...new Set(findings[key])]; // Remove duplicates
      findings[key] = findings[key].filter(item => item && item.length > 10); // Filter out too short items
    });
    
  } catch (error) {
    console.warn(`⚠️ Enhanced extraction failed: ${error.message}`);
  }
  
  return findings;
}

/**
 * Enhanced analyze function with hybrid AI support, guidelines integration, and prompt/response logging
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
      return {
        filename: fileData.filename,
        changeType: fileData.changeType,
        analysis: "Analysis skipped: Non-code file (not relevant for code review)",
        context: { hasContext: false, relatedFiles: [], contextChunksCount: 0, summary: "File type skipped." },
        guidelines: { hasGuidelines: false, count: 0, summary: "File type skipped." },
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

    let prompt;
    let fileContent;
    let context = { hasContext: false, contextChunks: [], relatedFiles: [], summary: "No context available." };
    let guidelines = { hasGuidelines: false, guidelines: [], count: 0, formatted: "Apply standard coding best practices." };
    let diffSummary = '';
    let useContext = false;
    
    if (fileData.changeType === 'A') {
      // Handle new file
      if (!fileData.blobId) {
        throw new Error('Missing blobId for new file');
      }
      
      fileContent = await getBlobContent(repositoryName, fileData.blobId);
      afterContent = fileContent; // Store for commenting
      
      context = await getRelevantContext(repositoryName, branchName, fileData.filename, fileContent, 5);
      
      guidelines = await getDocumentGuidelines(language, fileContent, 5);
      
      useContext = true;
      
      const contextSection = formatContextForPrompt(context);
      
      prompt = await newFileTemplate.format({
        filename: fileData.filename,
        content: fileContent,
        contextSection: contextSection,
        guidelinesSection: guidelines.formatted,
        language: language
      });
      
    } else if (fileData.changeType === 'M') {
      // Handle modified file
      if (!fileData.beforeBlobId || !fileData.afterBlobId) {
        throw new Error('Missing blob IDs for modified file');
      }
      
      [beforeContent, afterContent] = await Promise.all([
        getBlobContent(repositoryName, fileData.beforeBlobId),
        getBlobContent(repositoryName, fileData.afterBlobId)
      ]);
      
      // Analyze specific changes
      const specificChanges = analyzeSpecificChanges(beforeContent, afterContent, fileData.filename);
      diffSummary = generateDiffSummary(specificChanges);
      
      // Intelligent context decision
      useContext = shouldUseContext(specificChanges, fileData.filename);
      
      if (useContext) {
        context = await getRelevantContext(repositoryName, branchName, fileData.filename, afterContent, 5);
      } else {
        context = { hasContext: false, contextChunks: [], relatedFiles: [], summary: "Context skipped - diff-focused analysis." };
      }
      
      guidelines = await getDocumentGuidelines(language, afterContent, 5);
      
      fileContent = afterContent;
      
      const contextSection = formatContextForPrompt(context);
      const contextPromptAddition = generateContextAwarePromptAddition(specificChanges);
      const contextAnalysisInstructions = useContext ? 
        "Use the provided context to identify potential integration issues and cross-file dependencies." :
        "Focus purely on the changes in this file as no integration context is needed.";
      
      prompt = await modifiedFileTemplate.format({
        filename: fileData.filename,
        beforeContent: beforeContent,
        afterContent: afterContent,
        contextSection: contextSection,
        guidelinesSection: guidelines.formatted,
        contextPromptAddition: contextPromptAddition,
        contextAnalysisInstructions: contextAnalysisInstructions,
        language: language
      });
      
    } else {
      throw new Error(`Unsupported change type: ${fileData.changeType}`);
    }

    const response = await aiClient.invoke(prompt, {
      temperature: 0.1,
      top_p: 0.8,
      top_k: 20
    });
    
    // 📝 LOG PROMPT AND RESPONSE TO FILE
    await logPromptAndResponse(prompt, response, fileData.filename, pullRequestInfo?.pullRequestId);
    
    const analysisTime = Date.now() - startTime;
    
    // Save complete AI response to file if enabled
    await saveCompleteAIResponse(response, fileData.filename, pullRequestInfo?.pullRequestId);
    
    // Extract key findings with enhanced method
    const findings = extractKeyFindings(response.content);
    
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
      guidelines: {
        hasGuidelines: guidelines.hasGuidelines,
        count: guidelines.count,
        summary: guidelines.hasGuidelines ? `Applied ${guidelines.count} relevant guidelines` : "No specific guidelines applied"
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
        const commentResults = await postLineSpecificIssues({
          repositoryName,
          pullRequestId: pullRequestInfo.pullRequestId,
          beforeCommitId: pullRequestInfo.beforeCommitId,
          afterCommitId: pullRequestInfo.afterCommitId,
          filePath: fileData.filename,
          aiAnalysis: response.content,
          beforeContent: beforeContent,
          afterContent: afterContent,
          keyFindings: findings
        });
        
        const successfulComments = commentResults.filter(r => r.success).length;
        
        result.reviewComment = {
          success: successfulComments > 0,
          totalComments: commentResults.length,
          successfulComments: successfulComments,
          commentIds: commentResults.filter(r => r.success).map(r => r.commentId),
          type: 'line-specific-issues'
        };
        
      } catch (commentError) {
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
      keyFindings: { whatChanged: [], securityIssues: [], codeQuality: [], logicIssues: [], performance: [], suggestions: [], lineSpecificIssues: [], businessLogicIssues: [], integrationIssues: [], languageSpecificIssues: [] },
      context: { hasContext: false, relatedFiles: [], contextChunksCount: 0, summary: "Context unavailable due to error." },
      guidelines: { hasGuidelines: false, count: 0, summary: "Guidelines unavailable due to error." },
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
  
  console.log(`🤖 Starting analysis of ${files.length} files`);
  
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    
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
          results.push({
            filename: batch[index].filename,
            changeType: batch[index].changeType,
            analysis: `Analysis returned invalid result structure`,
            keyFindings: { whatChanged: [], securityIssues: [], codeQuality: [], logicIssues: [], performance: [], suggestions: [], lineSpecificIssues: [], businessLogicIssues: [], integrationIssues: [], languageSpecificIssues: [] },
            context: { hasContext: false, relatedFiles: [], contextChunksCount: 0 },
            guidelines: { hasGuidelines: false, count: 0, summary: "Invalid result structure." },
            reviewComment: { success: false, error: 'Invalid result structure' },
            error: true,
            timestamp: new Date().toISOString(),
            success: false,
            aiProvider: 'hybrid'
          });
        }
      } else {
        results.push({
          filename: batch[index].filename,
          changeType: batch[index].changeType,
          analysis: `Batch processing failed: ${result.reason}`,
          keyFindings: { whatChanged: [], securityIssues: [], codeQuality: [], logicIssues: [], performance: [], suggestions: [], lineSpecificIssues: [], businessLogicIssues: [], integrationIssues: [], languageSpecificIssues: [] },
          context: { hasContext: false, relatedFiles: [], contextChunksCount: 0 },
          guidelines: { hasGuidelines: false, count: 0, summary: "Batch processing failed." },
          reviewComment: { success: false, error: 'Batch processing failed' },
          error: true,
          timestamp: new Date().toISOString(),
          success: false,
          aiProvider: 'hybrid'
        });
      }
    });
  }
  
  const successfulAnalyses = results.filter(r => r.success && !r.skipped);
  const skippedAnalyses = results.filter(r => r.skipped);
  const failedAnalyses = results.filter(r => r.error);
  
  // Calculate statistics
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
  
  const guidelinesStats = results.reduce((stats, result) => {
    if (result.guidelines && result.guidelines.hasGuidelines) {
      stats.applied += result.guidelines.count;
      stats.filesWithGuidelines++;
    }
    return stats;
  }, { applied: 0, filesWithGuidelines: 0 });
  
  // Final summary
  console.log(`\n📊 Analysis Complete:`);
  console.log(`✅ Successful: ${successfulAnalyses.length}`);
  console.log(`⏭️ Skipped: ${skippedAnalyses.length}`);
  console.log(`❌ Failed: ${failedAnalyses.length}`);
  console.log(`💬 Comments Posted: ${commentStats.successful}`);
  console.log(`📋 Guidelines Applied: ${guidelinesStats.applied}`);
  
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
