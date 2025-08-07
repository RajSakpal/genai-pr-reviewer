import { PostCommentForPullRequestCommand } from "@aws-sdk/client-codecommit";
import { client } from "../codecommit/codecommitService.js";

// **CONFIGURATION**
const SEVERITY_CONFIG = {
  EMOJI: {
    'critical': '🚨',
    'high': '⚠️',
    'medium': '📋',
    'low': '💡'
  },
  ORDER: { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 },
  VALID: ['critical', 'high', 'medium', 'low'],
  DEFAULT: 'medium'
};

const ISSUE_TYPE_CONFIG = {
  security: {
    keywords: ['security', 'vulnerability', 'credential', 'password', 'injection', 'unauthorized'],
    type: 'Security Issue',
    icon: '🔒',
    fixes: {
      password: 'Move sensitive data to environment variables or secure configuration',
      injection: 'Use parameterized queries and proper input validation',
      default: 'Review security implications and implement appropriate safeguards'
    }
  },
  performance: {
    keywords: ['performance', 'slow', 'inefficient', 'optimization', 'memory'],
    type: 'Performance Issue',
    icon: '⚡',
    fixes: {
      loop: 'Consider using more efficient data structures or algorithms',
      query: 'Optimize database queries and add proper indexing',
      memory: 'Optimize memory usage and avoid unnecessary object creation',
      default: 'Profile and optimize the performance bottleneck'
    }
  },
  logic: {
    keywords: ['logic', 'bug', 'null', 'exception', 'error', 'crash', 'incomplete update', 'dead code'],
    type: 'Logic Issue',
    icon: '🐛',
    fixes: {
      null: 'Add null checks or use optional chaining',
      exception: 'Add proper error handling with try-catch blocks',
      default: 'Review the logic and add appropriate safeguards'
    }
  },
  codeQuality: {
    keywords: ['code quality', 'quality', 'style', 'naming', 'convention', 'maintainability', 'readability', 'unclear'],
    type: 'Code Quality',
    icon: '📝',
    fixes: {
      naming: 'Use more descriptive and conventional naming',
      method: 'Break down into smaller, more focused methods',
      default: 'Refactor to improve code clarity and maintainability'
    }
  },
  cleanup: {
    keywords: ['unused import', 'import', 'unused', 'dead code'],
    type: 'Code Cleanup',
    icon: '🧹',
    fixes: {
      import: 'Remove the unused import statement',
      default: 'Remove the unused code or provide proper documentation explaining its purpose'
    }
  },
  documentation: {
    keywords: ['documentation', 'comment', 'javadoc', 'docs'],
    type: 'Documentation',
    icon: '📚',
    fixes: {
      default: 'Add comprehensive documentation explaining the purpose and usage'
    }
  },
  businessLogic: {
    keywords: ['business logic', 'business', 'functional'],
    type: 'Business Logic',
    icon: '📊',
    fixes: {
      price: 'Verify if this business logic change is intentional and document the reasoning',
      default: 'Review the business logic change and ensure it meets requirements'
    }
  }
};

const LINE_EXTRACTION_PATTERNS = [
  // Handle the actual AI format: "* **Line X: [Type]** - Description" (anywhere in line)
  /\*\s*\*\*Line\s+(\d+):\s*\[([^\]]+?)\]\*\*\s*[-–—]\s*(.+?)(?:\s*\*\*Fix:\*\*|\s*$)/i,
  
  // Handle dash bullet format: "- **Line X: [Type]** - Description"
  /-\s*\*\*Line\s+(\d+):\s*\[([^\]]+?)\]\*\*\s*[-–—]\s*(.+?)(?:\s*\*\*Fix:\*\*|\s*$)/i,
  
  // Handle standard format without bullets: "**Line X: [Type]** - Description"
  /\*\*Line\s+(\d+):\s*\[([^\]]+?)\]\*\*\s*[-–—]\s*(.+?)(?:\s*\*\*Fix:\*\*|\s*$)/i,
  
  // Handle format without brackets: "* **Line X: Type** - Description"
  /\*\s*\*\*Line\s+(\d+):\s*([^*]+?)\*\*\s*[-–—]\s*(.+?)(?:\s*\*\*Fix:\*\*|\s*$)/i,
  
  // Handle without double asterisks: "* Line X: [Type] - Description"
  /[-*]\s*Line\s+(\d+):\s*\[([^\]]+?)\]\s*[-–—]\s*(.+?)(?:\s*\*\*Fix:\*\*|\s*$)/i,
  
  // Generic fallback patterns (no start-of-line anchor)
  /Line\s+(\d+):\s*\[([^\]]+?)\]\s*[-–—]\s*(.+?)(?:\s*\*\*Fix:\*\*|\s*$)/i,
  /Line\s+(\d+):\s*([^-–—\[]+?)[-–—]\s*(.+?)(?:\s*\*\*Fix:\*\*|\s*$)/i,
  
  // Last resort fallback
  /Line\s+(\d+):\s*(.+?)(?:\s*\(([^)]+)\))?(?:\s*\*\*Fix:\*\*|\s*$)/i
];



