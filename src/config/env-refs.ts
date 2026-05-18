// --- Env reference resolution ---

const ENV_REF_REGEX = /\$\{([^}]+)}/g;

/**
 * Deep-walk a parsed YAML object and replace `${VAR}` references with
 * `process.env[VAR]`. Throws if a referenced variable is not defined.
 */
export function resolveEnvReferences<T>(obj: T): T {
  if (typeof obj === 'string') {
    return obj.replace(ENV_REF_REGEX, (_match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(
          `Environment variable '${varName}' referenced in config.yaml is not defined`,
        );
      }
      return value;
    }) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvReferences(item)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvReferences(value);
    }
    return result as T;
  }
  return obj;
}
