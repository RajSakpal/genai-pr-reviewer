import dotenv from "dotenv";
import { getBlobContent } from "./codecommit/codecommitService.js";
import { getRelevantContext, formatContextForPrompt, getDocumentGuidelines } from "./utils/qdrantKnowledgeBase.js";
import { GeminiAIClient } from "./utils/geminiClient.js";
import { AnthropicAIClient } from "./utils/anthropicClient.js";
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

// **CONFIGURATION**
const SKIP_PATTERNS = [
  /\.idea\//, /\.vscode\//, /\.git\//, /node_modules\//,
  /\.log$/, /\.tmp$/, /\.cache$/,
  /\.(png|jpg|jpeg|gif|svg|ico)$/i,
  /\.(pdf|doc|docx)$/i
];

const ISSUE_PATTERNS = {
  security: [
    /security\s+(issue|problem|vulnerability)/i,
    /sql\s+injection/i,
    /xss/i,
    /csrf/i,
    /authentication/i,
    /authorization/i
  ],
  performance: [
    /performance\s+(issue|problem)/i,
    /memory\s+leak/i,
    /optimization/i,
    /efficiency/i,
    /cpu/i,
    /slow/i
  ],
  logic: [
    /logic\s+(error|issue|problem)/i,
    /null\s+pointer/i,
    /bug/i,
    /error/i,
    /exception/i
  ],
  codeQuality: [
    /code\s+quality/i,
    /maintainability/i,
    /readability/i,
    /clean\s+code/i,
    /best\s+practices/i
  ]
};

const SECTION_KEYWORDS = {
  whatChanged: ['what changed', 'changes made', 'modifications', 'differences', 'altered'],
  securityIssues: ['security', 'vulnerability', 'injection', 'xss', 'csrf', 'authentication', 'authorization'],
  codeQuality: ['code quality', 'quality', 'maintainability', 'readability', 'clean code', 'best practices'],
  logicIssues: ['logic', 'bug', 'error', 'issue', 'problem', 'null pointer', 'exception'],
  performance: ['performance', 'optimization', 'efficiency', 'memory', 'cpu', 'slow'],
  suggestions: ['suggestion', 'recommend', 'consider', 'improvement', 'enhancement'],
  businessLogicIssues: ['business logic', 'functional', 'requirement', 'behavior'],
  integrationIssues: ['integration', 'dependency', 'api', 'interface', 'breaking change'],
  languageSpecificIssues: ['language-specific', 'java-specific', 'javascript-specific', 'python-specific']
};

// **AI CLIENT FACTORY**
const createAIClient = () => {
  const provider = process.env.AI_PROVIDER || 'gemini';
  return provider === 'anthropic' ? new AnthropicAIClient() : new GeminiAIClient();
};

const aiClient = createAIClient();

// **UTILITY FUNCTIONS**
async function writeLogFile(filename, content, prefix, pullRequestId) {
  try {
    const fs = await import('fs/promises');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeFilename = filename.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    const logFilename = `${prefix}-${pullRequestId || 'unknown'}-${safeFilename}-${timestamp}.txt`;
    await fs.writeFile(logFilename, content);
  } catch (error) {
    console.error(`❌ Failed to save ${prefix}:`, error.message);
  }
}

function createAnalysisResult(fileData, overrides = {}) {
  const defaultKeyFindings = {
    whatChanged: [], securityIssues: [], codeQuality: [], logicIssues: [],
    performance: [], suggestions: [], lineSpecificIssues: [],
    businessLogicIssues: [], integrationIssues: [], languageSpecificIssues: []
  };

  return {
    filename: fileData.filename,
    changeType: fileData.changeType,
    keyFindings: defaultKeyFindings,
    context: { hasContext: false, relatedFiles: [], contextChunksCount: 0, summary: "No context available." },
    guidelines: { hasGuidelines: false, count: 0, summary: "No guidelines applied." },
    reviewComment: { success: false, error: 'Not processed' },
    timestamp: new Date().toISOString(),
    success: false,
    aiProvider: 'hybrid',
    ...overrides
  };
}

function shouldSkipFile(filename) {
  return SKIP_PATTERNS.some(pattern => pattern.test(filename));
}

