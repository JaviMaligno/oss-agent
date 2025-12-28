# Patrones de Desarrollo en oss-agent

## AI Provider Pattern

```typescript
// Implementar AIProvider interface
export interface AIProvider {
  query(prompt: string, options: QueryOptions): Promise<QueryResult>;
  isAvailable(): Promise<boolean>;
  getCapabilities(): ProviderCapabilities;
}

// Ejemplo de uso
const provider = await createProvider(config);
const result = await provider.query(prompt, {
  cwd: workDir,
  maxTurns: 50,
  maxBudgetUsd: 5,
});
```

## Command Pattern (CLI)

```typescript
// src/cli/commands/example.ts
import { Command } from 'commander';

export function createExampleCommand(): Command {
  return new Command('example')
    .description('Example command description')
    .argument('<required>', 'Required argument')
    .option('-o, --option <value>', 'Optional flag')
    .action(async (arg, options) => {
      // Implementation
    });
}
```

## State Management

```typescript
// Usar SessionRepository para persistencia
const sessionRepo = new SessionRepository(db);
const session = await sessionRepo.create({
  issueUrl,
  repoPath,
  branchName,
  state: 'working',
});

// Actualizar estado
await sessionRepo.updateState(session.id, 'completed');
```

## Error Handling

```typescript
// Usar clases de error específicas
import { OssAgentError, GitError, AIProviderError } from '../infra/errors.js';

// Lanzar errores tipados
throw new GitError('Failed to create worktree', { cause: originalError });

// Usar retry con backoff para operaciones flaky
import { withRetry } from '../infra/retry.js';

const result = await withRetry(
  () => externalApiCall(),
  { maxAttempts: 3, baseDelay: 1000 }
);
```

## Configuration

```typescript
// Definir schema con Zod
const MyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timeout: z.number().default(30000),
});

// Integrar en ConfigSchema principal
export const ConfigSchema = z.object({
  // ...existing
  myFeature: MyConfigSchema.default({}),
});
```

## Testing

```typescript
// tests/unit/example.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('ExampleService', () => {
  it('should handle success case', async () => {
    const mockDep = vi.fn().mockResolvedValue('result');
    const service = new ExampleService(mockDep);

    const result = await service.doSomething();

    expect(result).toBe('expected');
    expect(mockDep).toHaveBeenCalledWith('args');
  });
});
```
