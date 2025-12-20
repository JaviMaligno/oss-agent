# Plan: CI Check Handler - Wait & Auto-Fix

## Problema Actual

Cuando el agente hace push, hay dos escenarios problemáticos:

1. **Hooks locales fallan** → El sistema hace `--no-verify` (bypass)
2. **CI checks en GitHub fallan** → El sistema no hace nada, el PR queda con checks rojos

El usuario tiene que manualmente ejecutar `iterate` para arreglar los problemas.

## Objetivo

Implementar un flujo automatizado que:
1. Después de crear el PR, espere a que los checks de CI completen
2. Si fallan, analice los logs y arregle automáticamente
3. Re-pushee y vuelva a esperar (hasta N iteraciones)
4. Todo dentro del mismo proceso, sin necesidad de webhooks ni servidor

## Arquitectura Propuesta

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         IssueProcessor.processIssue()                    │
│                                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────────┐  │
│  │ Implement │───▶│  Commit  │───▶│   Push   │───▶│   Create PR      │  │
│  └──────────┘    └──────────┘    └──────────┘    └────────┬─────────┘  │
│                                                           │             │
│                                                           ▼             │
│                                              ┌────────────────────────┐ │
│                                              │   CICheckHandler       │ │
│                                              │                        │ │
│                                              │  1. Poll for checks    │ │
│                                              │  2. Wait completion    │ │
│                                              │  3. If fail → fix      │ │
│                                              │  4. Re-push → repeat   │ │
│                                              └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Componentes

### 1. CICheckPoller (`src/core/github/ci-poller.ts`)

Servicio de polling para esperar a que los checks completen.

```typescript
interface CIPollerOptions {
  timeoutMs: number;        // Máximo tiempo de espera (default: 30 min)
  pollIntervalMs: number;   // Intervalo entre polls (default: 30s)
  requiredChecks?: string[]; // Checks específicos a esperar (opcional)
}

interface CIPollerResult {
  status: "success" | "failure" | "timeout" | "cancelled";
  checks: PRCheck[];
  failedChecks: PRCheck[];
  duration: number;
}

class CICheckPoller {
  async waitForChecks(
    owner: string,
    repo: string,
    prNumber: number,
    options: CIPollerOptions
  ): Promise<CIPollerResult>;
}
```

**Lógica de polling:**
```typescript
async waitForChecks(...): Promise<CIPollerResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < options.timeoutMs) {
    const checks = await this.prService.getChecks(owner, repo, prNumber);

    // Filtrar checks requeridos si se especificaron
    const relevantChecks = options.requiredChecks
      ? checks.filter(c => options.requiredChecks.includes(c.name))
      : checks;

    // Verificar si todos completaron
    const allCompleted = relevantChecks.every(
      c => c.status !== "pending" && c.status !== "queued"
    );

    if (allCompleted) {
      const failedChecks = relevantChecks.filter(c => c.status === "failure");
      return {
        status: failedChecks.length > 0 ? "failure" : "success",
        checks: relevantChecks,
        failedChecks,
        duration: Date.now() - startTime,
      };
    }

    // Log progreso
    const pending = relevantChecks.filter(c => c.status === "pending").length;
    logger.info(`Waiting for CI: ${pending}/${relevantChecks.length} checks pending...`);

    // Esperar antes del siguiente poll
    await sleep(options.pollIntervalMs);
  }

  return { status: "timeout", ... };
}
```

### 2. CICheckHandler (`src/core/engine/ci-handler.ts`)

Orquestador que integra polling + auto-fix.

```typescript
interface CIHandlerOptions {
  maxIterations: number;     // Máximo intentos de fix (default: 3)
  waitForChecks: boolean;    // Habilitar espera (default: true)
  autoFix: boolean;          // Auto-arreglar fallos (default: true)
  timeoutMs: number;         // Timeout por iteración
  pollIntervalMs: number;    // Intervalo de polling
}

interface CIHandlerResult {
  finalStatus: "success" | "failure" | "timeout" | "max_iterations";
  iterations: CIIteration[];
  totalDuration: number;
}

interface CIIteration {
  attempt: number;
  checkResult: CIPollerResult;
  fixApplied: boolean;
  fixCommit?: string;
}

class CICheckHandler {
  constructor(
    private prService: PRService,
    private reviewService: ReviewService,
    private gitOps: GitOperations,
    private aiProvider: AIProvider
  ) {}

  async handleChecks(
    owner: string,
    repo: string,
    prNumber: number,
    worktreePath: string,
    branchName: string,
    options: CIHandlerOptions
  ): Promise<CIHandlerResult>;
}
```

