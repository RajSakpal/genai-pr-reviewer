import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PromptTemplate } from "@langchain/core/prompts";

/**
 * Initialize Google Gemini AI model for code analysis
 * Temperature set to 0.3 for balanced creativity and consistency
 */
const model = new ChatGoogleGenerativeAI({
  model: "gemini-1.5-flash",
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 0.3,
});

/**
 * Dynamic prompt template that adapts based on the type of code change
 * Uses different context and guidance for new files vs modified files
 */
const promptTemplate = new PromptTemplate({
  template: `
You are a senior software engineer reviewing a GitHub Pull Request.

{changeContext}

The following are the code changes in the file: \`{filename}\`

--------------------------
{patch}
--------------------------

Provide clear, concise, and constructive feedback on the changes.
Point out potential issues, improvements, or best practices.
If nothing major is wrong, affirm that.

{analysisGuidance}
`,
  inputVariables: ["patch", "filename", "changeContext", "analysisGuidance"],
});

/**
 * Analyze code changes using AI with context-aware prompts
 * 
 * @param {string} patch - The diff/patch content to analyze
 * @param {string} filename - Name of the file being analyzed
 * @param {string} changeType - Type of change: 'A' (Added/New), 'M' (Modified), etc.
 * @returns {Promise<string>} - AI-generated analysis and suggestions
 */
export async function analyzeDiffWithAI(patch, filename, changeType = 'M') {
  try {
    // Customize the prompt based on the type of change
    let changeContext = '';
    let analysisGuidance = '';
    
    switch (changeType) {
      case 'A':
        // New file - focus on overall structure and design
        changeContext = 'This is a **NEW FILE** that has been added to the repository.';
        analysisGuidance = `
For new files, focus on:
- Code structure and organization
- Naming conventions and clarity
- Security considerations
- Performance implications
- Documentation and comments
- Dependencies and imports
- Error handling
- Test coverage needs`;
        break;
        
      case 'M':
        // Modified file - focus on changes and their impact
        changeContext = 'This is a **MODIFIED FILE** with changes from the original version.';
        analysisGuidance = `
For modified files, focus on:
- What changed and why it might have changed
- Backward compatibility
- Impact on existing functionality
- Code quality improvements or regressions
- Security implications of changes`;
        break;
        
      default:
        // Fallback for other change types
        changeContext = 'This file has been updated.';
        analysisGuidance = 'Focus on code quality, security, and best practices.';
    }
    
    // Format the prompt with file-specific context
    const prompt = await promptTemplate.format({ 
      patch, 
      filename,
      changeContext,
      analysisGuidance
    });
    
    // Send to AI model and return analysis
    const response = await model.invoke(prompt);
    return response.content;
  } catch (error) {
    console.error("❌ AI analysis failed:", error.message);
    throw error;
  }
}