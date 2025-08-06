/**
 * AI prompt templates for different file types and languages
 */
import { PromptTemplate } from "@langchain/core/prompts";

// Language-agnostic modified file template with line-specific analysis and guidelines
export const modifiedFileTemplate = new PromptTemplate({
  template: `You are a senior software engineer reviewing a Pull Request diff for a {language} file.

{guidelinesSection}

**IMPORTANT ANALYSIS APPROACH**: 
- **PRIMARY**: Apply the specific guidelines provided above when relevant
- **SECONDARY**: Also apply general {language} best practices, security standards, and coding conventions
- **COMPREHENSIVE**: Don't limit your analysis only to the provided guidelines - use your full knowledge of {language} development standards

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

**ANALYSIS SCOPE**: Focus ONLY on the actual changes between BEFORE and AFTER versions. Apply:
1. The specific guidelines provided above (when applicable)
2. General {language} best practices and conventions
3. Universal security, performance, and code quality standards
4. Industry-standard coding practices

Analyze the specific changes and provide:
1. **What Changed**: Identify exactly what was added, removed, or modified
2. **Guidelines Compliance**: Check against provided guidelines AND general {language} standards
3. **Line-by-Line Issues**: For each problematic line, specify:
   - **Line [number]: [Issue Type]** - Problem description
   - **Fix**: Specific solution (reference provided guidelines OR general best practices)
   - **Severity**: Critical/High/Medium/Low
4. **Purpose Analysis**: Is the change necessary? Does it serve a clear purpose?
5. **Security Impact**: Security implications using both specific guidelines and general security principles
6. **Code Quality**: Quality issues following both provided guidelines and {language} best practices
7. **Logic Issues**: Potential bugs introduced by these specific changes
8. **Integration Impact**: How these changes affect related code {contextPromptAddition}
9. **Language-Specific Issues**: {language}-specific concerns (performance, memory, etc.)

{contextAnalysisInstructions}

**CITATION FORMAT**: 
- For provided guideline violations: "Line X: Issue - Description (violates provided guideline: 'guideline text')"
- For general standard violations: "Line X: Issue - Description (violates {language} best practice)"

Focus on the diff but use BOTH provided guidelines and your comprehensive knowledge of {language} development.`,
  inputVariables: ["filename", "beforeContent", "afterContent", "contextSection", "guidelinesSection", "contextPromptAddition", "contextAnalysisInstructions", "language"],
});


// Language-agnostic new file template with line-specific analysis and guidelines
export const newFileTemplate = new PromptTemplate({
  template: `You are a senior software engineer reviewing a new {language} file in a Pull Request.

{guidelinesSection}

**IMPORTANT ANALYSIS APPROACH**: 
- **PRIMARY**: Apply the specific guidelines provided above when relevant
- **SECONDARY**: Also apply general {language} best practices, security standards, and coding conventions  
- **COMPREHENSIVE**: Don't limit your analysis only to the provided guidelines - use your full knowledge of {language} development standards

New File: {filename}

Content:
\`\`\`{language}
{content}
\`\`\`

{contextSection}

**CRITICAL INSTRUCTION**: When you identify issues, you MUST specify the exact line number where the issue exists. Use this format for any issues found:
- **Line X: [Issue Type]** - Description of the issue and suggested fix

**ANALYSIS SCOPE**: Apply comprehensive {language} analysis using:
1. The specific guidelines provided above (when applicable)
2. General {language} best practices and conventions
3. Universal security, performance, and code quality standards
4. Industry-standard coding practices

Analyze this new {language} file comprehensively:
1. **File Purpose**: What is this {language} file intended to do?
2. **Guidelines Compliance**: Check against provided guidelines AND general {language} standards
3. **Line-by-Line Issues**: For each problematic line, specify:
   - **Line [number]: [Issue Type]** - Problem description
   - **Fix**: Specific solution (reference provided guidelines OR general best practices)
   - **Severity**: Critical/High/Medium/Low
4. **Code Structure**: Organization following both provided guidelines and {language} patterns
5. **Security**: Vulnerabilities using both specific guidelines and general security principles
6. **Best Practices**: Adherence to both provided guidelines and {language} coding standards
7. **Dependencies**: Analysis of imports/includes per guidelines and general practices
8. **Integration**: How well it fits with existing codebase patterns
9. **Language-Specific Quality**: {language}-specific considerations per guidelines and best practices

**CITATION FORMAT**: 
- For provided guideline violations: "Line X: Issue - Description (violates provided guideline: 'guideline text')"
- For general standard violations: "Line X: Issue - Description (violates {language} best practice)"

Apply BOTH provided guidelines and your comprehensive knowledge of {language} development standards.`,
  inputVariables: ["filename", "content", "contextSection", "guidelinesSection", "language"],
});

