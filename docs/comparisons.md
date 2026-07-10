# Comparisons

opencode-llm-proxy is deliberately narrow: it reuses the providers you already configured in OpenCode and exposes them through common client API formats. Here's how it relates to adjacent tools.

## vs LiteLLM

LiteLLM is a general-purpose provider router/proxy. opencode-llm-proxy is focused on reusing the providers already configured in OpenCode and making them available through common client API formats.

- Use **LiteLLM** if you want a standalone production gateway with its own provider configuration, routing, budgets, and key management.
- Use **opencode-llm-proxy** if your model configuration already lives in OpenCode and you want local tools to reuse it without re-entering keys.

## vs OpenRouter

OpenRouter is a hosted router and provider marketplace with its own billing and API keys. opencode-llm-proxy is local and backed by your OpenCode setup.

- Use **OpenRouter** for a hosted, internet-facing endpoint and access to a broad model catalog through one account.
- Use **opencode-llm-proxy** to keep everything local and driven by the providers OpenCode already has authenticated.

## vs direct provider API keys

Configuring a provider's API key directly in each tool is simplest when you only have one tool.

- Use **direct keys** for a single tool with a single provider.
- Use **opencode-llm-proxy** when multiple tools should share the same OpenCode model setup, so you configure providers once and swap models in one place.

## vs Ollama's OpenAI-compatible endpoint

Ollama exposes an OpenAI-compatible API for its local models only.

- Use **Ollama's endpoint** if you only ever use local Ollama models.
- Use **opencode-llm-proxy** to expose Ollama *and* every other provider OpenCode manages (GitHub Copilot, Anthropic, Bedrock, OpenRouter, ...) behind one endpoint and multiple API formats.

## Summary

opencode-llm-proxy is not trying to be a production gateway or a hosted marketplace. Its value is that your model setup already lives in OpenCode, and this makes that setup usable from OpenAI-, Anthropic-, Gemini-, and Responses-API-compatible tools locally, with streaming and real tool/function calling.
