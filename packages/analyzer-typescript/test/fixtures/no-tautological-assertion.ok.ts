interface Should {
  be: { eql(expected: unknown): void };
}

interface Matchers {
  toBe(expected: unknown): void;
  toMatchSnapshot(name?: string): void;
  to: { be: { equal(expected: unknown, message?: string): void } };
}

declare const expect: (actual: unknown) => Matchers;

declare function compute(): number;
declare function fn(): object;

const value = compute();
const result = fn();

// An assertion comparing a variable to a literal is legitimate.
expect(value).toBe(3);

// A snapshot is legitimate, with or without a snapshot name.
expect(result).toMatchSnapshot();
expect(result).toMatchSnapshot('on disk');

// Two separate calls may legitimately be compared for referential identity.
expect(fn()).toBe(fn());

interface QueryBuilder {
  take(count: number): QueryBuilder;
  skip(count: number): QueryBuilder;
  from(target: string, alias: string): QueryBuilder;
  leftJoinAndSelect(property: string, alias: string): QueryBuilder;
}

interface RelationBuilder {
  of(id: number): { add(id: number): void };
}

interface Cache {
  storeInCache(options: string, savedOptions: string): void;
}

declare const queryBuilder: QueryBuilder;
declare const relation: RelationBuilder;
declare const cache: Cache;
declare const VersionUtils: { isGreaterOrEqual(a: string, b: string): boolean };
declare class Post {}
declare const dataSource: {
  getRepository(target: typeof Post): { target: { should: Should } };
};
declare function snakeCase(input: string): string;
declare const expected: string;
declare const options: string;

// Every line below was reported by an earlier version of this rule on a typeorm
// clone. Each is an ordinary fluent API, a deliberate test input, or an
// assertion whose repeated operand is a failure message — none compares a value
// to itself.
queryBuilder.take(3).skip(3);
queryBuilder.from('qaz', 'qaz');
queryBuilder.leftJoinAndSelect('category', 'category');
relation.of(2).add(2);
cache.storeInCache(options, options);
VersionUtils.isGreaterOrEqual('1', '1');
expect(snakeCase(expected)).to.be.equal(expected, expected);

// The value under test is `.target`, read from the repository the call returned.
// Repeating `Post` on both sides of the chain is what makes the assertion worth
// writing, not what makes it empty.
dataSource.getRepository(Post).target.should.be.eql(Post);
