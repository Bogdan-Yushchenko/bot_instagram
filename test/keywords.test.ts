import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostKeywordResponder } from '../src/bot/PostKeywordResponder';

const responder = new PostKeywordResponder();

const cases: Array<[input: string, expectedKeyword: string]> = [
  ['гайд', 'гайд'],
  ['ГАЙД', 'гайд'],
  ['Гайд', 'гайд'],
  ['запис', 'запис'],
  ['Як записаться?', 'запис'],
  ['ЗАПИС!', 'запис'],
  ['Записатись', 'запис'],
  ['ціна', 'ціна'],
  ['Скільки коштує?', '__default__'],
  ['психолог', 'психолог'],
  ['ПСИХОЛОГ', 'психолог'],
  ['тест', 'тест'],
  ['привіт', '__default__'],
  ['Хуй', '__default__'],
  ['Вот бы по этому котёнку', '__default__'],
  ['Reply', '__default__'],
  ['random spam text here', '__default__'],
  ['veselovegorka', '__default__'],
  ['bohdanyushchenko3d', '__default__'],
  ['See translation', '__default__'],
  ['© 2026 Instagram', '__default__'],
];

for (const [input, expected] of cases) {
  test(`getMatch("${input}") → "${expected}"`, () => {
    assert.equal(responder.getMatch(input).keyword, expected);
  });
}
