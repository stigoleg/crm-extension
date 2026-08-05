/* Lightweight test runner (no dependencies). Run with `node tests/markdown.test.js`.
 * Each test asserts a substring (or absence thereof) in the rendered HTML so we
 * don't lock ourselves to exact whitespace. */

'use strict';

// Load the IIFE module by evaluating it against a fake global.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'markdown.js'), 'utf8');
const scope = { self: {} };
// eslint-disable-next-line no-new-func
new Function('self', src)(scope.self);
const { render } = scope.self.SNCRM.markdown;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function assertContains(html, needle, msg) {
  if (!html.includes(needle)) {
    throw new Error(`${msg || 'expected substring not found'}\n  needle: ${JSON.stringify(needle)}\n  html:   ${html}`);
  }
}

function assertNotContains(html, needle, msg) {
  if (html.includes(needle)) {
    throw new Error(`${msg || 'unexpected substring present'}\n  needle: ${JSON.stringify(needle)}\n  html:   ${html}`);
  }
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

console.log('markdown renderer');

test('ordered list with blank lines between markers stays in one <ol>', () => {
  // SN users commonly paste numbered lists with blank lines (sometimes
  // multiple) between items. As long as the next non-blank line is another
  // numbered marker, the list holds together.
  const input = [
    '1. First item',
    '',
    '',
    '1. Second item',
    '',
    '1. Third item'
  ].join('\n');
  const html = render(input);
  if (countOccurrences(html, '<ol>') !== 1) throw new Error(`expected exactly 1 <ol>, got ${countOccurrences(html, '<ol>')}\n${html}`);
  if (countOccurrences(html, '<li>') !== 3) throw new Error(`expected exactly 3 <li>, got ${countOccurrences(html, '<li>')}\n${html}`);
  assertContains(html, 'First item');
  assertContains(html, 'Second item');
  assertContains(html, 'Third item');
});

test('ordered list without blank lines still works (tight list)', () => {
  const input = '1. Alpha\n2. Beta\n3. Gamma';
  const html = render(input);
  if (countOccurrences(html, '<ol>') !== 1) throw new Error('expected 1 ol');
  if (countOccurrences(html, '<li>') !== 3) throw new Error('expected 3 li');
});

test('ordered list folds tight continuation lines into the current item', () => {
  const input = '1. Title\ncontinuation line\n2. Next';
  const html = render(input);
  if (countOccurrences(html, '<ol>') !== 1) throw new Error('expected 1 ol');
  if (countOccurrences(html, '<li>') !== 2) throw new Error('expected 2 li');
  assertContains(html, 'continuation line');
});

test('blank line + non-marker prose closes an ordered list', () => {
  // Prose between numbered items is treated as a sibling paragraph (CommonMark
  // requires indentation for lazy continuation after a blank line).
  const input = '1. Title\n\nUnrelated paragraph\n\n2. Next';
  const html = render(input);
  if (countOccurrences(html, '<ol>') !== 2) throw new Error(`expected 2 ol, got ${countOccurrences(html, '<ol>')}\n${html}`);
  assertContains(html, 'Unrelated paragraph');
});

test('ordered list is terminated by heading', () => {
  const input = '1. One\n\n# Heading\n\n2. Two';
  const html = render(input);
  if (countOccurrences(html, '<ol>') !== 2) throw new Error(`expected 2 separate <ol>s, got ${countOccurrences(html, '<ol>')}`);
  assertContains(html, '<h1>Heading</h1>');
});

test('ordered list is terminated by horizontal rule', () => {
  const input = '1. One\n\n---\n\n2. Two';
  const html = render(input);
  if (countOccurrences(html, '<ol>') !== 2) throw new Error('expected 2 ol');
  assertContains(html, '<hr>');
});

test('unordered list stays together across blank lines between bullets', () => {
  const input = '- First\n\n- Second\n\n- Third';
  const html = render(input);
  if (countOccurrences(html, '<ul>') !== 1) throw new Error('expected single ul');
  if (countOccurrences(html, '<li>') !== 3) throw new Error('expected 3 li');
});

test('unordered list closes on blank line followed by prose', () => {
  // User's case: a bullet followed by unrelated text must not absorb the text.
  const input = '* FooBar\n\nLorem ipsum';
  const html = render(input);
  if (countOccurrences(html, '<ul>') !== 1) throw new Error('expected 1 ul');
  if (countOccurrences(html, '<li>') !== 1) throw new Error('expected 1 li');
  assertContains(html, '</ul>');
  const ulClose = html.indexOf('</ul>');
  const loremIdx = html.indexOf('Lorem ipsum');
  if (!(loremIdx > ulClose)) throw new Error(`"Lorem" should appear after </ul>\n${html}`);
});

test('ordered list switching to unordered starts a new list', () => {
  const input = '1. One\n- Bullet';
  const html = render(input);
  assertContains(html, '<ol>');
  assertContains(html, '<ul>');
});

test('inline formatting still applies inside list items', () => {
  const input = '1. **Bold** item\n\n2. _italic_ item';
  const html = render(input);
  assertContains(html, '<strong>Bold</strong>');
  assertContains(html, '<em>italic</em>');
});

test('Norwegian numbered list with blank lines between markers stays together', () => {
  // Titles only, blanks in between — the marker lookahead keeps them in one <ol>.
  const input = [
    '1. Helhetlig løsningsdesign',
    '',
    '2. Funksjonell arkitektur',
    '',
    '3. Teknisk arkitektur'
  ].join('\n');
  const html = render(input);
  if (countOccurrences(html, '<ol>') !== 1) throw new Error(`expected 1 ol, got ${countOccurrences(html, '<ol>')}\n${html}`);
  if (countOccurrences(html, '<li>') !== 3) throw new Error(`expected 3 li, got ${countOccurrences(html, '<li>')}`);
});

test('UL followed by unrelated paragraph closes the list', () => {
  const input = [
    'Nav har behov for konsulentbistand innen følgende kompetanseområde:',
    '',
    '- Strategi- og organisasjonsutvikling',
    '',
    'Rolle: Dataanalytiker',
    '',
    'Beskrivelse av oppdraget'
  ].join('\n');
  const html = render(input);
  if (countOccurrences(html, '<ul>') !== 1) throw new Error(`expected 1 ul, got ${countOccurrences(html, '<ul>')}\n${html}`);
  if (countOccurrences(html, '<li>') !== 1) throw new Error(`expected 1 li, got ${countOccurrences(html, '<li>')}\n${html}`);
  assertContains(html, '</ul>');
  // "Rolle:" must NOT be inside the <li>.
  const liClose = html.indexOf('</ul>');
  const rolleIdx = html.indexOf('Rolle:');
  if (!(rolleIdx > liClose)) throw new Error(`"Rolle:" should appear after </ul>\n${html}`);
});

test('HTML in input is escaped', () => {
  const html = render('1. <script>alert(1)</script>');
  assertNotContains(html, '<script>', 'script tag must be escaped');
  assertContains(html, '&lt;script&gt;');
});

test('root-relative ServiceNow links stay clickable', () => {
  const html = render('[Open record](/x/ssasi/crm/record/x_ssasi_crm_opportunity/abc123)');
  assertContains(
    html,
    '<a href="/x/ssasi/crm/record/x_ssasi_crm_opportunity/abc123" target="_blank" rel="noopener noreferrer">Open record</a>',
    'expected a same-origin root-relative link to be preserved'
  );
});

test('dangerous javascript links are blocked', () => {
  const html = render('[Run it](javascript:alert(1))');
  assertContains(
    html,
    '<a href="#" target="_blank" rel="noopener noreferrer">Run it</a>',
    'javascript: links should be rewritten to a safe placeholder'
  );
});

test('protocol-relative links are blocked', () => {
  const html = render('[External](//evil.example/path)');
  assertContains(
    html,
    '<a href="#" target="_blank" rel="noopener noreferrer">External</a>',
    'protocol-relative links should not be treated as safe relative paths'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
