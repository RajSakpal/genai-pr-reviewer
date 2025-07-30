/**
 * Language detection and language-specific patterns
 */

/**
 * Detect programming language from file extension
 */
export function detectLanguage(filename) {
  const extension = filename.split('.').pop()?.toLowerCase();
  
  const languageMap = {
    'js': 'JavaScript',
    'jsx': 'JavaScript',
    'ts': 'TypeScript', 
    'tsx': 'TypeScript',
    'java': 'Java',
    'py': 'Python',
    'rb': 'Ruby',
    'php': 'PHP',
    'go': 'Go',
    'rs': 'Rust',
    'c': 'C',
    'cpp': 'C++',
    'cc': 'C++',
    'cxx': 'C++',
    'cs': 'C#',
    'swift': 'Swift',
    'kt': 'Kotlin',
    'scala': 'Scala',
    'clj': 'Clojure',
    'hs': 'Haskell',
    'ml': 'OCaml',
    'fs': 'F#',
    'dart': 'Dart',
    'lua': 'Lua',
    'r': 'R',
    'jl': 'Julia',
    'sh': 'Shell',
    'bash': 'Bash',
    'ps1': 'PowerShell',
    'sql': 'SQL',
    'html': 'HTML',
    'css': 'CSS',
    'scss': 'SCSS',
    'less': 'LESS',
    'vue': 'Vue',
    'svelte': 'Svelte',
    'xml': 'XML',
    'json': 'JSON',
    'yaml': 'YAML',
    'yml': 'YAML',
    'toml': 'TOML',
    'dockerfile': 'Docker',
    'tf': 'Terraform'
  };

  return languageMap[extension] || 'Unknown';
}

/**
 * Language-specific patterns for different programming languages
 */