const MAX_COMMENTS = 10;  
const COMMENT_DELAY = 200;

// **UTILITY FUNCTIONS**
function createCommentResult(success, data = {}) {
  return {
    success,
    filePath: data.filePath || '',
    line: data.line || 0,
    ...data
  };
}

// **LINE NUMBER MAPPING FOR NUMBERED CONTENT**
function mapAILineToActualLine(aiLineNumber, afterContent) {
  const afterLines = afterContent.split('\n');
  
  // Check if content has line number prefixes (like "AFTER-010:" or "  010:")
  const hasAfterPrefix = afterLines.some(line => line.match(/^AFTER-\d+:/));
  const hasNumberPrefix = afterLines.some(line => line.match(/^\s*\d+:/));
  
  if (hasAfterPrefix) {
    // Content has AFTER-XXX: prefixes, AI should reference the XXX part
    const actualLine = afterLines.findIndex(line => {
      const match = line.match(/^AFTER-(\d+):/);
      return match && parseInt(match[1]) === aiLineNumber;
    });
    return actualLine >= 0 ? actualLine + 1 : aiLineNumber; // fallback to original
  } else if (hasNumberPrefix) {
    // Content has simple number prefixes like "  010:"
    const actualLine = afterLines.findIndex(line => {
      const match = line.match(/^\s*(\d+):/);
      return match && parseInt(match[1]) === aiLineNumber;
    });
    return actualLine >= 0 ? actualLine + 1 : aiLineNumber; // fallback to original
  }
  
  // No prefixes found, use direct mapping
  return aiLineNumber;
}

function validateLineInFile(line, afterContent, isNumberedContent = false) {
  if (!afterContent) {
    return { valid: false, error: 'No file content provided for validation' };
  }

  const afterLines = afterContent.split('\n');
  
  // If content was numbered (like "  010: code"), we need to count actual lines
  // If not numbered, use direct line mapping
  const totalLines = isNumberedContent ? 
    afterLines.filter(line => /^\s*\d+:\s/.test(line)).length : 
    afterLines.length;
  
  const isValid = line >= 1 && line <= totalLines;

  let lineContent = null;
  if (isValid) {
    if (isNumberedContent) {
      // Find the line with the specific number prefix
      const numberedLine = afterLines.find(l => {
        const match = l.match(/^\s*(\d+):\s(.*)$/);
        return match && parseInt(match[1]) === line;
      });
      lineContent = numberedLine ? numberedLine.replace(/^\s*\d+:\s/, '') : null;
    } else {
      lineContent = afterLines[line - 1];
    }
  }

  return {
    valid: isValid,
    totalLines: totalLines,
    lineContent: lineContent,
    error: isValid ? null : `Line ${line} out of range (1-${totalLines})`
  };
}

function logCommentDebug(filePath, line, content, afterContent) {
  console.log(`\n🔍 === COMMENT POSTING DEBUG for ${filePath} ===`);
  console.log(`🎯 Attempting to post comment on line: ${line}`);
  console.log(`📝 Comment content preview: "${content.substring(0, 100)}..."`);
  
  if (afterContent) {
    const validation = validateLineInFile(line, afterContent);
    console.log(`📊 File Analysis:`);
    console.log(`   - Total lines in file: ${validation.totalLines}`);
    console.log(`   - Requested line number: ${line}`);
    console.log(`   - Line exists: ${validation.valid ? '✅ YES' : '❌ NO'}`);
    
    if (validation.valid) {
      console.log(`   - Line ${line} content: "${validation.lineContent?.trim() || 'EMPTY'}"`);
      console.log(`   - Line ${line} length: ${validation.lineContent?.length || 0} chars`);
      console.log(`   - Line ${line} is empty: ${!validation.lineContent?.trim() ? 'YES' : 'NO'}`);
      logLineContext(line, afterContent);
    } else {
      console.log(`❌ ERROR: ${validation.error}`);
    }
  } else {
    console.warn(`⚠️ No afterContent provided for validation`);
  }
}