**Lógica principal:**
```typescript
async handleChecks(...): Promise<CIHandlerResult> {
  const iterations: CIIteration[] = [];

  for (let attempt = 1; attempt <= options.maxIterations; attempt++) {
    logger.info(`CI Check iteration ${attempt}/${options.maxIterations}`);

    // 1. Esperar a que los checks completen
    const checkResult = await this.poller.waitForChecks(
      owner, repo, prNumber,
      { timeoutMs: options.timeoutMs, pollIntervalMs: options.pollIntervalMs }
    );

    // 2. Si todos pasaron, éxito
    if (checkResult.status === "success") {
      logger.info("All CI checks passed!");
      return { finalStatus: "success", iterations, ... };
    }

    // 3. Si timeout, salir
    if (checkResult.status === "timeout") {
      logger.warn("CI checks timed out");
      return { finalStatus: "timeout", iterations, ... };
    }

    // 4. Si falló y auto-fix habilitado, intentar arreglar
    if (checkResult.status === "failure" && options.autoFix) {
      logger.info(`${checkResult.failedChecks.length} checks failed, attempting auto-fix...`);

      // Obtener logs de los checks fallidos
      const failureLogs = await this.getCheckLogs(owner, repo, checkResult.failedChecks);

      // Invocar AI para arreglar
      const fixResult = await this.attemptFix(
        worktreePath, branchName, failureLogs
      );

      if (fixResult.fixed) {
        // Commit y push
        await this.gitOps.commitAll(worktreePath, `fix: Address CI failures\n\n${fixResult.summary}`);
        await this.gitOps.push(worktreePath, branchName, { skipVerification: true });

        iterations.push({
          attempt,
          checkResult,
          fixApplied: true,
          fixCommit: fixResult.commitHash,
        });

        // Continuar al siguiente intento (esperar nuevos checks)
        continue;
      }
    }

    // 5. Si no se pudo arreglar, salir
    iterations.push({ attempt, checkResult, fixApplied: false });
    return { finalStatus: "failure", iterations, ... };
  }

  return { finalStatus: "max_iterations", iterations, ... };
}
```

### 3. Obtención de Logs de CI

Para que el AI pueda arreglar los fallos, necesita los logs.

```typescript
async getCheckLogs(
  owner: string,
  repo: string,
  failedChecks: PRCheck[]
): Promise<CheckFailureLog[]> {
  const logs: CheckFailureLog[] = [];

  for (const check of failedChecks) {
    // Usar GitHub API para obtener logs del workflow run
    // GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs
    // o GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs

    const logContent = await this.fetchCheckLog(owner, repo, check);

    logs.push({
      checkName: check.name,
      status: check.status,
      conclusion: check.conclusion,
      summary: check.outputSummary,
      log: logContent,
      // Extraer errores específicos del log
      errors: this.parseErrorsFromLog(logContent),
    });
  }

  return logs;
}

parseErrorsFromLog(log: string): string[] {
  // Patrones comunes de errores en CI
  const patterns = [
    /error\[.*?\]:.*$/gim,           // Rust errors
    /Error:.*$/gim,                   // Generic errors
    /FAIL.*$/gim,                     // Test failures
    /✗.*$/gim,                        // Test failures (vitest/jest)
    /AssertionError:.*$/gim,          // Assertion failures
    /TypeError:.*$/gim,               // Type errors
    /SyntaxError:.*$/gim,             // Syntax errors
    /^\s+at\s+.*$/gim,                // Stack traces
  ];

  const errors: string[] = [];
  for (const pattern of patterns) {
    const matches = log.match(pattern);
    if (matches) errors.push(...matches);
  }

  return errors;
}
```

### 4. Integración en IssueProcessor

Modificar `processIssue()` para usar el handler después de crear el PR.

```typescript
// En src/core/engine/issue-processor.ts

async processIssue(issueUrl: string, options: ProcessOptions): Promise<ProcessResult> {
  // ... código existente hasta crear PR ...

  if (!options.skipPR && prUrl) {
    const { owner, repo, prNumber } = this.parsePRUrl(prUrl);

    // NUEVO: Esperar y manejar CI checks
    if (options.waitForChecks !== false) {
      const ciHandler = new CICheckHandler(
        this.prService,
        this.reviewService,
        this.gitOps,
        this.aiProvider
      );

      const ciResult = await ciHandler.handleChecks(
        owner, repo, prNumber,
        worktreePath, branchName,
        {
          maxIterations: options.maxCIFixIterations ?? 3,
          waitForChecks: true,
          autoFix: options.autoFixCI ?? true,
          timeoutMs: options.ciTimeoutMs ?? 30 * 60 * 1000,
          pollIntervalMs: options.ciPollIntervalMs ?? 30 * 1000,
        }
      );

      if (ciResult.finalStatus !== "success") {
        logger.warn(`CI checks did not pass: ${ciResult.finalStatus}`);
        // Actualizar estado de la sesión
        await this.stateManager.updateSession(sessionId, {
          ciStatus: ciResult.finalStatus,
          ciIterations: ciResult.iterations.length,
        });
      }
    }
  }

  // ... resto del código ...
}
```

