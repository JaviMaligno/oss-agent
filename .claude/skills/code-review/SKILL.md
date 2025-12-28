---
name: code-review
description: Revisa código en PRs o cambios. Usar para code review, analizar diffs, identificar problemas de calidad, seguridad o performance, y sugerir mejoras.
allowed-tools: Read, Grep, Glob, Bash(git:*), Bash(gh:*)
---

# Code Review Skill

## Review Process

1. **Entender contexto** - Leer descripción del PR y issue relacionado
2. **Revisar diff** - Analizar cambios línea por línea
3. **Verificar lógica** - Buscar bugs, edge cases, race conditions
4. **Evaluar seguridad** - Checklist OWASP
5. **Revisar tests** - Cobertura adecuada
6. **Verificar estilo** - Consistencia con codebase

## Checklist de Revisión

### Lógica y Correctitud
- [ ] La lógica es correcta para todos los casos
- [ ] Edge cases manejados (null, empty, boundary values)
- [ ] Error handling apropiado
- [ ] No hay race conditions o deadlocks
- [ ] Los tipos son correctos y precisos

### Seguridad
- [ ] Input validation en boundaries
- [ ] No hay SQL injection (usar parameterized queries)
- [ ] No hay command injection (escapar argumentos de shell)
- [ ] No hay XSS (sanitizar output HTML)
- [ ] Secrets no hardcodeados
- [ ] Permisos verificados antes de acciones sensibles

### Performance
- [ ] No hay N+1 queries
- [ ] Operaciones costosas fuera de loops
- [ ] Uso apropiado de async/await
- [ ] No memory leaks (cleanup de listeners, timers)

### Tests
- [ ] Tests cubren happy path
- [ ] Tests cubren error cases
- [ ] Tests cubren edge cases
- [ ] Mocks apropiados (no over-mocking)

### Estilo y Mantenibilidad
- [ ] Código legible y auto-documentado
- [ ] Nombres descriptivos
- [ ] Funciones pequeñas y focalizadas
- [ ] No hay código duplicado innecesario
- [ ] Comentarios solo donde necesario

## Severity Levels

| Level | Descripción | Acción |
|-------|-------------|--------|
| **Critical** | Bugs, vulnerabilidades, data loss | Bloquear merge |
| **Major** | Logic errors, missing validation | Requiere fix |
| **Minor** | Style, naming, pequeñas mejoras | Sugerencia |
| **Nitpick** | Preferencias personales | Opcional |

## Formato de Feedback

```markdown
**[SEVERITY]** Breve descripción del issue

Ubicación: `file.ts:123`

Problema: Explicación del issue y por qué es importante.

Sugerencia:
\`\`\`typescript
// Código sugerido
\`\`\`
```

Ver [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) para detalles de seguridad.