function logLineContext(targetLine, afterContent) {
  const afterLines = afterContent.split('\n');
  console.log(`📄 Context around line ${targetLine}:`);
  
  const startLine = Math.max(1, targetLine - 3);
  const endLine = Math.min(afterLines.length, targetLine + 3);
  
  for (let i = startLine; i <= endLine; i++) {
    const marker = i === targetLine ? '>>> TARGET >>>' : '            ';
    const lineContent = afterLines[i - 1] || 'EMPTY';
    console.log(`   ${marker} Line ${i}: "${lineContent.trim()}"`);
  }
}

function getChangedLines(beforeContent, afterContent) {
  if (!beforeContent || !afterContent) {
    return [];
  }
  
  const beforeLines = beforeContent.split('\n');
  const afterLines = afterContent.split('\n');
  const changedLines = [];
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const beforeLine = beforeLines[i] || '';
    const afterLine = afterLines[i] || '';
    
    if (beforeLine !== afterLine) {
      changedLines.push({
        lineNumber: i + 1,
        beforeLine,
        afterLine,
        changeType: !beforeLine ? 'added' : !afterLine ? 'deleted' : 'modified'
      });
    }
  }
  
  return changedLines;
}

function matchesKeywords(text, keywords) {
  const lowerText = text.toLowerCase();
  return keywords.some(keyword => lowerText.includes(keyword));
}

function analyzeIssueTypeAndIcon(issueType, description) {
  const lowerType = (issueType || '').toLowerCase();
  const lowerDesc = (description || '').toLowerCase();
  
  for (const [key, config] of Object.entries(ISSUE_TYPE_CONFIG)) {
    if (matchesKeywords(lowerType, config.keywords) || matchesKeywords(lowerDesc, config.keywords)) {
      return { type: config.type, icon: config.icon, category: key };
    }
  }
  
  return { type: 'Code Review', icon: '💡', category: 'default' };
}

function generateFixSuggestion(issueType, description) {
  const lowerType = (issueType || '').toLowerCase();
  const lowerDesc = (description || '').toLowerCase();
  
  // Special cases first
  if (lowerType.includes('incomplete update')) {
    return 'Complete the update by including all necessary field modifications or add proper validation';
  }
  
  if (lowerType.includes('code smell') && lowerDesc.includes('tempmethod')) {
    return 'Remove the method if not needed, or rename it to be more descriptive and add proper documentation';
  }
  
  // Find matching category and specific fix
  for (const [key, config] of Object.entries(ISSUE_TYPE_CONFIG)) {
    if (matchesKeywords(lowerType, config.keywords) || matchesKeywords(lowerDesc, config.keywords)) {
      // Look for specific fix based on description
      for (const [keyword, fix] of Object.entries(config.fixes)) {
        if (keyword !== 'default' && lowerDesc.includes(keyword)) {
          return fix;
        }
      }
      return config.fixes.default;
    }
  }
  
  return 'Review and address the identified issue';
}

function normalizeSeverity(severity) {
  const normalized = (severity || '').toLowerCase();
  return SEVERITY_CONFIG.VALID.includes(normalized) ? normalized : SEVERITY_CONFIG.DEFAULT;
}

function formatProfessionalComment(issue) {
  const emoji = SEVERITY_CONFIG.EMOJI[issue.severity] || SEVERITY_CONFIG.EMOJI[SEVERITY_CONFIG.DEFAULT];
  
  return `${issue.icon} **${issue.type}** ${emoji}\n\n` +
         `**Issue:** ${issue.problem}\n\n` +
         `**Suggested Fix:** ${issue.fix}\n\n` +
         `**Severity:** ${issue.severity.toUpperCase()}`;
}

function processIssueFromKeyFindings(issue) {
  const issueAnalysis = analyzeIssueTypeAndIcon(issue.type, issue.description);
  
  return {
    line: issue.line,
    type: issueAnalysis.type,
    icon: issueAnalysis.icon,
    severity: normalizeSeverity(issue.severity),
    problem: issue.description || 'Issue identified',
    fix: generateFixSuggestion(issue.type, issue.description),
    originalType: issue.type
  };
}

