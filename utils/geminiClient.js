import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import dotenv from "dotenv";

dotenv.config();

export class GeminiAIClient {
  constructor() {
    // Initialize Gemini client
    this.geminiClient = new ChatGoogleGenerativeAI({
      model: "gemini-1.5-flash",
      apiKey: process.env.GOOGLE_API_KEY,
      temperature: 0.3,
    });

    // Statistics
    this.stats = {
      success: 0,
      failures: 0,
      totalRequests: 0,
      rateLimitHits: 0,
      lastError: null
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
   * Main invoke method with retry logic for rate limits
   */
  async invoke(prompt, options = {}) {
    const maxRetries = 3;
    let attempt = 0;
    
    this.stats.totalRequests++;

    while (attempt < maxRetries) {
      try {
        console.log(`🌟 Calling Gemini... (attempt ${attempt + 1}/${maxRetries})`);
        
        const response = await this.geminiClient.invoke(prompt, {
          temperature: options.temperature || 0.3,
          maxTokens: options.maxTokens || 2048,
          ...options
        });

        this.stats.success++;
        console.log(`✅ Gemini success`);
        
        return {
          content: response.content,
          provider: 'gemini',
          model: 'gemini-1.5-flash'
        };
        
      } catch (error) {
        attempt++;
        this.stats.failures++;
        this.stats.lastError = error.message;
        
        console.error(`❌ Gemini attempt ${attempt} failed:`, error.message);
        
        // Check if it's a rate limit error
        if (this.isRateLimitError(error)) {
          this.stats.rateLimitHits++;
          
          if (attempt < maxRetries) {
            // Exponential backoff for rate limits: 2s, 8s, 32s
            const backoffTime = Math.pow(4, attempt) * 500;
            console.log(`⏳ Rate limit detected, waiting ${backoffTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            continue;
          }
        } else {
          // For non-rate-limit errors, shorter backoff: 1s, 2s, 4s
          if (attempt < maxRetries) {
            const backoffTime = Math.pow(2, attempt) * 1000;
            console.log(`⏳ Retrying in ${backoffTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            continue;
          }
        }
        
        // If we've exhausted retries
        if (attempt >= maxRetries) {
          console.error(`❌ Gemini failed after ${maxRetries} attempts`);
          throw new Error(`Gemini AI request failed after ${maxRetries} attempts: ${error.message}`);
        }
      }
    }
  }

  /**
   * Check Gemini API health
   */
  async checkHealth() {
    try {
      console.log('🔍 Checking Gemini API health...');
      
      const testResponse = await this.geminiClient.invoke("Test connection. Reply with 'OK'.");
      
      return {
        status: 'healthy',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        response: testResponse.content
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: 'gemini',
        error: error.message,
        isRateLimit: this.isRateLimitError(error)
      };
    }
  }

  /**
   * Get usage statistics
   */
  getStats() {
    const totalAttempts = this.stats.success + this.stats.failures;
    
    return {
      ...this.stats,
      provider: 'gemini',
      model: 'gemini-1.5-flash',
      successRate: totalAttempts > 0 ? (this.stats.success / totalAttempts) : 0,
      failureRate: totalAttempts > 0 ? (this.stats.failures / totalAttempts) : 0,
      rateLimitRate: this.stats.totalRequests > 0 ? (this.stats.rateLimitHits / this.stats.totalRequests) : 0
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      success: 0,
      failures: 0,
      totalRequests: 0,
      rateLimitHits: 0,
      lastError: null
    };
    console.log('📊 Statistics reset');
  }
}
