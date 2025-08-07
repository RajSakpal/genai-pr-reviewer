/**
 * AI prompt templates with line numbering for accurate line references
 */
import { PromptTemplate } from "@langchain/core/prompts";

// Language-agnostic modified file template with line-numbered content
export const modifiedFileTemplate = new PromptTemplate({
  template: `You are a senior software engineer reviewing a Pull Request diff for a {language} file.

{guidelinesSection}

**IMPORTANT ANALYSIS APPROACH**: 
- **PRIMARY**: Apply the specific guidelines provided above when relevant
- **SECONDARY**: Also apply general {language} best practices, security standards, and coding conventions
- **COMPREHENSIVE**: Don't limit your analysis only to the provided guidelines - use your full knowledge of {language} development standards

File: {filename}

BEFORE (Original) - with line numbers:
\`\`\`{language}
{beforeContent}
\`\`\`

AFTER (Modified) - with line numbers:
\`\`\`{language}
{afterContent}
\`\`\`

{contextSection}

**CRITICAL LINE NUMBER INSTRUCTION**: 
- The code above shows BOTH versions with prefixed line numbers
- BEFORE version lines are prefixed with "BEFORE-XXX:"
- AFTER version lines are prefixed with "AFTER-XXX:"
- When identifying issues, ONLY reference AFTER line numbers
- Format: **Line X: [Issue Type]** where X is the AFTER line number (without the AFTER- prefix)

**EXAMPLES:**
If you see:
\`\`\`
BEFORE-010: public class Service {{
BEFORE-011:     @Autowired private Repository repo;
BEFORE-012: }}
\`\`\`

\`\`\`
AFTER-010: public class Service {{
AFTER-011:     @Autowired private Repository repo;
AFTER-012:     private final String newField;
AFTER-013: }}
\`\`\`

Then report issues like:
- **Line 11: [Code Quality]** - Use constructor injection instead of field injection
- **Line 12: [Code Quality]** - New field should be initialized in constructor

**REQUIRED FORMAT:**
- **Line X: [Issue Type]** - Description and suggested fix
- Use ONLY the numeric part of AFTER line numbers
- Valid issue types: [Code Quality], [Logic Issue], [Security Issue], [Performance Issue], [Business Logic], [Code Cleanup], [Documentation]

**ANALYSIS SCOPE**: Focus on the actual changes between BEFORE and AFTER versions. Apply:
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
- For provided guideline violations: "Line X: [Issue Type] - Description (violates provided guideline: 'guideline text')"
- For general standard violations: "Line X: [Issue Type] - Description (violates {language} best practice)"

**FINAL REMINDER**: 
- Reference ONLY AFTER line numbers (without the AFTER- prefix)
- Always use the exact format **Line X: [Issue Type]** with bracketed issue types
- Verify your line numbers correspond to the AFTER version`,
  
  inputVariables: ["filename", "beforeContent", "afterContent", "contextSection", "guidelinesSection", "contextPromptAddition", "contextAnalysisInstructions", "language"],
});

// Language-agnostic new file template with line-numbered content
export const newFileTemplate = new PromptTemplate({
  template: `You are a senior software engineer reviewing a new {language} file in a Pull Request.

{guidelinesSection}

**IMPORTANT ANALYSIS APPROACH**: 
- **PRIMARY**: Apply the specific guidelines provided above when relevant
- **SECONDARY**: Also apply general {language} best practices, security standards, and coding conventions  
- **COMPREHENSIVE**: Don't limit your analysis only to the provided guidelines - use your full knowledge of {language} development standards

New File: {filename}

Content with line numbers:
\`\`\`{language}
{content}
\`\`\`

{contextSection}

**LINE NUMBER INSTRUCTION**: 
- The code above includes line numbers in format "  X: code"
- When identifying issues, reference the line number X
- Format: **Line X: [Issue Type]** - Description and suggested fix

**EXAMPLE:**
If you see:
\`\`\`
  010: public class Service {{
  011:     @Autowired private Repository repo;
  012:     private final String field;
  013: }}
\`\`\`

Then report issues like:
- **Line 11: [Code Quality]** - Use constructor injection instead of field injection
- **Line 12: [Code Quality]** - Field should be initialized in constructor

**REQUIRED FORMAT:**
- **Line X: [Issue Type]** - Description and suggested fix
- Valid issue types: [Code Quality], [Logic Issue], [Security Issue], [Performance Issue], [Business Logic], [Code Cleanup], [Documentation]

**ANALYSIS SCOPE**: Comprehensive {language} analysis using:
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
- For provided guideline violations: "Line X: [Issue Type] - Description (violates provided guideline: 'guideline text')"
- For general standard violations: "Line X: [Issue Type] - Description (violates {language} best practice)"

**FINAL REMINDER**: 
- Reference line numbers as shown in the numbered content
- Always use the exact format **Line X: [Issue Type]** with bracketed issue types`,
  
  inputVariables: ["filename", "content", "contextSection", "guidelinesSection", "language"],
});