function extractLineFromText(line, patterns) {
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      return {
        lineNumber: parseInt(match[1]),
        issueType: match[2] ? match[2].trim() : 'Issue',
        description: match[3] ? match[3].trim() : match[2]?.trim() || 'Issue identified'
      };
    }
  }
  return null;
}

function parseAdditionalInfo(lines, startIndex, maxLookAhead = 10) {
  let severity = SEVERITY_CONFIG.DEFAULT;
  let fix = '';
  
  const endIndex = Math.min(startIndex + maxLookAhead, lines.length);
  
  for (let j = startIndex + 1; j < endIndex; j++) {
    const nextLine = lines[j].trim();
    if (!nextLine) continue;
    
    // Check for fix
    if (nextLine.match(/^\s*-?\s*\*?\*?Fix:?\*?\*?\s*/i)) {
      fix = nextLine.replace(/^\s*-?\s*\*?\*?Fix:?\*?\*?\s*/i, '').trim();
    }
    // Check for severity
    else if (nextLine.match(/^\s*-?\s*\*?\*?Severity:?\*?\*?\s*/i)) {
      const severityMatch = nextLine.match(/Severity:?\*?\*?\s*(\w+)/i);
      if (severityMatch) {
        severity = normalizeSeverity(severityMatch[1]);
      }
    }
    // Stop if we hit another line issue
    else if (nextLine.match(/^\s*-\s*\*\*Line\s+\d+/i)) {
      break;
    }
  }
  
  return { severity, fix };
}

// **EXTRACTION FUNCTIONS**
function extractLineSpecificIssuesFromKeyFindings(keyFindings, aiAnalysisText) {
  const issues = [];
  
  // Use pre-extracted lineSpecificIssues
  if (keyFindings?.lineSpecificIssues?.length > 0) {
    keyFindings.lineSpecificIssues.forEach(issue => {
      issues.push(processIssueFromKeyFindings(issue));
    });
  }
  
  // Fallback to text parsing
  if (issues.length === 0 && aiAnalysisText) {
    return extractLineSpecificIssuesLegacy(aiAnalysisText);
  }
  
  // Remove duplicates and sort
  return issues
    .filter((issue, index, self) => 
      index === self.findIndex(i => i.line === issue.line && i.problem === issue.problem)
    )
    .sort((a, b) => a.line - b.line);
}

function extractLineSpecificIssuesLegacy(aiAnalysis) {
  if (!aiAnalysis || typeof aiAnalysis !== 'string') {
    return [];
  }
  
  const issues = [];
  const analysisLines = aiAnalysis.split('\n');
  
  for (let i = 0; i < analysisLines.length; i++) {
    const line = analysisLines[i].trim();
    if (!line || line.length < 10) continue;
    
    const extracted = extractLineFromText(line, LINE_EXTRACTION_PATTERNS);
    if (!extracted || extracted.lineNumber <= 0) continue;
    
    const additionalInfo = parseAdditionalInfo(analysisLines, i);
    const issueAnalysis = analyzeIssueTypeAndIcon(extracted.issueType, extracted.description);
    
    issues.push({
      line: extracted.lineNumber,
      type: issueAnalysis.type,
      icon: issueAnalysis.icon,
      severity: additionalInfo.severity,
      problem: extracted.description,
      fix: additionalInfo.fix || generateFixSuggestion(extracted.issueType, extracted.description),
      originalType: extracted.issueType
    });
  }
  
  return issues
    .filter((issue, index, self) => 
      index === self.findIndex(i => i.line === issue.line && i.problem === issue.problem)
    )
    .sort((a, b) => a.line - b.line);
}

function prioritizeIssues(issues) {
  return issues
    .sort((a, b) => SEVERITY_CONFIG.ORDER[b.severity] - SEVERITY_CONFIG.ORDER[a.severity])
    .slice(0, MAX_COMMENTS);
}