export function getLanguagePatterns(fileExtension) {
  const patterns = {
    // JavaScript/TypeScript
    'js': {
      imports: [/^import\s/, /^const\s+.*=\s+require/, /^export\s/, /^module\.exports/],
      functions: [/^function\s+\w+/, /^const\s+\w+\s*=\s*\(/, /^async\s+function/, /^\w+\s*:\s*function/, /^\w+\s*\(.*\)\s*=>/],
      classes: [/^class\s+\w+/, /^export\s+class\s+\w+/]
    },
    'ts': {
      imports: [/^import\s/, /^export\s/, /^declare\s/],
      functions: [/^function\s+\w+/, /^const\s+\w+\s*=\s*\(/, /^async\s+function/, /^\w+\s*:\s*function/, /^\w+\s*\(.*\)\s*=>/],
      classes: [/^class\s+\w+/, /^export\s+class\s+\w+/, /^interface\s+\w+/, /^type\s+\w+/]
    },
    // Java
    'java': {
      imports: [/^import\s/, /^package\s/],
      functions: [/^(public|private|protected|static).*\w+\s*\(/, /^\w+\s+\w+\s*\(/],
      classes: [/^(public|private|protected)?\s*(class|interface|enum)\s+\w+/, /^@\w+/]
    },
    // Python
    'py': {
      imports: [/^import\s/, /^from\s+.*import/, /^__all__\s*=/],
      functions: [/^def\s+\w+/, /^async\s+def\s+\w+/, /^class\s+\w+.*:/],
      classes: [/^class\s+\w+/]
    },
    // C/C++
    'c': {
      imports: [/^#include/, /^#define/, /^#ifdef/, /^#ifndef/],
      functions: [/^\w+\s+\w+\s*\(/, /^static\s+\w+/, /^extern\s+\w+/],
      classes: [/^struct\s+\w+/, /^typedef\s+struct/, /^enum\s+\w+/]
    },
    'cpp': {
      imports: [/^#include/, /^#define/, /^using\s+namespace/, /^namespace\s+\w+/],
      functions: [/^\w+\s+\w+\s*\(/, /^static\s+\w+/, /^virtual\s+\w+/, /^inline\s+\w+/],
      classes: [/^class\s+\w+/, /^struct\s+\w+/, /^template\s*</, /^namespace\s+\w+/]
    },
    // C#
    'cs': {
      imports: [/^using\s/, /^namespace\s/],
      functions: [/^(public|private|protected|internal|static).*\w+\s*\(/, /^\w+\s+\w+\s*\(/],
      classes: [/^(public|private|protected|internal)?\s*(class|interface|struct|enum)\s+\w+/]
    },
    // Go
    'go': {
      imports: [/^import\s/, /^package\s/],
      functions: [/^func\s+\w+/, /^func\s+\(\w+\s+\*?\w+\)\s+\w+/],
      classes: [/^type\s+\w+\s+struct/, /^type\s+\w+\s+interface/]
    },
    // Rust
    'rs': {
      imports: [/^use\s/, /^extern\s+crate/, /^mod\s+\w+/],
      functions: [/^fn\s+\w+/, /^pub\s+fn\s+\w+/, /^async\s+fn\s+\w+/],
      classes: [/^struct\s+\w+/, /^enum\s+\w+/, /^trait\s+\w+/, /^impl\s+/]
    },
    // PHP
    'php': {
      imports: [/^require/, /^include/, /^use\s/, /^namespace\s/],
      functions: [/^function\s+\w+/, /^(public|private|protected)\s+function\s+\w+/],
      classes: [/^(abstract\s+)?(class|interface|trait)\s+\w+/]
    },
    // Ruby
    'rb': {
      imports: [/^require/, /^include\s/, /^extend\s/, /^module\s+\w+/],
      functions: [/^def\s+\w+/, /^def\s+self\.\w+/],
      classes: [/^class\s+\w+/, /^module\s+\w+/]
    }
  };

  return patterns[fileExtension] || {
    imports: [/^import\s/, /^include\s/, /^require/, /^use\s/], // Generic fallback
    functions: [/^function\s/, /^def\s/, /^fn\s/, /^\w+\s*\(/],
    classes: [/^class\s/, /^struct\s/, /^interface\s/]
  };
}

/**
 * Check if file is architecturally important
 */
export function isArchitecturallyImportant(filename, fileExtension) {
  const architecturalPatterns = {
    'js': [/index\.js$/, /app\.js$/, /main\.js$/, /config/, /router/, /controller/, /service/],
    'ts': [/index\.ts$/, /app\.ts$/, /main\.ts$/, /\.d\.ts$/, /types/, /interfaces/],
    'java': [/Application\.java$/, /Config\.java$/, /Controller\.java$/, /Service\.java$/, /Repository\.java$/],
    'py': [/__init__\.py$/, /main\.py$/, /app\.py$/, /settings\.py$/, /config\.py$/],
    'go': [/main\.go$/, /init\.go$/, /config\.go$/],
    'rs': [/main\.rs$/, /lib\.rs$/, /mod\.rs$/],
    'php': [/index\.php$/, /config\.php$/, /bootstrap\.php$/],
    'cs': [/Program\.cs$/, /Startup\.cs$/, /\.Designer\.cs$/]
  };

  const patterns = architecturalPatterns[fileExtension] || [];
  return patterns.some(pattern => pattern.test(filename));
}

/**
 * Check for public API changes (language-specific)
 */
export function hasPublicApiChanges(specificChanges, fileExtension) {
  const publicPatterns = {
    'java': ['public ', 'protected '],
    'cs': ['public ', 'protected ', 'internal '],
    'cpp': ['public:', 'protected:'],
    'py': [], // Python doesn't have explicit public/private
    'js': ['export ', 'module.exports'],
    'ts': ['export ', 'public '],
    'go': [], // Go uses capitalization for public
    'rs': ['pub '],
    'php': ['public ', 'protected ']
  };

  const patterns = publicPatterns[fileExtension] || ['public '];
  
  return [...specificChanges.addedFunctions, ...specificChanges.addedClasses]
    .some(item => patterns.some(pattern => item.includes(pattern)));
}
