# Convenciones de oss-agent

## Branch Naming

```
oss-agent/<issue-id>-<short-description>
```

Ejemplos:
- `oss-agent/123-add-resume-flag`
- `oss-agent/456-fix-timeout-handling`
- `oss-agent/789-refactor-ai-provider`

## Commit Guidelines

### DO
- Un commit por cambio lógico
- Mensaje en presente ("add" no "added")
- Primera línea < 72 caracteres
- Body explicando el "por qué" si no es obvio
- Referenciar issues con `Closes #N` o `Fixes #N`

### DON'T
- Commits con "WIP", "fix", "more changes"
- Commits que rompen el build
- Commits con archivos no relacionados
- Commits con secrets o datos sensibles

## PR Guidelines

### Tamaño
- **Ideal**: < 400 líneas cambiadas
- **Máximo recomendado**: 800 líneas
- PRs grandes → dividir en PRs incrementales

### Self-Review Checklist
Antes de solicitar review:
- [ ] Código compila sin errores
- [ ] Tests pasan localmente
- [ ] Lint pasa sin warnings
- [ ] Descripción de PR completa
- [ ] Screenshots si hay cambios visuales

### Review Process
1. Crear PR como draft si aún en progreso
2. Marcar ready for review cuando listo
3. Responder a todos los comentarios
4. Re-request review después de cambios

## Code Style

### Imports
```typescript
// 1. Node built-ins
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

// 2. External dependencies
import { z } from "zod";
import { Command } from "commander";

// 3. Internal modules (con .js extension)
import { logger } from "../infra/logger.js";
import { Config } from "../types/config.js";
```

### Exports
```typescript
// Preferir named exports
export function createWorkCommand(): Command { ... }
export class WorkEngine { ... }

// Barrel exports en index.ts
export { createWorkCommand } from "./work.js";
export { createRunCommand } from "./run.js";
```

### Error Messages
```typescript
// Incluir contexto útil
throw new Error(`Failed to create worktree at ${path}: ${error.message}`);

// Para errores de usuario, ser prescriptivo
throw new Error(
  `Invalid issue URL: ${url}. ` +
  `Expected format: https://github.com/owner/repo/issues/123`
);
```

## GitHub CLI Commands

### Crear PR
```bash
gh pr create \
  --title "feat(scope): description" \
  --body "$(cat <<EOF
## Summary
- Change 1
- Change 2

## Test Plan
- [ ] Tests pass
EOF
)"
```

### Ver PR
```bash
gh pr view --web  # Abrir en browser
gh pr diff        # Ver diff
gh pr checks      # Ver CI status
```

### Merge PR
```bash
gh pr merge --squash --delete-branch
```