function matchesPatterns(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function detectIssueType(text) {
  for (const [type, patterns] of Object.entries(ISSUE_PATTERNS)) {
    if (matchesPatterns(text, patterns)) {
      return type;
    }
  }
  return null;
}

function extractSeverity(text) {
  const lowerText = text.toLowerCase();
  if (lowerText.includes('critical')) return 'Critical';
  if (lowerText.includes('high')) return 'High';
  if (lowerText.includes('medium')) return 'Medium';
  if (lowerText.includes('low')) return 'Low';
  return 'Medium';
}

function categorizeIssueType(type) {
  const lowerType = type.toLowerCase();
  
  if (lowerType.includes('security') || lowerType.includes('vulnerability')) return 'securityIssues';
  if (lowerType.includes('performance') || lowerType.includes('memory') || lowerType.includes('cpu')) return 'performance';
  if (lowerType.includes('logic') || lowerType.includes('bug') || lowerType.includes('error')) return 'logicIssues';
  if (lowerType.includes('quality') || lowerType.includes('maintainability') || lowerType.includes('readability')) return 'codeQuality';
  if (lowerType.includes('business') || lowerType.includes('functional')) return 'businessLogicIssues';
  if (lowerType.includes('integration') || lowerType.includes('dependency')) return 'integrationIssues';
  
  return 'suggestions';
}

function addLineNumbers(content, prefix = '') {
  if (!content) return '';
  
  const lines = content.split('\n');
  return lines.map((line, index) => {
    const lineNum = (index + 1).toString().padStart(3, ' ');
    return `${prefix}${lineNum}: ${line}`;
  }).join('\n');
}

function addLineNumbersWithLabel(content, label) {
  if (!content) return '';
  
  const lines = content.split('\n');
  return lines.map((line, index) => {
    const lineNum = (index + 1).toString().padStart(3, ' ');
    return `${label}-${lineNum}: ${line}`;
  }).join('\n');
}

function detectSection(text, sectionName) {
  const lowerText = text.toLowerCase();
  const keywords = SECTION_KEYWORDS[sectionName] || [];
  
  return keywords.some(keyword => 
    lowerText.includes(keyword) && 
    (lowerText.includes('**') || lowerText.includes('#') || lowerText.includes(':'))
  );
}

function extractLineSpecificIssue(text) {
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

function extractListItem(text) {
  // Handle numbered items
  const numberedMatch = text.match(/^\d+\.\s*(.+)/);
  if (numberedMatch) return numberedMatch[1].trim();
  
  // Handle bullet points
  const bulletMatch = text.match(/^[-•*]\s*(.+)/);
  if (bulletMatch) return bulletMatch[1].trim();
  
  return null;
}

function cleanIssueText(text) {
  return text
    .replace(/^[-•*]\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/^[*#]+\s*/, '')
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

// **LOGGING FUNCTIONS**
async function logPromptAndResponse(prompt, response, filename, pullRequestId) {
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
  
  await writeLogFile(filename, logContent, 'ai-log', pullRequestId);
}

async function saveCompleteAIResponse(response, filename, pullRequestId) {
  if (process.env.SAVE_AI_RESPONSES !== 'true') {
    return;
  }
  
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
  
  await writeLogFile(filename, content, 'ai-response', pullRequestId);
}

// **ANALYSIS EXTRACTION**
function extractKeyFindings(analysis) {
  const findings = createAnalysisResult({ filename: '', changeType: '' }).keyFindings;
  
  try {
    const lines = analysis.split('\n');
    let currentSection = '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (!trimmed || trimmed.startsWith('```')) continue;
      
      // Section detection
      for (const [sectionName] of Object.entries(SECTION_KEYWORDS)) {
        if (detectSection(trimmed, sectionName)) {
          currentSection = sectionName;
          break;
        }
      }
      
      // Line-specific issue detection
      const lineIssue = extractLineSpecificIssue(trimmed);
      if (lineIssue) {
        findings.lineSpecificIssues.push(lineIssue);
        const category = categorizeIssueType(lineIssue.type);
        if (findings[category]) {
          findings[category].push(`Line ${lineIssue.line}: ${lineIssue.description}`);
        }
        continue;
      }
      
      // List item extraction
      const listItem = extractListItem(trimmed);
      if (listItem && currentSection && findings[currentSection]) {
        findings[currentSection].push(listItem);
        continue;
      }
      
      // General issue patterns
      const issueType = detectIssueType(trimmed);
      if (issueType) {
        const category = `${issueType}${issueType.endsWith('s') ? '' : 's'}`;
        if (findings[category]) {
          findings[category].push(trimmed);
        }
        continue;
      }
      
      // Context-based classification
      if (currentSection && trimmed.length > 15 && !trimmed.startsWith('**') && !trimmed.startsWith('#')) {
        const cleanedLine = cleanIssueText(trimmed);
        if (cleanedLine && isValidIssue(cleanedLine) && findings[currentSection]) {
          findings[currentSection].push(cleanedLine);
        }
      }
    }
    
    // Post-processing: Remove duplicates and filter
    Object.keys(findings).forEach(key => {
      findings[key] = [...new Set(findings[key])];
      findings[key] = findings[key].filter(item => item && item.length > 10);
    });
    
  } catch (error) {
    console.warn(`⚠️ Enhanced extraction failed: ${error.message}`);
  }
  
  return findings;
}

// **CONTEXT AND CONTENT PROCESSING**
async function processFileContent(fileData, repositoryName, branchName) {
  let beforeContent = null;
  let afterContent = null;
  let context = { hasContext: false, contextChunks: [], relatedFiles: [], summary: "No context available." };
  let guidelines = { hasGuidelines: false, guidelines: [], count: 0, formatted: "Apply standard coding best practices." };
  let diffSummary = '';
  let useContext = false;

  const language = detectLanguage(fileData.filename);

  if (fileData.changeType === 'A') {
    // New file
    if (!fileData.blobId) {
      throw new Error('Missing blobId for new file');
    }
    
    afterContent = await getBlobContent(repositoryName, fileData.blobId);
    context = await getRelevantContext(repositoryName, branchName, fileData.filename, afterContent, 5);
    guidelines = await getDocumentGuidelines(language, afterContent, 5);
    useContext = true;
    
  } else if (fileData.changeType === 'M') {
    // Modified file
    if (!fileData.beforeBlobId || !fileData.afterBlobId) {
      throw new Error('Missing blob IDs for modified file');
    }
    
    [beforeContent, afterContent] = await Promise.all([
      getBlobContent(repositoryName, fileData.beforeBlobId),
      getBlobContent(repositoryName, fileData.afterBlobId)
    ]);
    
    const specificChanges = analyzeSpecificChanges(beforeContent, afterContent, fileData.filename);
    diffSummary = generateDiffSummary(specificChanges);
    useContext = shouldUseContext(specificChanges, fileData.filename);
    
    if (useContext) {
      context = await getRelevantContext(repositoryName, branchName, fileData.filename, afterContent, 5);
    } else {
      context = { hasContext: false, contextChunks: [], relatedFiles: [], summary: "Context skipped - diff-focused analysis." };
    }
    
    guidelines = await getDocumentGuidelines(language, afterContent, 5);
  } else {
    throw new Error(`Unsupported change type: ${fileData.changeType}`);
  }

  return {
    beforeContent,
    afterContent,
    context,
    guidelines,
    diffSummary,
    useContext,
    language
  };
}

async function generatePrompt(fileData, contentData) {
  const { beforeContent, afterContent, context, guidelines, useContext, language } = contentData;
  const contextSection = formatContextForPrompt(context);

  if (fileData.changeType === 'A') {
    // For new files, just add line numbers to the content
    const numberedContent = addLineNumbers(afterContent);
    
    return await newFileTemplate.format({
      filename: fileData.filename,
      content: numberedContent,  // ← Changed this line
      contextSection: contextSection,
      guidelinesSection: guidelines.formatted,
      language: language
    });
  } else {
    // For modified files, add prefixed line numbers
    const numberedBeforeContent = addLineNumbersWithLabel(beforeContent, 'BEFORE');
    const numberedAfterContent = addLineNumbersWithLabel(afterContent, 'AFTER');
    
    const contextPromptAddition = generateContextAwarePromptAddition(
      analyzeSpecificChanges(beforeContent, afterContent, fileData.filename)
    );
    const contextAnalysisInstructions = useContext ? 
      "Use the provided context to identify potential integration issues and cross-file dependencies." :
      "Focus purely on the changes in this file as no integration context is needed.";

    return await modifiedFileTemplate.format({
      filename: fileData.filename,
      beforeContent: numberedBeforeContent,  // ← Changed this line
      afterContent: numberedAfterContent,    // ← Changed this line
      contextSection: contextSection,
      guidelinesSection: guidelines.formatted,
      contextPromptAddition: contextPromptAddition,
      contextAnalysisInstructions: contextAnalysisInstructions,
      language: language
    });
  }
}

// **MAIN ANALYSIS FUNCTION**
export async function analyzeFileWithAI(fileData, repositoryName, branchName = 'main', pullRequestInfo = null) {
  const startTime = Date.now();
  
  try {
    // Skip certain file types
    if (shouldSkipFile(fileData.filename)) {
      return createAnalysisResult(fileData, {
        analysis: "Analysis skipped: Non-code file (not relevant for code review)",
        context: { hasContext: false, relatedFiles: [], contextChunksCount: 0, summary: "File type skipped." },
        guidelines: { hasGuidelines: false, count: 0, summary: "File type skipped." },
        reviewComment: { success: false, error: 'File skipped' },
        analysisTime: Date.now() - startTime,
        skipped: true,
        success: true
      });
    }

    // Process file content and context
    const contentData = await processFileContent(fileData, repositoryName, branchName);
    
    // Generate prompt
    const prompt = await generatePrompt(fileData, contentData);
    
    // Get AI response
    const response = await aiClient.invoke(prompt, {
      temperature: 0.1,
      top_p: 0.8,
      top_k: 20
    });
    
    // Log prompt and response
    await logPromptAndResponse(prompt, response, fileData.filename, pullRequestInfo?.pullRequestId);
    await saveCompleteAIResponse(response, fileData.filename, pullRequestInfo?.pullRequestId);
    
    // Extract findings
    const findings = extractKeyFindings(response.content);
    
    const result = createAnalysisResult(fileData, {
      language: contentData.language,
      analysis: response.content,
      keyFindings: findings,
      diffSummary: contentData.diffSummary,
      contextUsed: contentData.useContext,
      context: {
        hasContext: contentData.context.hasContext,
        relatedFiles: contentData.context.relatedFiles,
        contextChunksCount: contentData.context.contextChunks.length,
        summary: contentData.context.summary
      },
      guidelines: {
        hasGuidelines: contentData.guidelines.hasGuidelines,
        count: contentData.guidelines.count,
        summary: contentData.guidelines.hasGuidelines ? 
          `Applied ${contentData.guidelines.count} relevant guidelines` : 
          "No specific guidelines applied"
      },
      analysisTime: Date.now() - startTime,
      success: true,
      aiProvider: response.provider,
      model: response.model
    });

    // Post line-specific comments if enabled
    if (pullRequestInfo && isCommentingEnabled() && result.success) {
      try {
        const commentResults = await postLineSpecificIssues({
          repositoryName,
          pullRequestId: pullRequestInfo.pullRequestId,
          beforeCommitId: pullRequestInfo.beforeCommitId,
          afterCommitId: pullRequestInfo.afterCommitId,
          filePath: fileData.filename,
          aiAnalysis: response.content,
          beforeContent: contentData.beforeContent,
          afterContent: contentData.afterContent,
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
    
    return createAnalysisResult(fileData, {
      analysis: `Analysis failed: ${error.message}`,
      context: { hasContext: false, relatedFiles: [], contextChunksCount: 0, summary: "Context unavailable due to error." },
      guidelines: { hasGuidelines: false, count: 0, summary: "Guidelines unavailable due to error." },
      reviewComment: { success: false, error: 'Analysis failed' },
      analysisTime: analysisTime,
      error: true,
      errorDetails: {
        name: error.name,
        message: error.message
      }
    });
  }
}

// **BATCH PROCESSING**
export async function analyzeFilesInBatches(files, repositoryName, branchName = 'main', batchSize = 1, pullRequestInfo = null) {
  const results = [];
  
  console.log(`🤖 Starting analysis of ${files.length} files`);
  
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    
    const batchPromises = batch.map(file => 
      analyzeFileWithAI(file, repositoryName, branchName, pullRequestInfo)
    );
    
    const batchResults = await Promise.allSettled(batchPromises);
    
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value && typeof result.value === 'object') {
        results.push(result.value);
      } else {
        results.push(createAnalysisResult(batch[index], {
          analysis: `Batch processing failed: ${result.reason || 'Invalid result structure'}`,
          error: true
        }));
      }
    });
  }
  
  // Calculate comprehensive statistics in one pass
  const stats = results.reduce((acc, result) => {
    if (result.success && !result.skipped) acc.successful++;
    else if (result.skipped) acc.skipped++;
    else if (result.error) acc.failed++;
    
    if (result.reviewComment?.success) {
      acc.comments.successful += result.reviewComment.totalComments || 1;
    } else if (result.reviewComment?.error && 
               !['No PR info provided', 'Commenting disabled', 'File skipped'].includes(result.reviewComment.error)) {
      acc.comments.failed++;
    }
    
    if (result.guidelines?.hasGuidelines) {
      acc.guidelines.applied += result.guidelines.count;
      acc.guidelines.filesWithGuidelines++;
    }
    
    return acc;
  }, {
    successful: 0, skipped: 0, failed: 0,
    comments: { successful: 0, failed: 0 },
    guidelines: { applied: 0, filesWithGuidelines: 0 }
  });
  
  // Final summary
  console.log(`\n📊 Analysis Complete:`);
  console.log(`✅ Successful: ${stats.successful}`);
  console.log(`⏭️ Skipped: ${stats.skipped}`);
  console.log(`❌ Failed: ${stats.failed}`);
  console.log(`💬 Comments Posted: ${stats.comments.successful}`);
  console.log(`📋 Guidelines Applied: ${stats.guidelines.applied}`);
  
  return results;
}

// **API FUNCTIONS**
export async function getAIStats() {
  return aiClient.getStats();
}

export function forceOllamaMode() {
  aiClient.forceOllamaMode();
}

export function forceGeminiMode() {
  aiClient.forceGeminiMode();
}
