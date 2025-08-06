import { PostCommentForPullRequestCommand } from "@aws-sdk/client-codecommit";
import { client } from "../codecommit/codecommitService.js";

/**
 * Post comment on specific line in file (appears in Changes tab)
 */
export async function postInlineFileComment({
  repositoryName,
  pullRequestId,
  beforeCommitId,
  afterCommitId,
  filePath,
  line,
  content
}) {
  try {
    const command = new PostCommentForPullRequestCommand({
      pullRequestId,
      repositoryName,
      beforeCommitId,
      afterCommitId,
      location: {
        filePath,
        filePosition: line,
        relativeFileVersion: "AFTER"
      },
      content
    });

    const response = await client.send(command);
    return {
      success: true,
      commentId: response.comment?.commentId,
      filePath,
      line
    };
  } catch (err) {
    console.error(`❌ Failed to post inline comment to ${filePath} line ${line}:`, err.message);
    return {
      success: false,
      error: err.message,
      filePath,
      line
    };
  }
}

/**
 * Analyze diff and extract changed line numbers
 */
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
        beforeLine: beforeLine,
        afterLine: afterLine,
        changeType: !beforeLine ? 'added' : !afterLine ? 'deleted' : 'modified'
      });
    }
  }
  
  return changedLines;
}

/**
 * Use the enhanced keyFindings from analyzePR.js instead of duplicating extraction logic
 */
function extractLineSpecificIssuesFromKeyFindings(keyFindings, aiAnalysisText) {
  const issues = [];
  
  // Use the already-extracted lineSpecificIssues from the enhanced analyzer
  if (keyFindings.lineSpecificIssues && keyFindings.lineSpecificIssues.length > 0) {
    keyFindings.lineSpecificIssues.forEach(issue => {
      const processedIssue = {
        line: issue.line,
        type: issue.type || 'Code Review',
        severity: issue.severity?.toLowerCase() || 'medium',
        problem: issue.description || 'Issue identified',
        fix: generateFixSuggestion(issue.type, issue.description),
        originalType: issue.type
      };
      
      // Add appropriate icon
      const issueAnalysis = analyzeIssueTypeAndIcon(issue.type, issue.description);
      processedIssue.icon = issueAnalysis.icon;
      processedIssue.type = issueAnalysis.type;
      
      issues.push(processedIssue);
    });
  }
  
  // Fallback: If no pre-extracted issues, try parsing the raw AI text (legacy support)
  if (issues.length === 0 && aiAnalysisText) {
    return extractLineSpecificIssuesLegacy(aiAnalysisText);
  }
  
  // Remove duplicates and sort by line number
  const uniqueIssues = issues.filter((issue, index, self) => 
    index === self.findIndex(i => i.line === issue.line && i.problem === issue.problem)
  ).sort((a, b) => a.line - b.line);
  
  return uniqueIssues;
}

/**
 * Legacy extraction method (kept as fallback)
 */
function extractLineSpecificIssuesLegacy(aiAnalysis) {
  const issues = [];
  
  if (!aiAnalysis || typeof aiAnalysis !== 'string') {
    return issues;
  }
  
  const analysisLines = aiAnalysis.split('\n');
  
  // Enhanced patterns to match AI response format
  const linePatterns = [
    // Pattern 1: - **Line 38: Code Smell** - Description
    /^\s*-\s*\*\*Line\s+(\d+):\s*([^*]+?)\*\*\s*-\s*(.+)$/i,
    // Pattern 2: **Line 38: Code Smell** - Description  
    /^\s*\*\*Line\s+(\d+):\s*([^*]+?)\*\*\s*-\s*(.+)$/i,
    // Pattern 3: Line 38: Code Smell - Description
    /^\s*-?\s*Line\s+(\d+):\s*([^-]+?)\s*-\s*(.+)$/i,
    // Pattern 4: Line 38: Issue Type** - Description
    /^\s*-?\s*Line\s+(\d+):\s*([^*]+?)\*?\*?\s*-\s*(.+)$/i
  ];
  
  for (let i = 0; i < analysisLines.length; i++) {
    const line = analysisLines[i].trim();
    
    if (!line || line.length < 10) continue;
    
    let match = null;
    let lineNumber = null;
    let issueType = '';
    let description = '';
    
    // Try different patterns
    for (const pattern of linePatterns) {
      match = line.match(pattern);
      if (match) {
        lineNumber = parseInt(match[1]);
        issueType = match[2].trim();
        description = match[3].trim();
        break;
      }
    }
    
    if (match && lineNumber && lineNumber > 0) {
      // Look for fix and severity in following lines
      let severity = 'medium';
      let fix = '';
      
      // Check next few lines for Fix and Severity
      for (let j = i + 1; j < Math.min(i + 10, analysisLines.length); j++) {
        const nextLine = analysisLines[j].trim();
        
        if (!nextLine) continue;
        
        // Check for fix
        if (nextLine.match(/^\s*-?\s*\*?\*?Fix:?\*?\*?\s*/i)) {
          fix = nextLine.replace(/^\s*-?\s*\*?\*?Fix:?\*?\*?\s*/i, '').trim();
        }
        // Check for severity
        else if (nextLine.match(/^\s*-?\s*\*?\*?Severity:?\*?\*?\s*/i)) {
          const severityMatch = nextLine.match(/Severity:?\*?\*?\s*(\w+)/i);
          if (severityMatch) {
            severity = severityMatch[1].toLowerCase();
          }
        }
        // Stop if we hit another line issue
        else if (nextLine.match(/^\s*-\s*\*\*Line\s+\d+/i)) {
          break;
        }
      }
      
      // Validate severity
      const validSeverities = ['critical', 'high', 'medium', 'low'];
      if (!validSeverities.includes(severity)) {
        severity = 'medium';
      }
      
      // If no explicit fix found, generate one based on issue type
      if (!fix || fix.length < 10) {
        fix = generateFixSuggestion(issueType, description);
      }
      
      // Analyze issue type and set appropriate icon
      const issueAnalysis = analyzeIssueTypeAndIcon(issueType, description);
      
      issues.push({
        line: lineNumber,
        type: issueAnalysis.type,
        icon: issueAnalysis.icon,
        severity: severity,
        problem: description,
        fix: fix,
        originalType: issueType
      });
    }
  }
  
  return issues.filter((issue, index, self) => 
    index === self.findIndex(i => i.line === issue.line && i.problem === issue.problem)
  ).sort((a, b) => a.line - b.line);
}

