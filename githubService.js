import { Octokit } from "@octokit/rest";
import analyzeDiffWithAI from "./langchainAgent.js";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

/**
 * Parse diff patch to extract line numbers and changes
 * @param {string} patch - The diff patch string
 * @returns {Array} Array of change objects with line numbers and content
 */
function parseDiffPatch(patch) {
  const lines = patch.split('\n');
  const changes = [];
  let currentLine = 1;
  let addedLines = [];
  let removedLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Parse hunk header (@@)
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+,?\d* \+(\d+),?\d* @@/);
      if (match) {
        currentLine = parseInt(match[1]);
      }
      continue;
    }
    
    // Track added lines (+)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push({
        line: currentLine,
        content: line.substring(1), // Remove the '+' prefix
        type: 'added'
      });
      currentLine++;
    }
    // Track removed lines (-)
    else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines.push({
        content: line.substring(1), // Remove the '-' prefix
        type: 'removed'
      });
      // Don't increment currentLine for removed lines
    }
    // Context lines (unchanged)
    else if (line.startsWith(' ')) {
      currentLine++;
    }
  }
  
  // Combine changes for analysis
  changes.push(...addedLines, ...removedLines);
  return { changes: addedLines, removedLines, allChanges: changes };
}

/**
 * Analyze specific code changes and generate targeted suggestions
 * @param {string} patch - The diff patch
 * @param {string} filename - The filename being analyzed
 * @returns {Array} Array of suggestions with line numbers
 */
async function analyzeSpecificChanges(patch, filename) {
  const { changes, allChanges } = parseDiffPatch(patch);
  
  if (changes.length === 0) {
    return [];
  }
  
  try {
    // Analyze the entire diff for context
    const overallAnalysis = await analyzeDiffWithAI(patch, filename);
    
    // Create suggestions for significant changes
    const suggestions = [];
    
    // Group consecutive changes for better context
    const changeGroups = groupConsecutiveChanges(changes);
    
    for (const group of changeGroups) {
      // Skip trivial changes (whitespace, comments, etc.)
      if (group.changes.some(change => isTrivialChange(change.content))) {
        continue;
      }
      
      // Create a focused diff for this group
      const groupDiff = createGroupDiff(group, allChanges);
      
      // Get AI analysis for this specific group
      const groupAnalysis = await analyzeDiffWithAI(groupDiff, filename);
      
      // Only add comment if AI found issues
      if (groupAnalysis && groupAnalysis.length > 50) { // Minimum meaningful response
        suggestions.push({
          line: group.startLine,
          body: `🤖 **AI Code Review**\n\n${groupAnalysis}`,
          startLine: group.startLine,
          endLine: group.endLine
        });
      }
    }
    
    return suggestions;
    
  } catch (error) {
    console.error(`❌ Error analyzing changes for ${filename}:`, error.message);
    return [];
  }
}

/**
 * Group consecutive line changes for better context
 */
function groupConsecutiveChanges(changes) {
  if (changes.length === 0) return [];
  
  const groups = [];
  let currentGroup = {
    startLine: changes[0].line,
    endLine: changes[0].line,
    changes: [changes[0]]
  };
  
  for (let i = 1; i < changes.length; i++) {
    const change = changes[i];
    
    // If this change is within 3 lines of the current group, add it
    if (change.line - currentGroup.endLine <= 3) {
      currentGroup.endLine = change.line;
      currentGroup.changes.push(change);
    } else {
      // Start a new group
      groups.push(currentGroup);
      currentGroup = {
        startLine: change.line,
        endLine: change.line,
        changes: [change]
      };
    }
  }
  
  groups.push(currentGroup);
  return groups;
}

/**
 * Create a focused diff for a specific group of changes
 */
function createGroupDiff(group, allChanges) {
  const relevantChanges = allChanges.filter(change => 
    change.line >= group.startLine - 2 && 
    change.line <= group.endLine + 2
  );
  
  return relevantChanges.map(change => 
    `${change.type === 'added' ? '+' : '-'} ${change.content}`
  ).join('\n');
}

/**
 * Check if a change is trivial (whitespace, formatting, comments)
 */
function isTrivialChange(content) {
  const trimmed = content.trim();
  return (
    trimmed === '' || // Empty lines
    trimmed.startsWith('//') || // Single line comments
    trimmed.startsWith('/*') || // Multi-line comments
    trimmed.startsWith('*') || // Multi-line comment continuation
    /^\s*$/.test(content) || // Only whitespace
    /^[\s\{\}]*$/.test(content) // Only braces and whitespace
  );
}

/**
 * Process a pull request and add AI-generated review comments
 */
async function processPullRequest(pr, repo) {
  const owner = repo.owner.login;
  const repoName = repo.name;
  const prNumber = pr.number;

  console.log(`📥 Processing PR #${prNumber} in ${owner}/${repoName}`);

  try {
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    let totalComments = 0;

    for (const file of files) {
      if (file.patch && file.status !== 'removed') {
        console.log(`🔍 Analyzing ${file.filename}`);
        
        const suggestions = await analyzeSpecificChanges(file.patch, file.filename);
        
        for (const suggestion of suggestions) {
          try {
            await octokit.pulls.createReviewComment({
              owner,
              repo: repoName,
              pull_number: prNumber,
              body: suggestion.body,
              commit_id: pr.head.sha,
              path: file.filename,
              side: "RIGHT",
              line: suggestion.line,
            });
            
            totalComments++;
            console.log(`💬 Added comment on line ${suggestion.line} for ${file.filename}`);
            
            // Add delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
            
          } catch (commentError) {
            console.error(`❌ Error posting comment for ${file.filename} line ${suggestion.line}:`, commentError.message);
          }
        }
      }
    }
    
    console.log(`✅ Processing complete. Added ${totalComments} review comments.`);
    
  } catch (error) {
    console.error(`❌ Error processing PR #${prNumber}:`, error.message);
  }
}

export default processPullRequest;