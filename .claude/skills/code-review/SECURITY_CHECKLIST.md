# Security Checklist para Code Review

## OWASP Top 10 (2021)

### A01: Broken Access Control
- [ ] Verificar permisos antes de acciones sensibles
- [ ] No exponer IDs internos en URLs
- [ ] Validar ownership de recursos
- [ ] Rate limiting en endpoints sensibles

### A02: Cryptographic Failures
- [ ] No almacenar passwords en plain text
- [ ] Usar HTTPS para datos sensibles
- [ ] No hardcodear secrets
- [ ] Usar algoritmos de hash modernos (bcrypt, argon2)

### A03: Injection
- [ ] SQL: Usar parameterized queries, nunca concatenar
- [ ] Command: Escapar argumentos, preferir APIs sobre shell
- [ ] Path: Validar y sanitizar file paths
- [ ] Regex: Evitar ReDoS con input validation

### A04: Insecure Design
- [ ] Validar input en trust boundaries
- [ ] Principio de least privilege
- [ ] Defense in depth

### A05: Security Misconfiguration
- [ ] No exponer stack traces en producción
- [ ] Headers de seguridad (CSP, HSTS, etc.)
- [ ] Deshabilitar features innecesarias

### A06: Vulnerable Components
- [ ] Dependencias actualizadas
- [ ] No usar versiones con CVEs conocidos
- [ ] Auditar nuevas dependencias

### A07: Authentication Failures
- [ ] Session tokens seguros
- [ ] Logout invalida sesión
- [ ] Protección contra brute force

### A08: Data Integrity Failures
- [ ] Validar integridad de datos deserializados
- [ ] Verificar checksums de descargas
- [ ] No confiar en datos de fuentes externas

### A09: Security Logging Failures
- [ ] Loggear eventos de seguridad
- [ ] No loggear datos sensibles
- [ ] Logs protegidos contra tampering

### A10: SSRF
- [ ] Validar URLs de input
- [ ] Whitelist de hosts permitidos
- [ ] No seguir redirects automáticamente

## Patrones Específicos de oss-agent

### Git Operations
```typescript
// MAL: Command injection
exec(`git checkout ${userInput}`);

// BIEN: Usar array de argumentos
execFile('git', ['checkout', userInput]);
```

### File Operations
```typescript
// MAL: Path traversal
const path = join(baseDir, userInput);

// BIEN: Validar que resultado está dentro de baseDir
const safePath = resolve(baseDir, userInput);
if (!safePath.startsWith(resolve(baseDir))) {
  throw new Error('Path traversal attempt');
}
```

### API Keys
```typescript
// MAL: Hardcoded
const API_KEY = 'sk-xxx';

// BIEN: Environment variable
const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error('API_KEY required');
```

### Subprocess Execution
```typescript
// MAL: Shell interpretation
exec(`claude ${prompt}`);

// BIEN: Direct execution, no shell
spawn('claude', ['--print', prompt], { shell: false });
```
