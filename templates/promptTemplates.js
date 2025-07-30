/**
 * AI prompt templates for different file types and languages
 */
import { PromptTemplate } from "@langchain/core/prompts";

// Language-agnostic modified file template
export const modifiedFileTemplate = new PromptTemplate({
  template: `You are a senior software engineer reviewing a Pull Request diff for a {language} file.

File: {filename}

BEFORE (Original):
\`\`\`{language}
{beforeContent}
\`\`\`

AFTER (Modified):
\`\`\`{language}
{afterContent}
\`\`\`

{contextSection}

**IMPORTANT**: Focus ONLY on the actual changes between BEFORE and AFTER versions.

Analyze the specific changes and provide:
1. **What Changed**: Identify exactly what was added, removed, or modified
2. **Purpose Analysis**: Is the change necessary? Does it serve a clear purpose?
3. **Security Impact**: Security implications specific to {language} and these changes
4. **Code Quality**: Quality issues with the new/modified code following {language} best practices
5. **Logic Issues**: Potential bugs introduced by these specific changes
6. **Integration Impact**: How these changes affect related code {contextPromptAddition}
7. **Language-Specific Issues**: {language}-specific concerns (performance, memory, etc.)
8. **Suggestions**: Improvements for the specific changes made

{contextAnalysisInstructions}

Focus on the diff but consider {language} idioms and best practices.`,
  inputVariables: ["filename", "beforeContent", "afterContent", "contextSection", "contextPromptAddition", "contextAnalysisInstructions", "language"],
});

// Language-agnostic new file template
export const newFileTemplate = new PromptTemplate({
  template: `You are a senior software engineer reviewing a new {language} file in a Pull Request.

New File: {filename}

Content:
\`\`\`{language}
{content}
\`\`\`

{contextSection}

Analyze this new {language} file specifically:
1. **File Purpose**: What is this {language} file intended to do?
2. **Code Structure**: Organization and architecture following {language} patterns
3. **Security**: Potential vulnerabilities specific to {language}
4. **Best Practices**: Adherence to {language} coding standards and idioms
5. **Dependencies**: Analysis of imports/includes and their appropriateness
6. **Integration**: How well it fits with existing codebase patterns
7. **Language-Specific Quality**: {language}-specific performance and design considerations
8. **Suggestions**: Improvements specific to {language} best practices

Focus on this file's implementation and how it follows {language} conventions.`,
  inputVariables: ["filename", "content", "contextSection", "language"],
});
