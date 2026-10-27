// Where a value sits along a strip, as a percentage of its width.
export function axisPercent(value: number, axis: { min: number; max: number }): number {
  return ((value - axis.min) / (axis.max - axis.min)) * 100;
}