### 5. Configuración

Añadir opciones al schema de configuración.

```typescript
// En src/types/config.ts

interface PRConfig {
  // ... opciones existentes ...

  // CI Check handling
  waitForChecks: boolean;           // default: true
  autoFixFailedChecks: boolean;     // default: true
  ciCheckTimeoutMs: number;         // default: 30 * 60 * 1000 (30 min)
  ciPollIntervalMs: number;         // default: 30 * 1000 (30 sec)
  maxCIFixIterations: number;       // default: 3
  requiredChecks?: string[];        // Checks específicos a esperar
}
```

### 6. CLI Flags

Añadir flags al comando `work`.

```typescript
// En src/cli/commands/work.ts

.option("--wait-for-checks", "Wait for CI checks to complete after PR creation", true)
.option("--no-wait-for-checks", "Skip waiting for CI checks")
.option("--auto-fix-ci", "Automatically fix failed CI checks", true)
.option("--no-auto-fix-ci", "Don't auto-fix failed CI checks")
.option("--ci-timeout <minutes>", "Timeout for CI checks in minutes", "30")
.option("--max-ci-iterations <n>", "Max iterations for CI fix attempts", "3")
```

## Detección de Checks Disponibles

Para saber si hay checks a los que esperar:

```typescript
async hasConfiguredChecks(owner: string, repo: string): Promise<boolean> {
  // Opción 1: Verificar si existe .github/workflows/
  const hasWorkflows = await this.checkFileExists(
    owner, repo, ".github/workflows"
  );

  // Opción 2: Verificar branch protection rules
  const protection = await this.getBranchProtection(owner, repo, "main");
  const hasRequiredChecks = protection?.requiredStatusChecks?.contexts?.length > 0;

  // Opción 3: Verificar historial de checks en PRs recientes
  const recentPRs = await this.getRecentPRs(owner, repo, 5);
  const hasCheckHistory = recentPRs.some(pr => pr.statusCheckRollup?.length > 0);

  return hasWorkflows || hasRequiredChecks || hasCheckHistory;
}
```

## Flujo Completo

```
1. Agente implementa solución
2. Commit y push
3. Crear PR
4. Detectar si hay checks configurados
5. Si hay checks:
   a. Esperar a que completen (polling cada 30s, timeout 30min)
   b. Si todos pasan → Éxito, terminar
   c. Si alguno falla:
      i. Obtener logs de los checks fallidos
      ii. Invocar AI con contexto de errores
      iii. AI hace cambios para arreglar
      iv. Commit y push
      v. Volver al paso 5a (máximo 3 iteraciones)
   d. Si timeout o max iteraciones → Reportar y terminar
6. Si no hay checks → Terminar inmediatamente
```

## Consideraciones

### Timeouts
- Algunos CI pueden tardar mucho (builds de Docker, tests E2E)
- Default 30 min es razonable, pero configurable
- Mostrar progreso al usuario durante la espera

### Rate Limiting
- GitHub API tiene límites (5000 req/hora autenticado)
- Polling cada 30s = 120 requests en 1 hora por PR
- Usar exponential backoff si se acerca al límite

### Logs de CI
- Algunos logs pueden ser muy grandes
- Truncar a las últimas N líneas o buscar solo errores
- Usar el `outputSummary` del check si está disponible

### Idempotencia
- Si el proceso se interrumpe, el usuario puede re-ejecutar
- La sesión guarda el estado de CI para continuar

## Archivos a Crear/Modificar

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `src/core/github/ci-poller.ts` | Crear | Servicio de polling |
| `src/core/engine/ci-handler.ts` | Crear | Orquestador de CI handling |
| `src/core/engine/issue-processor.ts` | Modificar | Integrar CI handler |
| `src/types/config.ts` | Modificar | Añadir opciones de CI |
| `src/cli/commands/work.ts` | Modificar | Añadir flags de CLI |
| `src/types/pr.ts` | Modificar | Tipos para CI handling |

## Estimación

- **CICheckPoller**: ~150 líneas
- **CICheckHandler**: ~300 líneas
- **Integración + Config**: ~100 líneas
- **Tests**: ~200 líneas

**Total**: ~750 líneas de código nuevo
