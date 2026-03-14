# Structured I/O

Every step has a typed contract: `execute(input: TInput, ctx) => Promise<StepResult<TOutput>>`. No `any`, no `unknown` leaking to consumers, no untyped bags of data.

## The Step Contract

```typescript
interface Step<TInput, TOutput> {
  readonly name: string
  readonly description: string
  readonly kind: StepKind        // 'llm' | 'script' | 'parallel'
  execute(input: TInput, ctx: PipelineContext): Promise<StepResult<TOutput>>
}
```

The type parameters flow through the pipeline builder:

```typescript
new PipelineBuilder<string>()     // pipeline input: string
  .step(collectStep)              // string → FileSet
  .step(classifyStep)             // FileSet → ClassifyOutput  ← type error if wrong
  .build('my-pipeline')           // Pipeline<string, ClassifyOutput>
```

A type mismatch at `.step()` is a compile error. You can't accidentally wire a step that expects `FileSet` after one that produces `string`.

## StepResult — Discriminated Union

```typescript
type StepResult<T> = StepOk<T> | StepError

interface StepOk<T> {
  status: 'ok'
  output: T           // ← typed output
  elapsedMs: number
  meta: StepMeta      // { model, attempts, promptLength, rawLength }
}

interface StepError {
  status: 'error'
  error: string       // ← always a message, never a raw Error object
  elapsedMs: number
  retries: number
}
```

Discriminated on `status`. After checking `result.status === 'ok'`, TypeScript narrows to `StepOk<T>` and gives you `result.output`.

## ParseResult — LLM Output Validation

LLM steps use `ParseResult<T>` to separate "did the LLM respond" from "did the response match the schema":

```typescript
interface ParseResult<T> {
  result: T
  errors: string[]    // empty = success, non-empty = parse failure
}
```

This is critical because LLM output is the system boundary. The `parser` function is where unstructured text becomes typed data. If `errors` is non-empty and `retryOnParseError` is true, the step retries automatically.

## Primitives First

Prefer simple types over wrapper objects. A step that needs a file path takes `string`, not `{ path: string }`. A step that collects files returns `FileSet` (a plain record), not a class instance.

The exception: when multiple values need to travel together, use a flat interface. No nesting unless the domain requires it.

```typescript
// Good — flat, all fields meaningful
interface FileSet {
  targetDir: string
  files: string[]
}

// Bad — unnecessary wrapper
interface FileSetWrapper {
  data: {
    config: {
      targetDir: string
    }
    results: {
      files: string[]
    }
  }
}
```
