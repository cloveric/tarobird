#!/usr/bin/env node
// Read-only CLI catalog fixture; never launches an engine or reads user state.
if (process.argv[2] !== "models") process.exit(2);
process.stdout.write([
  "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
  "gemini-4-argon-high\tGemini 4 Argon (High)",
  "gemini-4-argon-low\tGemini 4 Argon (Low)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n") + "\n");
