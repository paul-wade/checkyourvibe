const fixed = 'hello' as const;
const checked = 'hello' satisfies string;
function use(value: string | number) {
  if (typeof value === 'string') {
    const s: string = value;
  }
}