/**
 * Analyze issue type and assign appropriate icon (Enhanced for keyFindings format)
 */
function analyzeIssueTypeAndIcon(issueType, description) {
  const lowerType = (issueType || '').toLowerCase();
  const lowerDesc = (description || '').toLowerCase();
  
  let type = 'Code Review';
  let icon = '💡';
  
  // Enhanced issue type detection
  if (lowerType.includes('security') || lowerDesc.includes('security') ||
      lowerDesc.includes('vulnerability') || lowerDesc.includes('credential') ||
      lowerDesc.includes('password') || lowerDesc.includes('injection') ||
      lowerType.includes('unauthorized')) {
    type = 'Security Issue';
    icon = '🔒';
  } else if (lowerType.includes('performance') || lowerDesc.includes('performance') ||
             lowerDesc.includes('slow') || lowerDesc.includes('inefficient') ||
             lowerDesc.includes('optimization') || lowerDesc.includes('memory')) {
    type = 'Performance Issue';
    icon = '⚡';
  } else if (lowerType.includes('logic') || lowerType.includes('bug') ||
             lowerDesc.includes('null') || lowerDesc.includes('exception') ||
             lowerDesc.includes('error') || lowerDesc.includes('crash') ||
             lowerType.includes('incomplete update') || lowerType.includes('dead code')) {
    type = 'Logic Issue';
    icon = '🐛';
  } else if (lowerType.includes('code quality') || lowerType.includes('quality') || 
             lowerType.includes('style') || lowerDesc.includes('naming') || 
             lowerDesc.includes('convention') || lowerDesc.includes('maintainability') || 
             lowerDesc.includes('readability') || lowerDesc.includes('unclear') ||
             lowerType.includes('unused')) {
    type = 'Code Quality';
    icon = '📝';
  } else if (lowerType.includes('unused import') || lowerType.includes('import') ||
             lowerDesc.includes('import') || lowerDesc.includes('unused') ||
             lowerType.includes('dead code')) {
    type = 'Code Cleanup';
    icon = '🧹';
  } else if (lowerType.includes('documentation') || lowerDesc.includes('comment') ||
             lowerDesc.includes('javadoc') || lowerDesc.includes('docs')) {
    type = 'Documentation';
    icon = '📚';
  } else if (lowerType.includes('business logic') || lowerDesc.includes('business') ||
             lowerDesc.includes('functional')) {
    type = 'Business Logic';
    icon = '📊';
  }
  
  return { type, icon };
}

/**
 * Generate fix suggestion based on issue type and description (Enhanced)
 */
