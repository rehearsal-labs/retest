function logged<Value>(value: Value, context: ClassMethodDecoratorContext): Value {
  return value
}

export class Tasks {
  @logged
  count(): number {
    return 1
  }
}
