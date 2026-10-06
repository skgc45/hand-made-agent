export const SECRET_ENV_KEYS = ["GEMINI_API_KEY", "LLM_API_KEY"] as const;

export function safeEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of SECRET_ENV_KEYS) delete env[key];
  return env;
}