function generateFixSuggestion(issueType, description) {
  const lowerType = (issueType || '').toLowerCase();
  const lowerDesc = (description || '').toLowerCase();
  
  // Enhanced fixes for common AI issue types
  if (lowerType.includes('incomplete update')) {
    return 'Complete the update by including all necessary field modifications or add proper validation';
  }
  
  if (lowerType.includes('dead code') || lowerType.includes('unused')) {
    return 'Remove the unused code or provide proper documentation explaining its purpose';
  }
  
  if (lowerType.includes('business logic')) {
    if (lowerDesc.includes('price')) {
      return 'Verify if this business logic change is intentional and document the reasoning';
    }
    return 'Review the business logic change and ensure it meets requirements';
  }
  
  if (lowerType.includes('code smell')) {
    if (lowerDesc.includes('tempmethod') || lowerDesc.includes('unclear purpose')) {
      return 'Remove the method if not needed, or rename it to be more descriptive and add proper documentation';
    }
    return 'Refactor the code to improve clarity and remove code smells';
  }
  
  if (lowerType.includes('unused import') || lowerType.includes('import')) {
    return 'Remove the unused import statement';
  }
  
  if (lowerType.includes('security')) {
    if (lowerDesc.includes('password') || lowerDesc.includes('credential')) {
      return 'Move sensitive data to environment variables or secure configuration';
    }
    if (lowerDesc.includes('injection')) {
      return 'Use parameterized queries and proper input validation';
    }
    return 'Review security implications and implement appropriate safeguards';
  }
  
  if (lowerType.includes('performance')) {
    if (lowerDesc.includes('loop')) {
      return 'Consider using more efficient data structures or algorithms';
    }
    if (lowerDesc.includes('query') || lowerDesc.includes('database')) {
      return 'Optimize database queries and add proper indexing';
    }
    if (lowerDesc.includes('memory')) {
      return 'Optimize memory usage and avoid unnecessary object creation';
    }
    return 'Profile and optimize the performance bottleneck';
  }
  
  if (lowerType.includes('logic') || lowerType.includes('bug')) {
    if (lowerDesc.includes('null')) {
      return 'Add null checks or use optional chaining';
    }
    if (lowerDesc.includes('exception')) {
      return 'Add proper error handling with try-catch blocks';
    }
    return 'Review the logic and add appropriate safeguards';
  }
  
  if (lowerType.includes('quality') || lowerType.includes('style')) {
    if (lowerDesc.includes('naming')) {
      return 'Use more descriptive and conventional naming';
    }
    if (lowerDesc.includes('method') && lowerDesc.includes('long')) {
      return 'Break down into smaller, more focused methods';
    }
    return 'Refactor to improve code clarity and maintainability';
  }
  
  if (lowerType.includes('documentation')) {
    return 'Add comprehensive documentation explaining the purpose and usage';
  }
  
  return 'Review and address the identified issue';
}

/**
 * Format a professional inline comment
 */
function formatProfessionalComment(issue) {
  const severityEmoji = {
    'critical': '🚨',
    'high': '⚠️',
    'medium': '📋',
    'low': '💡'
  };
  
  const emoji = severityEmoji[issue.severity] || '📋';
  
  return `${issue.icon} **${issue.type}** ${emoji}\n\n` +
         `**Issue:** ${issue.problem}\n\n` +
         `**Suggested Fix:** ${issue.fix}\n\n` +
         `**Severity:** ${issue.severity.toUpperCase()}`;
}

/**
 * Post AI-identified line-specific issues using enhanced keyFindings
 */
export async function postLineSpecificIssues({
  repositoryName,
  pullRequestId,
  beforeCommitId,
  afterCommitId,
  filePath,
  aiAnalysis,
  beforeContent,
  afterContent,
  keyFindings = null  // Accept pre-processed keyFindings
}) {
  const results = [];
  
  try {
    // Validate inputs
    if (!repositoryName || !pullRequestId || !filePath) {
      throw new Error('Missing required parameters for posting comments');
    }
    
    // For modified files, get changed lines for validation
    let changedLines = [];
    if (beforeContent && afterContent) {
      changedLines = getChangedLines(beforeContent, afterContent);
    }
    
    // Use enhanced keyFindings if available, otherwise fall back to text parsing
    let lineIssues = [];
    if (keyFindings) {
      lineIssues = extractLineSpecificIssuesFromKeyFindings(keyFindings, aiAnalysis);
    } else {
      lineIssues = extractLineSpecificIssuesLegacy(aiAnalysis);
    }
    
    if (lineIssues.length === 0) {
      return [{
        success: true,
        message: 'No line-specific issues identified',
        filePath
      }];
    }
    
    // Limit to prevent spam
    const maxComments = 10;
    let issuesToPost = lineIssues;
    if (issuesToPost.length > maxComments) {
      issuesToPost = issuesToPost
        .sort((a, b) => {
          const severityOrder = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
          return severityOrder[b.severity] - severityOrder[a.severity];
        })
        .slice(0, maxComments);
    }
    
    // Post all line-specific issues identified by AI
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
          content: commentContent
        });
        
        results.push(issueComment);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (commentError) {
        console.error(`❌ Failed to post comment for line ${issue.line}:`, commentError.message);
        results.push({
          success: false,
          error: commentError.message,
          filePath,
          line: issue.line
        });
      }
    }
    
  } catch (error) {
    console.error(`❌ Failed to post line-specific issue comments for ${filePath}:`, error.message);
    results.push({
      success: false,
      error: error.message,
      filePath
    });
  }
  
  return results;
}

/**
 * Simple AI analysis comment (fallback)
 */
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
    return {
      success: false,
      error: error.message,
      filePath
    };
  }
}

/**
 * Check if commenting is enabled
 */
export function isCommentingEnabled() {
  return process.env.CODECOMMIT_COMMENTS_ENABLED !== 'false';
}
