/**
 * Generic change analysis for all programming languages
 */
import { getLanguagePatterns, hasPublicApiChanges, isArchitecturallyImportant } from './languageDetector.js';

/**
 * Universal import detection
 */
function isImportLine(line, languagePatterns) {
  return languagePatterns.imports.some(pattern => pattern.test(line));
}

/**
 * Universal function detection
 */
function isFunctionDeclaration(line, languagePatterns) {
  return languagePatterns.functions.some(pattern => pattern.test(line));
}

/**
 * Universal class detection
 */
function isClassDeclaration(line, languagePatterns) {
  return languagePatterns.classes.some(pattern => pattern.test(line));
}

/**
 * Universal change analysis for all programming languages
 */
export function analyzeSpecificChanges(beforeContent, afterContent, filename) {
  const beforeLines = beforeContent.split('\n').map(line => line.trim()).filter(line => line);
  const afterLines = afterContent.split('\n').map(line => line.trim()).filter(line => line);
  
  const changes = {
    addedImports: [],
    removedImports: [],
    addedFunctions: [],
    removedFunctions: [],
    addedClasses: [],
    removedClasses: [],
    addedLines: [],
    removedLines: [],
    modifiedLines: []
  };

  const fileExtension = filename.split('.').pop()?.toLowerCase();
  const languagePatterns = getLanguagePatterns(fileExtension);

  // Detect import/include changes (universal)
  beforeLines.forEach(line => {
    if (isImportLine(line, languagePatterns) && !afterLines.includes(line)) {
      changes.removedImports.push(line);
    }
  });

  afterLines.forEach(line => {
    if (isImportLine(line, languagePatterns) && !beforeLines.includes(line)) {
      changes.addedImports.push(line);
    }
  });

  // Detect function/method changes (universal)
  beforeLines.forEach(line => {
    if (isFunctionDeclaration(line, languagePatterns) && !afterLines.includes(line)) {
      changes.removedFunctions.push(line);
    }
  });

  afterLines.forEach(line => {
    if (isFunctionDeclaration(line, languagePatterns) && !beforeLines.includes(line)) {
      changes.addedFunctions.push(line);
    }
  });

  // Detect class/struct changes (universal)
  beforeLines.forEach(line => {
    if (isClassDeclaration(line, languagePatterns) && !afterLines.includes(line)) {
      changes.removedClasses.push(line);
    }
  });

  afterLines.forEach(line => {
    if (isClassDeclaration(line, languagePatterns) && !beforeLines.includes(line)) {
      changes.addedClasses.push(line);
    }
  });

  // Detect other added/removed lines
  beforeLines.forEach(line => {
    if (!isImportLine(line, languagePatterns) && 
        !isFunctionDeclaration(line, languagePatterns) && 
        !isClassDeclaration(line, languagePatterns) &&
        !afterLines.includes(line)) {
      changes.removedLines.push(line);
    }
  });

  afterLines.forEach(line => {
    if (!isImportLine(line, languagePatterns) && 
        !isFunctionDeclaration(line, languagePatterns) && 
        !isClassDeclaration(line, languagePatterns) &&
        !beforeLines.includes(line)) {
      changes.addedLines.push(line);
    }
  });

  return changes;
}

/**
 * Generate a concise diff summary
 */
export function generateDiffSummary(changes) {
  const summaryParts = [];
  
  if (changes.addedImports.length > 0) {
    summaryParts.push(`+${changes.addedImports.length} imports`);
  }
  if (changes.removedImports.length > 0) {
    summaryParts.push(`-${changes.removedImports.length} imports`);
  }
  if (changes.addedFunctions.length > 0) {
    summaryParts.push(`+${changes.addedFunctions.length} functions`);
  }
  if (changes.removedFunctions.length > 0) {
    summaryParts.push(`-${changes.removedFunctions.length} functions`);
  }
  if (changes.addedClasses.length > 0) {
    summaryParts.push(`+${changes.addedClasses.length} classes`);
  }  
  if (changes.removedClasses.length > 0) {
    summaryParts.push(`-${changes.removedClasses.length} classes`);
  }
  if (changes.addedLines.length > 0) {
    summaryParts.push(`+${changes.addedLines.length} lines`);
  }
  if (changes.removedLines.length > 0) {
    summaryParts.push(`-${changes.removedLines.length} lines`);
  }

  return summaryParts.length > 0 ? summaryParts.join(', ') : 'Minor changes';
}

/**
 * Generic context decision logic
 */
export function shouldUseContext(specificChanges, filename) {
  const fileExtension = filename.split('.').pop()?.toLowerCase();
  
  // Always use context if:
  const hasNewImports = specificChanges.addedImports.length > 0;
  const hasNewFunctions = specificChanges.addedFunctions.length > 0;
  const hasNewClasses = specificChanges.addedClasses.length > 0;
  const hasRemovedFunctions = specificChanges.removedFunctions.length > 0;
  const hasRemovedClasses = specificChanges.removedClasses.length > 0;
  
  // Language-specific context rules
  const isArchitecturalFile = isArchitecturallyImportant(filename, fileExtension);
  const hasPublicChanges = hasPublicApiChanges(specificChanges, fileExtension);
  
  return hasNewImports || hasNewFunctions || hasNewClasses || 
         hasRemovedFunctions || hasRemovedClasses || 
         isArchitecturalFile || hasPublicChanges;
}

/**
 * Generate context-aware prompt addition for modified files
 */
export function generateContextAwarePromptAddition(specificChanges) {
  const contextNeeds = [];
  
  if (specificChanges.addedImports.length > 0) {
    contextNeeds.push("Check how new imports relate to existing codebase patterns");
  }
  if (specificChanges.addedFunctions.length > 0) {
    contextNeeds.push("Analyze if new functions follow existing architectural patterns");
  }
  if (specificChanges.removedFunctions.length > 0) {
    contextNeeds.push("Check if removed functions are used elsewhere in the codebase");
  }
  
  return contextNeeds.length > 0 ? 
    `\n**Context Analysis Needed**: ${contextNeeds.join(', ')}` : '';
}
