/**
 * Ollama client for local LLM inference
 */
class OllamaClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:11434';
    this.model = options.model || 'gemma2';
    this.temperature = options.temperature || 0.3;
  }

  /**
   * Generate completion using Ollama
   * @param {string} prompt - The prompt to send to the model
   * @param {Object} options - Additional options
   * @returns {Promise<string>} - Generated response
   */
  // In your OllamaClient class, add retry logic:
async invoke(prompt, options = {}) {
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      console.log(`🤖 Calling Ollama (${this.model})... (attempt ${attempt + 1}/${maxRetries})`);
      
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt: prompt,
          stream: false,
          options: {
            temperature: options.temperature || this.temperature,
            top_p: options.top_p || 0.9,
            top_k: options.top_k || 40,
          }
        }),
        timeout: 300000 // 5 minutes timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.response) {
        throw new Error('Empty response from Ollama');
      }

      return {
        content: data.response
      };
      
    } catch (error) {
      attempt++;
      
      if (attempt >= maxRetries) {
        console.error(`❌ Ollama request failed after ${maxRetries} attempts:`, error.message);
        throw new Error(`Ollama analysis failed: ${error.message}`);
      }
      
      console.warn(`⚠️ Ollama request attempt ${attempt} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
    }
  }
}


  /**
   * Check if Ollama is running and model is available
   */
  async checkHealth() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error('Ollama server not responding');
      }
      
      const data = await response.json();
      const availableModels = data.models?.map(m => m.name) || [];
      
      if (!availableModels.some(name => name.startsWith(this.model))) {
        throw new Error(`Model ${this.model} not found. Available: ${availableModels.join(', ')}`);
      }
      
      return {
        status: 'healthy',
        model: this.model,
        availableModels: availableModels
      };
      
    } catch (error) {
      throw new Error(`Ollama health check failed: ${error.message}`);
    }
  }
}

export { OllamaClient };
