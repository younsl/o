import { toValidProjectId } from './CatalogHealthService';

// The id is spliced into GitLab API URLs, so anything that is not a positive
// integer must throw before a request is built from it.
describe('toValidProjectId', () => {
  it.each([
    [42, 42],
    ['42', 42],
    [1, 1],
  ])('coerces %p to %p', (input, expected) => {
    expect(toValidProjectId(input)).toBe(expected);
  });

  it.each([
    '1/repository/files/x',
    '../projects',
    0,
    -5,
    1.5,
    NaN,
    Infinity,
    null,
    undefined,
    '',
    {},
    ['1'],
  ])('rejects %p', input => {
    expect(() => toValidProjectId(input)).toThrow('Invalid GitLab project id');
  });
});