function debugAIAnalysis(aiAnalysis, afterContent, filename) {
  console.log(`\n🤖 === AI ANALYSIS DEBUG for ${filename} ===`);
  
  if (!afterContent) {
    console.warn(`⚠️ No afterContent to validate against`);
    return;
  }
  
  const afterLines = afterContent.split('\n');
  const hasNumberedContent = afterLines.some(line => line.match(/^(AFTER-\d+:|\s*\d+:)/));
  
  console.log(`📊 File Analysis:`);
  console.log(`   - Total lines: ${afterLines.length}`);
  console.log(`   - Has numbered content: ${hasNumberedContent ? '✅ YES' : '❌ NO'}`);
  
  const lineMatches = aiAnalysis.match(/Line\s+(\d+):/gi) || [];
  console.log(`🔍 AI mentioned ${lineMatches.length} line-specific issues:`);
  
  lineMatches.forEach((match, index) => {
    const aiLineNumber = parseInt(match.match(/(\d+)/)[1]);
    const actualLine = mapAILineToActualLine(aiLineNumber, afterContent);
    const validation = validateLineInFile(actualLine, afterContent);
    
    console.log(`\n   ${index + 1}. ${match}`);
    console.log(`      - AI Line: ${aiLineNumber}, Mapped to: ${actualLine}`);
    console.log(`      - Valid range: ${validation.valid ? '✅' : '❌'}`);
    
    if (validation.valid) {
      console.log(`      - Content: "${validation.lineContent?.trim() || 'EMPTY'}"`);
    } else {
      console.log(`      - ERROR: ${validation.error}`);
    }
  });
  
  // Show file preview with line numbers
  console.log(`\n📄 File preview (first 10 lines):`);
  for (let i = 0; i < Math.min(10, afterLines.length); i++) {
    const lineNum = i + 1;
    const content = afterLines[i];
    const isNumbered = content.match(/^(AFTER-\d+:|\s*\d+:)/);
    console.log(`   Line ${lineNum}: "${content.trim()}"${isNumbered ? ' (numbered)' : ''}`);
  }
}

// **MAIN FUNCTIONS**
export async function postInlineFileComment({
  repositoryName,
  pullRequestId,
  beforeCommitId,
  afterCommitId,
  filePath,
  line,
  content,
  afterContent = null
}) {
  try {
    // Map AI line number to actual line number if using numbered content
    const actualLine = afterContent ? mapAILineToActualLine(line, afterContent) : line;
    
    logCommentDebug(filePath, actualLine, content, afterContent);
    
    // Validate the mapped line
    if (afterContent) {
      const validation = validateLineInFile(actualLine, afterContent);
      if (!validation.valid) {
        console.warn(`⚠️ Line mapping: AI referenced line ${line}, mapped to ${actualLine}, but validation failed`);
        return createCommentResult(false, {
          error: validation.error,
          filePath,
          line: actualLine,
          originalAILine: line
        });
      }
    }

    console.log(`🚀 Sending to AWS CodeCommit API...`);
    console.log(`   - Repository: ${repositoryName}`);
    console.log(`   - PR ID: ${pullRequestId}`);
    console.log(`   - File Path: ${filePath}`);
    console.log(`   - AI Referenced Line: ${line}`);
    console.log(`   - Actual File Position: ${actualLine}`);
    console.log(`   - Relative File Version: AFTER`);

    const command = new PostCommentForPullRequestCommand({
      pullRequestId,
      repositoryName,
      beforeCommitId,
      afterCommitId,
      location: {
        filePath,
        filePosition: actualLine,  // Use mapped line number
        relativeFileVersion: "AFTER"
      },
      content
    });

    const response = await client.send(command);
    console.log(`✅ SUCCESS: Comment posted successfully`);
    console.log(`   - Comment ID: ${response.comment?.commentId}`);
    console.log(`   - Response: ${JSON.stringify(response.comment, null, 2)}`);
    
    return createCommentResult(true, {
      commentId: response.comment?.commentId,
      filePath,
      line: actualLine,
      originalAILine: line,
      awsResponse: response.comment
    });
    
  } catch (err) {
    const actualLine = afterContent ? mapAILineToActualLine(line, afterContent) : line;
    console.error(`❌ AWS CodeCommit API ERROR for ${filePath} line ${line}->${actualLine}:`);
    console.error(`   - Error Name: ${err.name}`);
    console.error(`   - Error Message: ${err.message}`);
    console.error(`   - Error Code: ${err.$metadata?.httpStatusCode || 'unknown'}`);
    console.error(`   - Full Error: ${JSON.stringify(err, null, 2)}`);
    
    return createCommentResult(false, {
      error: err.message,
      filePath,
      line: actualLine,
      originalAILine: line,
      errorDetails: {
        name: err.name,
        code: err.$metadata?.httpStatusCode,
        message: err.message
      }
    });
  }
}

