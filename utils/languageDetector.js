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

