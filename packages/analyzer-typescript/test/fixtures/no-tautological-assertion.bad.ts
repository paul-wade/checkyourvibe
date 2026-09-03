declare const expect: (actual: unknown) => {
  toBe(expected: unknown): void;
  to: { eql(expected: unknown): void };
};
declare const assert: { equal(actual: unknown, expected: unknown): void };

declare function it(name: string, fn: () => void): void;

it('cannot fail', () => {
  expect(true).toBe(true);
  expect(1).toBe(1);
  expect('x').toBe('x');
  const retries = 3;
  expect(retries).toBe(retries);
  assert.equal('x', 'x');
  expect(0).to.eql(0);
});
