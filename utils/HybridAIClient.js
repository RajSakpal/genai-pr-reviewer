import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { OllamaClient } from "./ollamaClient.js";
import dotenv from "dotenv";

dotenv.config();

export class HybridAIClient {
  constructor() {
    // Initialize Gemini client
    this.geminiClient = new ChatGoogleGenerativeAI({
      model: "gemini-1.5-flash",
      apiKey: process.env.GOOGLE_API_KEY,
      temperature: 0.3,
    });

    // Initialize Ollama client
    this.ollamaClient = new OllamaClient({
      baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'codellama:7b',
      temperature: 0.3,
    });

    // Simple switching logic
    this.useGemini = true; // Start with Gemini
    this.consecutiveGeminiErrors = 0;
    this.maxConsecutiveErrors = 3;
    
    // Statistics
    this.stats = {
      geminiSuccess: 0,
      geminiFailures: 0,
      ollamaSuccess: 0,
      ollamaFailures: 0,
      totalRequests: 0
    };
  }

  /**
   * Identify rate limit or quota errors
   */
  isRateLimitError(error) {
    const errorMessage = (error.message || '').toLowerCase();
    const errorCode = error.code || error.status;
    
    return errorMessage.includes('quota') ||
           errorMessage.includes('rate limit') ||
           errorMessage.includes('too many requests') ||
           errorCode === 429 ||
           errorCode === 403;
  }

  /**
   * Main invoke method with simple switching logic
   */
  async invoke(prompt, options = {}) {
    this.stats.totalRequests++;
    
    // Try Gemini if currently selected
    if (this.useGemini) {
      try {
        console.log(`🌟 Using Gemini...`);
        
        const response = await this.geminiClient.invoke(prompt, options);
        
        // Success - reset error counter
        this.consecutiveGeminiErrors = 0;
        this.stats.geminiSuccess++;
        
        console.log(`✅ Gemini success`);
        
        return {
          content: response.content,
          provider: 'gemini',
          model: 'gemini-1.5-flash'
        };
        
      } catch (error) {
        this.consecutiveGeminiErrors++;
        this.stats.geminiFailures++;
        
        console.error(`❌ Gemini failed:`, error.message);
        
        // Switch to Ollama on rate limit or too many consecutive errors
        if (this.isRateLimitError(error) || this.consecutiveGeminiErrors >= this.maxConsecutiveErrors) {
          console.log(`🔄 Switching to Ollama due to ${this.isRateLimitError(error) ? 'rate limit' : 'consecutive errors'}`);
          this.useGemini = false;
          this.consecutiveGeminiErrors = 0;
        }
        
        // Fall through to Ollama
        console.log(`🔄 Falling back to Ollama...`);
      }
    } else {
      console.log(`🤖 Using Ollama (Gemini switched off)`);
    }

    // Use Ollama (either as fallback or primary)
    try {
      const response = await this.ollamaClient.invoke(prompt, options);
      this.stats.ollamaSuccess++;
      
      console.log(`✅ Ollama success`);
      
      return {
        content: response.content,
        provider: 'ollama',
        model: this.ollamaClient.model
      };
      
    } catch (error) {
      this.stats.ollamaFailures++;
      console.error(`❌ Ollama failed:`, error.message);
      
      // If Ollama fails and we're not using Gemini, try switching back
      if (!this.useGemini) {
        console.log(`🔄 Switching back to Gemini due to Ollama failure`);
        this.useGemini = true;
        this.consecutiveGeminiErrors = 0;
      }
      
      // Both providers failed
      throw new Error(`Both AI providers failed - Last errors: Gemini: ${this.consecutiveGeminiErrors} errors, Ollama: ${error.message}`);
    }
  }

  /**
   * Get usage statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentProvider: this.useGemini ? 'gemini' : 'ollama',
      consecutiveGeminiErrors: this.consecutiveGeminiErrors,
      successRate: {
        gemini: this.stats.geminiSuccess / (this.stats.geminiSuccess + this.stats.geminiFailures) || 0,
        ollama: this.stats.ollamaSuccess / (this.stats.ollamaSuccess + this.stats.ollamaFailures) || 0,
        overall: (this.stats.geminiSuccess + this.stats.ollamaSuccess) / this.stats.totalRequests || 0
      }
    };
  }

  /**
   * Force switch to Ollama
   */
  forceOllamaMode() {
    this.useGemini = false;
    this.consecutiveGeminiErrors = 0;
    console.log('🔧 Forced switch to Ollama mode');
  }

  /**
   * Force switch to Gemini
   */
  forceGeminiMode() {
    this.useGemini = true;
    this.consecutiveGeminiErrors = 0;
    console.log('🔧 Forced switch to Gemini mode');
  }
}