export async function postLineSpecificIssues({
  repositoryName,
  pullRequestId,
  beforeCommitId,
  afterCommitId,
  filePath,
  aiAnalysis,
  beforeContent,
  afterContent,
  keyFindings = null
}) {
  const results = [];
  
  try {
    // Debug AI analysis
    if (aiAnalysis && afterContent) {
      debugAIAnalysis(aiAnalysis, afterContent, filePath);
    }
    
    // Validate inputs
    if (!repositoryName || !pullRequestId || !filePath) {
      throw new Error('Missing required parameters for posting comments');
    }
    
    // Get changed lines for reference
    let changedLines = [];
    if (beforeContent && afterContent) {
      changedLines = getChangedLines(beforeContent, afterContent);
      console.log(`📊 Detected ${changedLines.length} changed lines in ${filePath}`);
    }
    
    // Extract line issues
    let lineIssues = [];
    if (keyFindings) {
      lineIssues = extractLineSpecificIssuesFromKeyFindings(keyFindings, aiAnalysis);
      console.log(`🎯 Using enhanced extraction: ${lineIssues.length} line-specific issues`);
    } else {
      lineIssues = extractLineSpecificIssuesLegacy(aiAnalysis);
      console.log(`🔄 Using legacy extraction: ${lineIssues.length} line-specific issues`);
    }
    
    if (lineIssues.length === 0) {
      console.log(`✅ No line-specific issues identified by AI for ${filePath}`);
      return [createCommentResult(true, {
        message: 'No line-specific issues identified',
        filePath
      })];
    }
    
    // Debug extracted issues
    console.log(`\n📋 EXTRACTED ISSUES DEBUG for ${filePath}:`);
    lineIssues.forEach((issue, index) => {
      const actualLine = mapAILineToActualLine(issue.line, afterContent);
      console.log(`   ${index + 1}. AI Line ${issue.line} -> Actual Line ${actualLine}: ${issue.type} - ${issue.problem.substring(0, 50)}...`);
    });
    
    // Limit and prioritize issues
    let issuesToPost = lineIssues;
    if (issuesToPost.length > MAX_COMMENTS) {
      console.log(`⚠️ Limiting to ${MAX_COMMENTS} most critical issues (${issuesToPost.length} total found)`);
      issuesToPost = prioritizeIssues(issuesToPost);
    }
    
    // Post comments with delay
    for (const issue of issuesToPost) {
      try {
        const commentContent = formatProfessionalComment(issue);
        
        const issueComment = await postInlineFileComment({
          repositoryName,
          pullRequestId,
          beforeCommitId,
          afterCommitId,
          filePath,
          line: issue.line,
          content: commentContent,
          afterContent
        });
        
        results.push(issueComment);
        await new Promise(resolve => setTimeout(resolve, COMMENT_DELAY));
        
      } catch (commentError) {
        console.error(`❌ Failed to post comment for line ${issue.line}:`, commentError.message);
        results.push(createCommentResult(false, {
          error: commentError.message,
          filePath,
          line: issue.line
        }));
      }
    }
    
    const successfulComments = results.filter(r => r.success).length;
    console.log(`✅ Posted ${successfulComments}/${issuesToPost.length} line-specific issue comments for ${filePath}`);
    
  } catch (error) {
    console.error(`❌ Failed to post line-specific issue comments for ${filePath}:`, error.message);
    results.push(createCommentResult(false, {
      error: error.message,
      filePath
    }));
  }
  
  return results;
}

export async function postAIAnalysisComment({
  repositoryName,
  pullRequestId,
  beforeCommitId,
  afterCommitId,
  filePath,
  aiAnalysis
}) {
  try {
    if (!repositoryName || !pullRequestId || !filePath || !aiAnalysis) {
      throw new Error('Missing required parameters for posting AI analysis comment');
    }
    
    const content = `## 🤖 AI Code Review: \`${filePath}\`\n\n${aiAnalysis}\n\n---\n*Generated by AI Code Reviewer*`;
    
    return await postInlineFileComment({
      repositoryName,
      pullRequestId,
      beforeCommitId,
      afterCommitId,
      filePath,
      line: 1,
      content
    });
  } catch (error) {
    console.error(`❌ Failed to post AI analysis comment:`, error.message);
    return createCommentResult(false, {
      error: error.message,
      filePath
    });
  }
}

export function isCommentingEnabled() {
  return process.env.CODECOMMIT_COMMENTS_ENABLED !== 'false';
}
