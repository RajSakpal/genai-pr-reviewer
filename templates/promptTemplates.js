/**
 * AI prompt templates for different file types and languages
 */
import { PromptTemplate } from "@langchain/core/prompts";

// Language-agnostic modified file template with line-specific analysis and guidelines
export const modifiedFileTemplate = new PromptTemplate({
  template: `You are a senior software engineer reviewing a Pull Request diff for a {language} file.

{guidelinesSection}

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

**CRITICAL INSTRUCTION**: When you identify issues, you MUST specify the exact line number in the AFTER version where the issue exists. Use this format for any issues found:
- **Line X: [Issue Type]** - Description of the issue and suggested fix

**IMPORTANT**: Focus ONLY on the actual changes between BEFORE and AFTER versions. Apply the guidelines provided above to identify standards violations.

Analyze the specific changes and provide:
1. **What Changed**: Identify exactly what was added, removed, or modified
2. **Guidelines Compliance**: Check changes against the provided guidelines above
3. **Line-by-Line Issues**: For each problematic line, specify:
   - **Line [number]: [Issue Type]** - Problem description
   - **Fix**: Specific solution based on guidelines
   - **Severity**: Critical/High/Medium/Low
4. **Purpose Analysis**: Is the change necessary? Does it serve a clear purpose?
5. **Security Impact**: Security implications specific to {language} and these changes
6. **Code Quality**: Quality issues with the new/modified code following {language} best practices and guidelines
7. **Logic Issues**: Potential bugs introduced by these specific changes
8. **Integration Impact**: How these changes affect related code {contextPromptAddition}
9. **Language-Specific Issues**: {language}-specific concerns (performance, memory, etc.)

{contextAnalysisInstructions}

**REMINDER**: Always include line numbers when reporting issues and reference specific guidelines when applicable. Example:
- **Line 25: Security Issue** - Hardcoded password detected (violates security guideline)
- **Line 30: Code Quality** - Method name is not descriptive (violates naming conventions)
- **Line 45: Logic Issue** - Potential null pointer exception

Focus on the diff but prioritize guideline compliance and {language} idioms.`,
  inputVariables: ["filename", "beforeContent", "afterContent", "contextSection", "guidelinesSection", "contextPromptAddition", "contextAnalysisInstructions", "language"],
});

// Language-agnostic new file template with line-specific analysis and guidelines
export const newFileTemplate = new PromptTemplate({
  template: `You are a senior software engineer reviewing a new {language} file in a Pull Request.

{guidelinesSection}

New File: {filename}

Content:
\`\`\`{language}
{content}
\`\`\`

{contextSection}

**CRITICAL INSTRUCTION**: When you identify issues, you MUST specify the exact line number where the issue exists. Use this format for any issues found:
- **Line X: [Issue Type]** - Description of the issue and suggested fix

**IMPORTANT**: Apply the guidelines provided above to ensure this new file meets coding standards.

Analyze this new {language} file specifically:
1. **File Purpose**: What is this {language} file intended to do?
2. **Guidelines Compliance**: Comprehensive check against the provided guidelines above
3. **Line-by-Line Issues**: For each problematic line, specify:
   - **Line [number]: [Issue Type]** - Problem description
   - **Fix**: Specific solution based on guidelines
   - **Severity**: Critical/High/Medium/Low
4. **Code Structure**: Organization and architecture following {language} patterns and guidelines
5. **Security**: Potential vulnerabilities specific to {language} per security guidelines
6. **Best Practices**: Adherence to {language} coding standards, idioms, and provided guidelines
7. **Dependencies**: Analysis of imports/includes and their appropriateness per guidelines
8. **Integration**: How well it fits with existing codebase patterns
9. **Language-Specific Quality**: {language}-specific performance and design considerations per guidelines

**REMINDER**: Always include line numbers when reporting issues and reference specific guidelines when applicable. Example:
- **Line 15: Security Issue** - SQL injection vulnerability detected (violates security guidelines)
- **Line 23: Performance Issue** - Inefficient loop structure (violates performance guidelines)
- **Line 38: Code Quality** - Variable naming doesn't follow conventions (violates naming guidelines)

Focus on this file's implementation, guideline compliance, and how it follows {language} conventions.`,
  inputVariables: ["filename", "content", "contextSection", "guidelinesSection", "language"],
});
